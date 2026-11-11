/**
 * bilibili 模块自检：**全程用 stub fetch，一个真实请求都不发**。
 *
 * 覆盖（对应任务清单 1~7）：
 *   1. 成功响应 → 视频/评论字段解析正确，URL 与请求头符合约定；
 *   2. 业务 code 非 0（-412）→ {ok:false}，并进入 5 分钟退避；
 *   3. fetch 抛网络错 → {ok:false}，不崩；
 *   4. 连续两次请求会被 1 秒限速（第二次等够窗口才发）；
 *   5. 队列：enqueue → list → 去重 → 非法流转 false → 合法流转 true → 重开仍在 → 500 上限；
 *   6. buildCandidate 的 draft 以「（AI 生成）」开头；
 *   7. renderMarkdown 含 id 和操作说明。
 *
 * 跑法：node test/bilibili-smoke.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AI_MARK,
  buildCandidate,
  fetchComments,
  fetchPopular,
  openReview,
  resetThrottle,
  throttleStatus
} from '../lib/bilibili.js'

const problems = []
const tmpDirs = []

function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

function tmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bili-smoke-'))
  tmpDirs.push(dir)
  return dir
}

/** 最小 Response 替身：模块只用到 ok / status / json() */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const VIDEO = {
  bvid: 'BV1xx411c7mD',
  aid: 170001,
  title: '测试视频',
  owner: { name: 'UP主' },
  desc: '视频简介',
  stat: { view: 12345, like: 678 },
  pubdate: 1700000000
}

