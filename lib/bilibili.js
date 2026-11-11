/**
 * lib/bilibili.js —— B站只读采集 + 待审队列
 *
 * 【铁律（写在最前面，改代码前先读一遍）】
 *   1. 只读：本模块**绝不登录、绝不发帖、绝不点赞/评论/投币**，
 *      也不提供任何写操作的封装（没有 cookie、没有 csrf、没有 POST）。
 *   2. 只产出「待审草稿」：发不发、怎么发，永远由用户手动完成，插件不参与。
 *   3. `draft` 必须以「（AI 生成）」开头 —— 这是《人工智能生成合成内容标识办法》
 *      要求的显式标识，不是文案偏好，别为了好看把它删掉。
 *
 * 设计依据：docs/proactive-assistant.md 第 3 节（实现以它为准）。
 * 依赖：只用 node:fs / node:path / node:crypto，网络用全局 fetch（Node 18+），
 *       `fetchImpl` 可注入，测试里一个真实请求都不发。
 * 容错：任何网络/IO 异常都降级成 {ok:false, reason}，**绝不抛**（采集层不能把宿主拖崩）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 合规标识：所有草稿的第一个字符必须是它 */
export const AI_MARK = '（AI 生成）'

const POPULAR_URL = 'https://api.bilibili.com/x/web-interface/popular'
const REPLY_URL = 'https://api.bilibili.com/x/v2/reply'

/** 常见浏览器的 UA；用默认的 node/undici UA 会被 B 站直接风控 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 请求头：Referer 是必须的，缺了会拿到 -412 */
const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
}

const TIMEOUT_MS = 10_000
/** 模块级限速：1 秒最多 1 个请求 */
const MIN_INTERVAL_MS = 1000
/** 412/429 之后的退避时长：5 分钟 */
const BACKOFF_MS = 5 * 60 * 1000
/** 这些业务 code 也代表被风控/限流，同样走退避 */
const BLOCK_CODES = new Set([-412, -509, -799])

const MAX_QUEUE = 500
const STATUSES = ['draft', 'approved', 'rejected', 'posted']
/** 状态机：draft → approved → posted，或 draft → rejected。没有自动流转。 */
const TRANSITIONS = {
  draft: ['approved', 'rejected'],
  approved: ['posted'],
  rejected: [],
  posted: []
}

/* ============================== 限速与请求 ============================== */

let lastRequestAt = 0
let blockedUntil = 0
/** 把并发请求串起来，避免两个调用同时穿过限速窗口 */
let chain = Promise.resolve()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 重置限速/退避状态。
 * 只给测试和诊断用——生产里没有理由调它，调用会立刻解除风控保护。
 */
export function resetThrottle() {
  lastRequestAt = 0
  blockedUntil = 0
}

/** 当前限速状态，方便上层展示「正在退避，还有多久」 */
export function throttleStatus(now = Date.now()) {
  return {
    blocked: now < blockedUntil,
    blockedUntil: blockedUntil || null,
    waitMs: Math.max(0, blockedUntil - now),
    lastRequestAt: lastRequestAt || null
  }
}

function warn(logger, message) {
  try {
    logger?.warn?.(`[bilibili] ${message}`)
  } catch {
    /* 日志本身失败不能影响主流程 */
  }
}

/**
 * 串行执行一个请求任务。
 * 结论：即使并发调用，也不会出现「同一毫秒两个请求」。
 */
function schedule(task) {
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * 真正发一次请求。**不抛**，统一返回 {ok:true,data} / {ok:false,reason}。
 * 注意：调用方必须已经进入了 schedule()，限速窗口在这里消耗。
 */
async function requestJson(url, fetchImpl, logger) {
  const now = Date.now()
  if (now < blockedUntil) {
    return { ok: false, reason: '退避中', blocked: true, waitMs: blockedUntil - now }
  }

  // 等够 1 秒窗口再放行；等完再看一眼，别在等待期间被别人按下了退避
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now()
  if (wait > 0) await sleep(wait)
  if (Date.now() < blockedUntil) {
    return { ok: false, reason: '退避中', blocked: true, waitMs: blockedUntil - Date.now() }
  }

  const impl = fetchImpl ?? globalThis.fetch
  if (typeof impl !== 'function') {
    return { ok: false, reason: '当前 Node 没有可用的 fetch（需要 Node 18+）' }
  }

  lastRequestAt = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)

  try {
    const res = await impl(url, { headers: { ...HEADERS }, signal: ac.signal })
    const status = Number(res?.status) || 0
    if (status === 412 || status === 429) {
      blockedUntil = Date.now() + BACKOFF_MS
      warn(logger, `HTTP ${status}，进入 ${BACKOFF_MS / 60000} 分钟退避`)
      return { ok: false, reason: `B站返回 HTTP ${status}，已进入 5 分钟退避`, blocked: true }
    }
    if (status < 200 || status >= 300) {
      return { ok: false, reason: `B站返回 HTTP ${status || '未知'}` }
    }

    let body
    try {
      body = await res.json()
    } catch {
      return { ok: false, reason: '响应不是合法 JSON' }
    }

    if (!body || typeof body !== 'object') {
      return { ok: false, reason: '响应体为空' }
    }

    const code = Number(body.code)
    if (code !== 0) {
      if (BLOCK_CODES.has(code)) {
        blockedUntil = Date.now() + BACKOFF_MS
        warn(logger, `业务 code=${code}，进入 ${BACKOFF_MS / 60000} 分钟退避`)
        return {
          ok: false,
          reason: `B站返回 code=${code}（${body.message || body.msg || '风控/限流'}），已进入 5 分钟退避`,
          blocked: true
        }
      }
      return { ok: false, reason: `B站返回 code=${code}（${body.message || body.msg || '未知错误'}）` }
    }

    return { ok: true, data: body.data }
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      return { ok: false, reason: `请求超时（${TIMEOUT_MS / 1000} 秒）` }
    }
    return { ok: false, reason: `网络错误：${error?.message ?? error}` }
  } finally {
    clearTimeout(timer)
  }
}

/* ============================== 采集 ============================== */

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function text(value, max = 500) {
  const s = String(value ?? '').trim()
  return s.length > max ? s.slice(0, max) : s
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 热门视频列表（公开接口，无需登录）。
 * @param {{limit?:number, pn?:number, fetchImpl?:Function, logger?:object}} [options]
 * @returns {Promise<{ok:true, videos:Array}|{ok:false, reason:string}>}
 */
export async function fetchPopular(options = {}) {
  const limit = clampInt(options.limit ?? 20, 1, 50, 20)
  const pn = clampInt(options.pn ?? 1, 1, 1000, 1)
  const url = `${POPULAR_URL}?ps=${limit}&pn=${pn}`
  warn(options.logger, `拉取热门视频 ps=${limit} pn=${pn}`)

  const result = await schedule(() => requestJson(url, options.fetchImpl, options.logger))
  if (!result.ok) return { ok: false, reason: result.reason }

  const list = Array.isArray(result.data?.list) ? result.data.list : []
  const videos = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const bvid = text(item.bvid, 32)
    const aid = toNumber(item.aid)
    videos.push({
      bvid,
      aid,
      title: text(item.title),
      owner: text(item.owner?.name, 100),
      desc: text(item.desc, 500),
      // bvid 优先；极旧的稿件没有 bvid 时退回 av 号
      url: bvid
        ? `https://www.bilibili.com/video/${bvid}`
        : aid > 0
          ? `https://www.bilibili.com/video/av${aid}`
          : '',
      play: toNumber(item.stat?.view),
      like: toNumber(item.stat?.like),
      pubdate: toNumber(item.pubdate)
    })
  }
  return { ok: true, videos }
}

/**
 * 某条视频（aid）下的评论。只读公开评论，不需要登录。
 * @param {{oid:number, pn?:number, limit?:number, fetchImpl?:Function, logger?:object}} options
 *        oid 就是 aid（接口 type=1 表示视频）
 * @returns {Promise<{ok:true, comments:Array}|{ok:false, reason:string}>}
 */