try {
  /* ---------------- 1. 成功响应解析 ---------------- */
  console.log('\n[1] fetchPopular 成功响应')
  resetThrottle()
  let seenUrl = ''
  let seenInit = null
  const okRes = await fetchPopular({
    limit: 3,
    fetchImpl: async (url, init) => {
      seenUrl = url
      seenInit = init
      return jsonResponse({ code: 0, data: { list: [VIDEO] } })
    }
  })
  check('返回 ok', okRes.ok === true, JSON.stringify(okRes))
  check('URL 带 ps/pn', seenUrl.includes('ps=3') && seenUrl.includes('pn=1'), seenUrl)
  check('URL 命中热门接口', seenUrl.startsWith('https://api.bilibili.com/x/web-interface/popular?'))
  check('Referer 正确', seenInit?.headers?.Referer === 'https://www.bilibili.com')
  check('UA 是浏览器 UA', /Mozilla\/5\.0/.test(String(seenInit?.headers?.['User-Agent'])))
  check('带 AbortSignal', seenInit?.signal instanceof AbortSignal)

  const v = okRes.videos?.[0] ?? {}
  check('bvid 解析', v.bvid === 'BV1xx411c7mD', v.bvid)
  check('aid 解析', v.aid === 170001, String(v.aid))
  check('title 解析', v.title === '测试视频', v.title)
  check('owner 解析', v.owner === 'UP主', v.owner)
  check('desc 解析', v.desc === '视频简介', v.desc)
  check('url 拼装', v.url === 'https://www.bilibili.com/video/BV1xx411c7mD', v.url)
  check('play/like/pubdate 解析', v.play === 12345 && v.like === 678 && v.pubdate === 1700000000)

  console.log('\n[1b] fetchComments 成功响应')
  resetThrottle()
  let replyUrl = ''
  const okComments = await fetchComments({
    oid: 170001,
    limit: 2,
    fetchImpl: async (url) => {
      replyUrl = url
      return jsonResponse({
        code: 0,
        data: {
          replies: [
            { rpid: 9001, member: { uname: '路人甲' }, content: { message: '说得好' }, like: 7, ctime: 1700000100 }
          ]
        }
      })
    }
  })
  check('评论接口 ok', okComments.ok === true, JSON.stringify(okComments))
  check('评论 URL 带 type/oid/ps', /type=1/.test(replyUrl) && /oid=170001/.test(replyUrl) && /ps=2/.test(replyUrl), replyUrl)
  const c = okComments.comments?.[0] ?? {}
  check('评论字段解析', c.rpid === 9001 && c.user === '路人甲' && c.message === '说得好' && c.like === 7 && c.ctime === 1700000100, JSON.stringify(c))

  const badOid = await fetchComments({ oid: 0, fetchImpl: async () => jsonResponse({ code: 0, data: {} }) })
  check('oid 缺失直接失败且不发请求', badOid.ok === false && String(badOid.reason).includes('oid'), JSON.stringify(badOid))

  /* ---------------- 2. code !== 0 ---------------- */
  console.log('\n[2] code=-412')
  resetThrottle()
  let calls2 = 0
  const blocked = await fetchPopular({
    fetchImpl: async () => {
      calls2++
      return jsonResponse({ code: -412, message: '请求被拦截' })
    }
  })
  check('code!==0 → ok:false', blocked.ok === false, JSON.stringify(blocked))
  check('reason 带 -412', String(blocked.reason).includes('-412'), blocked.reason)
  check('已进入退避', throttleStatus().blocked === true)

  const beforeBlockedCall = calls2
  const duringBackoff = await fetchPopular({
    fetchImpl: async () => {
      calls2++
      return jsonResponse({ code: 0, data: { list: [] } })
    }
  })
  check('退避期内不发请求', calls2 === beforeBlockedCall, `calls=${calls2}`)
  check('退避期返回 ok:false 且说明原因', duringBackoff.ok === false && String(duringBackoff.reason).includes('退避中'), JSON.stringify(duringBackoff))

  resetThrottle()
  const http429 = await fetchPopular({ fetchImpl: async () => jsonResponse({}, 429) })
  check('HTTP 429 也进入退避', http429.ok === false && throttleStatus().blocked === true, JSON.stringify(http429))
  resetThrottle()

  /* ---------------- 3. 网络异常 ---------------- */
  console.log('\n[3] fetch 抛网络错')
  resetThrottle()
  let threw = false
  let netErr
  try {
    netErr = await fetchPopular({
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      }
    })
  } catch {
    threw = true
  }
  check('不向上抛异常', threw === false)
  check('网络错 → ok:false', netErr?.ok === false, JSON.stringify(netErr))
  check('reason 说明是网络错误', String(netErr?.reason).includes('网络错误'), netErr?.reason)

  /* ---------------- 4. 限速 ---------------- */
  console.log('\n[4] 1 秒限速')
  resetThrottle()
  let calls4 = 0
  const stub4 = async () => {
    calls4++
    return jsonResponse({ code: 0, data: { list: [] } })
  }
  const t0 = Date.now()
  const first4 = await fetchPopular({ fetchImpl: stub4 })
  const second4 = await fetchPopular({ fetchImpl: stub4 })
  const elapsed = Date.now() - t0
  check('两次请求都成功', first4.ok === true && second4.ok === true, `${JSON.stringify(first4)} / ${JSON.stringify(second4)}`)
  check('两次都真的发了', calls4 === 2, `calls=${calls4}`)
  check('第二次等够了 1 秒窗口', elapsed >= 900, `elapsed=${elapsed}ms`)
  check('等待没有离谱地长', elapsed < 5000, `elapsed=${elapsed}ms`)

  /* ---------------- 5. 待审队列 ---------------- */
  console.log('\n[5] 待审队列')
  const stateDir = path.join(tmpDir(), 'nested', 'state')
  const review = openReview({ dir: stateDir })
  const urlA = 'https://www.bilibili.com/video/BV1xx411c7mD'

  const a1 = review.enqueue({ kind: 'reply', url: urlA, title: '视频A', draft: '（AI 生成）草稿一', why: '理由一' })
  check('enqueue 成功', a1.added === true && Boolean(a1.id), JSON.stringify(a1))
  const a2 = review.enqueue({ kind: 'recommend', url: urlA, title: '视频A', draft: '（AI 生成）草稿二', why: '理由二' })
  check('同 url 不同草稿可入队', a2.added === true, JSON.stringify(a2))
  const dup = review.enqueue({ kind: 'reply', url: urlA, title: '视频A（标题变了也不影响去重）', draft: '（AI 生成）草稿一', why: '重复' })
  check('url+草稿重复 → added:false', dup.added === false, JSON.stringify(dup))
  const badUrl = review.enqueue({ kind: 'reply', url: 'not-a-url', draft: '（AI 生成）x' })
  check('非法 url 被拒', badUrl.added === false, JSON.stringify(badUrl))

  const draftList = review.list()
  check('list 默认只给 draft', draftList.length === 2 && draftList.every((it) => it.status === 'draft'), `len=${draftList.length}`)
  check('list 按入队顺序', draftList[0].id === a1.id && draftList[1].id === a2.id)

  check('非法流转 draft→posted 返回 false', review.setStatus(a1.id, 'posted') === false)
  check('非法流转 approved→rejected 返回 false', review.setStatus(a1.id, 'approved') === true && review.setStatus(a1.id, 'rejected') === false)
  check('非法流转 rejected→approved 返回 false', review.setStatus(a2.id, 'rejected') === true && review.setStatus(a2.id, 'approved') === false)
  check('不存在的 id 返回 false', review.setStatus('99999', 'approved') === false)
  check('非法状态名返回 false', review.setStatus(a1.id, 'archived') === false)
  check('合法流转 approved→posted', review.setStatus(a1.id, 'posted') === true)
  check('状态已生效', review.get(a1.id)?.status === 'posted' && review.get(a2.id)?.status === 'rejected')

  const queueFile = path.join(stateDir, 'review', 'queue.json')
  check('队列文件已落盘', existsSync(queueFile), queueFile)
  const rawQueue = JSON.parse(readFileSync(queueFile, 'utf8'))
  check('落盘结构可解析', Array.isArray(rawQueue.items) && rawQueue.items.length === 2, `items=${rawQueue.items?.length}`)
  const leftovers = readdirSync(path.join(stateDir, 'review')).filter((n) => n.includes('.tmp-'))
  check('没有 tmp 残留（原子写完成）', leftovers.length === 0, leftovers.join(','))

  const review2 = openReview({ dir: stateDir })
  check('重新 open 数据还在', review2.stats().total === 2)
  check('重新 open 状态保留', review2.get(a1.id)?.status === 'posted' && review2.get(a2.id)?.status === 'rejected')
  check('draft 列表已空', review2.list({ status: 'draft' }).length === 0)

  console.log('\n[5b] 500 上限：先丢最旧的 posted')
  const capDir = path.join(tmpDir(), 'cap')
  const capQueueDir = path.join(capDir, 'review')
  mkdirSync(capQueueDir, { recursive: true })
  const oldItems = Array.from({ length: 500 }, (_, i) => ({
    id: String(i + 1),
    kind: 'recommend',
    url: `https://www.bilibili.com/video/BVold${i + 1}`,
    title: `旧视频 ${i + 1}`,
    draft: `（AI 生成）旧草稿 ${i + 1}`,
    why: '',
    meta: null,
    status: i === 0 ? 'posted' : 'draft',
    createdAt: 1000 + i,
    updatedAt: 1000 + i
  }))
  writeFileSync(path.join(capQueueDir, 'queue.json'), JSON.stringify({ version: 1, items: oldItems }), 'utf8')
  const capReview = openReview({ dir: capDir })
  const capAdded = capReview.enqueue({
    kind: 'recommend',
    url: 'https://www.bilibili.com/video/BVnew',
    title: '新视频',
    draft: '（AI 生成）新草稿',
    why: '新'
  })
  check('入队成功', capAdded.added === true, JSON.stringify(capAdded))
  check('总数仍是 500', capReview.stats().total === 500, String(capReview.stats().total))
  check('最旧的 posted 被丢', capReview.get('1') === null)
  check('新条目保留', Boolean(capReview.get(capAdded.id)))

  /* ---------------- 6. buildCandidate ---------------- */
  console.log('\n[6] buildCandidate')
  const reply = buildCandidate({
    video: { bvid: VIDEO.bvid, aid: VIDEO.aid, title: VIDEO.title, url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    comment: { rpid: 1, user: '路人甲', message: '这期讲得真不错', like: 5 },
    profile: { interests: ['崩坏3'] }
  })
  check('评论 → kind=reply', reply.kind === 'reply', reply.kind)
  check('reply draft 以 AI 标识开头', reply.draft.startsWith(AI_MARK), reply.draft)
  check('reply 带 url', reply.url === 'https://www.bilibili.com/video/BV1xx411c7mD', reply.url)
  check('reply 带理由', typeof reply.why === 'string' && reply.why.length > 0, reply.why)

  const rec = buildCandidate({
    video: { bvid: VIDEO.bvid, aid: VIDEO.aid, title: VIDEO.title, url: 'https://www.bilibili.com/video/BV1xx411c7mD', play: 123456, like: 789 },
    profile: { interests: ['崩坏3'] }
  })
  check('无评论 → kind=recommend', rec.kind === 'recommend', rec.kind)
  check('recommend draft 以 AI 标识开头', rec.draft.startsWith(AI_MARK), rec.draft)
  check('recommend 标题在草稿里', rec.draft.includes('测试视频'), rec.draft)
  check('recommend 带 url', Boolean(rec.url), rec.url)

  const bare = buildCandidate({})
  check('空输入也不崩', typeof bare.draft === 'string' && bare.draft.startsWith(AI_MARK), JSON.stringify(bare))

  /* ---------------- 7. renderMarkdown ---------------- */
  console.log('\n[7] renderMarkdown')
  const md = review2.renderMarkdown(review2.list({ status: 'all' }))
  check('含 id', md.includes(a1.id) && md.includes(a2.id), md.slice(0, 120))
  check('含类型', md.includes('reply') || md.includes('recommend'))
  check('含标题', md.includes('视频A'))
  check('含链接', md.includes(urlA))
  check('含草稿', md.includes('（AI 生成）草稿一'))
  check('含理由', md.includes('理由一') && md.includes('理由二'))
  check('含 approve 说明', md.includes('approve <id>'), md.slice(-120))
  check('含 reject 说明', md.includes('reject <id>'), md.slice(-120))
  check('含手动发布提示', md.includes('发布请手动完成'), md.slice(-120))
  check('空清单也有操作说明', review2.renderMarkdown([]).includes('approve <id>'))
} finally {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

console.log('')
if (problems.length) {
  console.log(`FAILED：${problems.length} 项未通过 -> ${problems.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('ALL PASS：bilibili 模块自检全部通过')
}