export async function fetchComments(options = {}) {
  const oid = Math.trunc(Number(options.oid))
  if (!Number.isFinite(oid) || oid <= 0) {
    return { ok: false, reason: '缺少 oid（视频 aid）' }
  }
  const limit = clampInt(options.limit ?? 20, 1, 50, 20)
  const pn = clampInt(options.pn ?? 1, 1, 1000, 1)
  const url = `${REPLY_URL}?type=1&oid=${oid}&pn=${pn}&ps=${limit}`
  warn(options.logger, `拉取评论 oid=${oid} pn=${pn}`)

  const result = await schedule(() => requestJson(url, options.fetchImpl, options.logger))
  if (!result.ok) return { ok: false, reason: result.reason }

  // replies 在「无评论」「评论关闭」时是 null，不能直接 .map
  const raw = Array.isArray(result.data?.replies) ? result.data.replies : []
  const comments = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rpid = toNumber(item.rpid)
    if (rpid <= 0) continue
    comments.push({
      rpid,
      user: text(item.member?.uname, 100) || '匿名用户',
      message: text(item.content?.message, 1000),
      like: toNumber(item.like),
      ctime: toNumber(item.ctime)
    })
  }
  return { ok: true, comments }
}

/* ============================== 待审队列 ============================== */

function sha1(input) {
  return createHash('sha1').update(String(input ?? ''), 'utf8').digest('hex')
}

/** 去重键 = url + '|' + sha1(draft) */
function dedupeKey(url, draft) {
  return `${url}|${sha1(draft)}`
}

function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value
}

function renderItemMarkdown(item, index) {
  const lines = [
    `### ${index + 1}. ${item.title || '（无标题）'}`,
    `- id：\`${item.id}\``,
    `- 类型：${item.kind}`,
    `- 链接：${item.url}`,
    `- 草稿：${item.draft}`,
    `- 理由：${item.why || '（无）'}`
  ]
  return lines.join('\n')
}

/**
 * 打开待审队列。
 * 存储：`<dir>/review/queue.json`（dir 不存在会自动创建；原子写：tmp + rename）。
 * 没传 dir 时退化成纯内存队列（日志里提示一句），不会抛。
 *
 * @param {{dir?:string, logger?:object}} [options]
 */
export function openReview(options = {}) {
  const dir = options.dir ? String(options.dir) : ''
  const logger = options.logger
  const reviewDir = dir ? path.join(dir, 'review') : ''
  const queueFile = reviewDir ? path.join(reviewDir, 'queue.json') : ''

  /** 内存里的队列：{id, kind, url, title, draft, why, meta, status, createdAt, updatedAt}[] */
  let items = []
  let loadError = null

  function load() {
    items = []
    loadError = null
    if (!queueFile || !existsSync(queueFile)) return
    try {
      const raw = readFileSync(queueFile, 'utf8')
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
      items = list
        .filter((it) => it && typeof it === 'object' && it.id != null)
        .map((it) => ({
          ...it,
          id: String(it.id),
          status: STATUSES.includes(it.status) ? it.status : 'draft'
        }))
    } catch (error) {
      // 坏文件不能让它崩，也不能被下一笔写入悄悄盖掉：留个备份
      loadError = String(error?.message ?? error)
      warn(logger, `队列文件读取失败（${loadError}），本次以空队列开始`)
      try {
        const bad = `${queueFile}.corrupt-${Date.now()}`
        renameSync(queueFile, bad)
        warn(logger, `已把坏文件改名保存为 ${path.basename(bad)}`)
      } catch {
        /* 备份失败也只能继续 */
      }
    }
  }

  /** 原子写：先写 tmp 再 rename；失败只 warn，绝不抛 */
  function save() {
    if (!queueFile) return false
    const tmp = `${queueFile}.tmp-${process.pid}-${Date.now()}`
    try {
      mkdirSync(reviewDir, { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), items }, null, 2), 'utf8')
      renameSync(tmp, queueFile)
      return true
    } catch (error) {
      warn(logger, `队列写入失败：${error?.message ?? error}`)
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 清不掉临时文件也无所谓 */
      }
      return false
    }
  }

  /** 超过上限时：先丢最旧的 posted/rejected，还不够就丢最旧的任意条目 */
  function prune() {
    let removed = 0
    while (items.length > MAX_QUEUE) {
      let index = -1
      let oldest = Infinity
      items.forEach((it, i) => {
        if (it.status !== 'posted' && it.status !== 'rejected') return
        const t = Number(it.updatedAt ?? it.createdAt) || 0
        if (t < oldest) {
          oldest = t
          index = i
        }
      })
      if (index < 0) {
        // 全都还是 draft/approved，只能从最旧的开始丢
        items.forEach((it, i) => {
          const t = Number(it.createdAt) || 0
          if (t < oldest) {
            oldest = t
            index = i
          }
        })
      }
      if (index < 0) index = 0
      items.splice(index, 1)
      removed++
    }
    return removed
  }

  function nextId() {
    let max = 0
    for (const it of items) {
      const n = Number(it.id)
      if (Number.isFinite(n) && n > max) max = n
    }
    return String(max + 1)
  }

  function findIndex(id) {
    const key = String(id)
    return items.findIndex((it) => it.id === key)
  }

  load()

  const api = {
    /**
     * 入队一条候选。重复（url + sha1(draft) 相同）返回 {added:false}。
     * draft 没带「（AI 生成）」时这里补上——合规标识不能靠调用方自觉。
     */
    enqueue(item = {}) {
      const kind = item.kind === 'recommend' ? 'recommend' : 'reply'
      const url = text(item.url, 2000)
      if (!/^https?:\/\//i.test(url)) {
        return { added: false, reason: 'url 不是合法的 http(s) 地址' }
      }
      let draft = text(item.draft, 4000)
      if (!draft) return { added: false, reason: 'draft 不能为空' }
      if (!draft.startsWith(AI_MARK)) draft = `${AI_MARK}${draft}`

      const key = dedupeKey(url, draft)
      // 不依赖存量条目里的 key 字段：老文件/手工改过的文件也照样能去重
      if (items.some((it) => dedupeKey(it.url, it.draft) === key)) {
        return { added: false, reason: '重复候选（url + 草稿相同）' }
      }

      const now = Date.now()
      const record = {
        id: nextId(),
        kind,
        url,
        title: text(item.title, 300),
        draft,
        why: text(item.why, 500),
        meta: item.meta && typeof item.meta === 'object' ? clone(item.meta) : null,
        key,
        status: 'draft',
        createdAt: now,
        updatedAt: now
      }
      items.push(record)
      const pruned = prune()
      const persisted = save()
      return { added: true, id: record.id, pruned, persisted }
    },

    /**
     * 列出队列。status='all' 时列全部；默认只列待审草稿。
     * 按入队时间升序（先来先审）。
     */
    list(options = {}) {
      const status = options.status ?? 'draft'
      const limit = clampInt(options.limit ?? 20, 1, MAX_QUEUE, 20)
      const filtered =
        status === 'all' ? items.slice() : items.filter((it) => it.status === status)
      filtered.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
      return filtered.slice(0, limit).map(clone)
    },

    /** 按 id 取一条；没有返回 null */
    get(id) {
      const index = findIndex(id)
      return index < 0 ? null : clone(items[index])
    },

    /**
     * 状态流转。非法流转（如 rejected → approved、draft → posted）返回 false。
     * 只做状态标记，**不发布任何东西**。
     */
    setStatus(id, status) {
      if (!STATUSES.includes(status)) return false
      const index = findIndex(id)
      if (index < 0) return false
      const current = items[index].status
      if (!TRANSITIONS[current]?.includes(status)) return false
      items[index].status = status
      items[index].updatedAt = Date.now()
      save()
      return true
    },

    /** 给用户看的审核清单；不传 items 就渲染当前所有 draft */
    renderMarkdown(list) {
      const source = Array.isArray(list) ? list : api.list({ status: 'draft', limit: MAX_QUEUE })
      const head = [
        `## B站待审清单（共 ${source.length} 条）`,
        '',
        '> 以下草稿由规则生成、带「（AI 生成）」标识；插件不会自动发布，也不会替你操作账号。'
      ]
      if (source.length === 0) {
        return `${head.join('\n')}\n\n（暂时没有待审内容呢……）\n\n回复 \`approve <id>\` 同意 / \`reject <id>\` 拒绝；发布请手动完成。`
      }
      const body = source.map((item, i) => renderItemMarkdown(item, i)).join('\n\n')
      return `${head.join('\n')}\n\n${body}\n\n---\n回复 \`approve <id>\` 同意 / \`reject <id>\` 拒绝；发布请手动完成。`
    },

    /** 队列概况 */
    stats() {
      const byStatus = { draft: 0, approved: 0, rejected: 0, posted: 0 }
      for (const it of items) {
        if (byStatus[it.status] != null) byStatus[it.status]++
      }
      return {
        total: items.length,
        byStatus,
        capacity: MAX_QUEUE,
        file: queueFile || null,
        persisted: Boolean(queueFile),
        loadError
      }
    },

    /** 内部用：测试里想确认磁盘上那份就是内存这份 */
    file: queueFile || null
  }

  return api
}

/* ============================== 草稿生成 ============================== */

function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 按评论内容挑一个固定的结尾——同样的输入永远得到同样的草稿，方便去重 */
function replyTail(seed) {
  const tails = [
    '想听听你后来是怎么想的呢。',
    '这一句我先记下啦。',
    '不过每个人都有自己的答案吧？',
    '这样说起来，好像也有点道理呢。'
  ]
  const byte = parseInt(sha1(seed).slice(0, 2), 16)
  return tails[byte % tails.length]
}

function formatCount(n) {
  const v = Number(n) || 0
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)} 亿`
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)} 万`
  return String(v)
}

/**
 * 纯规则生成一条待审候选（不调模型）。
 *
 * draft 强制以「（AI 生成）」开头：这是《人工智能生成合成内容标识办法》的显式标识要求，
 * 用户手动发布时也带着它，避免被当成真人发言。
 *
 * @param {{video?:object, comment?:object, profile?:object}} input
 * @returns {{kind:'reply'|'recommend', url:string, title:string, draft:string, why:string}}
 */
export function buildCandidate(input = {}) {
  const video = input.video && typeof input.video === 'object' ? input.video : {}
  const comment = input.comment && typeof input.comment === 'object' ? input.comment : null
  const profile = input.profile && typeof input.profile === 'object' ? input.profile : {}

  const bvid = text(video.bvid, 32)
  const aid = toNumber(video.aid)
  const fallbackUrl = bvid
    ? `https://www.bilibili.com/video/${bvid}`
    : aid > 0
      ? `https://www.bilibili.com/video/av${aid}`
      : ''
  const url = text(comment?.url ?? video.url, 2000) || fallbackUrl
  const title = text(comment?.title ?? video.title, 300) || '未命名视频'

  if (comment) {
    const message = clip(comment.message, 60) || '……'
    const nickname = text(comment.user, 30)
    const who = nickname ? `@${nickname}` : '你'
    const draft = `${AI_MARK}${who}说的「${message}」，我也有同感呢。${replyTail(message)}`
    const interest = Array.isArray(profile.interests) && profile.interests.length
      ? `，也贴合「${clip(profile.interests[0], 20)}」这个话题`
      : ''
    const why = `评论里有可以接的话头（${toNumber(comment.like)} 赞）${interest}，回一句能让对话续下去`
    return { kind: 'reply', url, title, draft, why }
  }

  const play = toNumber(video.play)
  const like = toNumber(video.like)
  const hint = play >= 1_000_000 ? '热度很高' : play > 0 ? '播放量还不错' : '看着挺有意思'
  const draft = `${AI_MARK}在 B 站看到《${clip(title, 40)}》，${hint}（${formatCount(play)}播放 / ${formatCount(like)}赞），想推荐给你看看呢。`
  const interest = Array.isArray(profile.interests) && profile.interests.length
    ? `，正好是「${clip(profile.interests[0], 20)}」相关`
    : ''
  const why = `视频《${clip(title, 30)}》${formatCount(play)}播放${interest}，适合放进这次推荐`
  return { kind: 'recommend', url, title, draft, why }
}
