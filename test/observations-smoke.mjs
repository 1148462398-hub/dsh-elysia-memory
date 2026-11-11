/**
 * 观测库自检：写入 → 查询 → 时间线 → 每日汇总 → 清理 → 清空 → 重开。
 *
 * 重点覆盖三件「做不到就会静默出事」的事：
 *   · 目录不存在 / 不可写时不能抛（感知层不能因为存不了就崩）；
 *   · FTS5 缺失时必须能退化成 LIKE（否则关键字搜索整块功能消失）；
 *   · 反复打开同一个库不能报错（插件每次启动都会开一次）。
 *
 * 全程在临时目录里跑，结束一定删干净。
 * 用法：node test/observations-smoke.mjs
 */
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// node:sqlite 是 Node 22.5+ 才有的实验模块；没有它就没什么可测的，如实跳过而不是假装通过
try {
  await import('node:sqlite')
} catch {
  console.log('skip: node:sqlite 不可用')
  process.exit(0)
}

const { openObservations } = await import('../lib/observations.js')

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

const DAY = 86_400_000
const HOUR = 3_600_000
const RAW_KINDS = ['cpu', 'mem', 'disk']
const KINDS = ['cpu', 'mem', 'disk', 'event', 'window']

/** 和 SQLite 的 'localtime' 对齐的本地日期键（同一台机器同一个时区，两边必须一致） */
function dayKey(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const root = path.join(os.tmpdir(), `elysia-obs-${Date.now()}-${process.pid}`)

// 5000 条、跨 30 天：量级接近「10 秒采一次 + 48 小时保留」的真实表，够撑出分页与聚合的边界
const now = Date.now()
const start = now - 30 * DAY + 60_000
const span = 30 * DAY - 120_000
const rows = []
for (let i = 0; i < 5000; i++) {
  const ts = Math.round(start + (span * i) / 4999)
  const kind = KINDS[i % KINDS.length]
  rows.push({
    ts,
    kind,
    level: i % 17 === 0 ? 'warn' : 'info',
    summary: i % 500 === 0 ? `第 ${i} 条：磁盘告警，剩余空间不足` : `第 ${i} 条：常规采样 ${kind}`,
    detail: { i, kind }
  })
}

let obs = null

async function main() {
  console.log('1) 目录不存在时 open 自动创建（多级目录）')
  const dirA = path.join(root, 'deep', 'nested', 'observations')
  check('打开前目录不存在', !existsSync(dirA))
  obs = openObservations({ dir: dirA, logger: { warn() {} } })
  check('目录被自动建出来', existsSync(dirA))
  check('库文件落在 dir 下面', existsSync(path.join(dirA, 'obs.db')))
  check('daily 目录也备好了', existsSync(path.join(dirA, 'daily')))
  check('空库 stats 是 0 行', obs.stats().rows === 0)

  console.log('2) append 一次性写入 5000 条（一个事务）')
  const added = obs.append(rows)
  check('返回写入条数 = 5000', added === 5000, String(added))
  check('脏数据被丢掉（缺 summary）', obs.append([{ ts: now, kind: 'cpu' }]) === 0)
  check('空数组返回 0', obs.append([]) === 0)
  const s0 = obs.stats()
  check('库里有 5000 行', s0.rows === 5000, String(s0.rows))
  check('firstTs 是最早那条', s0.firstTs === rows[0].ts, `${s0.firstTs} vs ${rows[0].ts}`)
  check('lastTs 是最新那条', s0.lastTs === rows[rows.length - 1].ts, `${s0.lastTs}`)
  check('bytes 大于 0', s0.bytes > 0, String(s0.bytes))
  check('fts 是布尔值', typeof s0.fts === 'boolean', String(s0.fts))
  check('这台机器上 FTS5 可用', s0.fts === true)

  console.log('3) query：默认 limit=200、最大 1000、时间窗、kind、level、keyword')
  const def = obs.query({})
  check('默认返回 200 条', def.length === 200, String(def.length))
  check('默认按时间倒序（最新在前）', def[0].ts === rows[rows.length - 1].ts, String(def[0].ts))
  check('detail 读回来还是对象', def[0].detail && typeof def[0].detail === 'object')
  check('limit 被夹到 1000', obs.query({ limit: 99999 }).length === 1000, String(obs.query({ limit: 99999 }).length))
  check('limit 为 0 时回落到默认值', obs.query({ limit: 0 }).length === 200)

  const winFrom = start
  const winTo = start + 5 * DAY
  const inWindow = rows.filter((r) => r.ts >= winFrom && r.ts <= winTo)
  // 5 天 ≈ 834 条，仍在 1000 的上限内，所以这里能要求「一条不少」
  const winRows = obs.query({ from: winFrom, to: winTo, limit: 1000 })
  check('时间窗内条数正确', winRows.length === inWindow.length, `${winRows.length} vs ${inWindow.length}`)
  check(
    '时间窗内的时间戳完全一致',
    JSON.stringify(winRows.map((r) => r.ts)) ===
      JSON.stringify(inWindow.map((r) => r.ts).sort((a, b) => b - a))
  )
  check(
    '时间窗之外查不到',
    obs.query({ from: rows[0].ts - HOUR, to: rows[0].ts - 1 }).length === 0
  )

  const cpus = obs.query({ kinds: ['cpu'], limit: 1000 })
  check('kind 过滤只回 cpu', cpus.length === 1000 && cpus.every((r) => r.kind === 'cpu'))
  check(
    '多 kind 过滤生效',
    obs.query({ kinds: ['cpu', 'event'], limit: 1000 }).every((r) => r.kind === 'cpu' || r.kind === 'event')
  )
  check('level 过滤只回 warn', obs.query({ level: 'warn', limit: 1000 }).length === 295, String(obs.query({ level: 'warn', limit: 1000 }).length))

  const hits = obs.query({ keyword: '磁盘告警', limit: 1000 })
  check('keyword（FTS/LIKE）命中 10 条', hits.length === 10, String(hits.length))
  check('命中摘要都含关键词', hits.every((r) => r.summary.includes('磁盘告警')))
  check('keyword + kind 组合命中', obs.query({ kinds: ['cpu'], keyword: '磁盘告警' }).length === 10)
  check(
    'keyword + 不匹配的 kind 返回 0',
    obs.query({ kinds: ['event'], keyword: '磁盘告警' }).length === 0
  )
  // 「常规」是两个字的中文子串：unicode61 切不出来，这一条只能靠 LIKE 兜住
  const cjk = obs.query({ keyword: '常规', limit: 1000 })
  check('两字中文子串能搜到（LIKE 兜底）', cjk.length === 1000 && cjk.every((r) => r.summary.includes('常规')))
  check('查不到的词返回空', obs.query({ keyword: '不存在的词组xyz' }).length === 0)

  console.log('4) timeline：按小时分桶，count 与桶内 kinds 统计正确')
  const tlFrom = start
  const tlTo = start + 2 * DAY
  const tlRows = rows.filter((r) => r.ts >= tlFrom && r.ts <= tlTo)
  const expectedBuckets = new Map()
  for (const r of tlRows) {
    const key = Math.floor(r.ts / HOUR) * HOUR
    const bucket = expectedBuckets.get(key) || { count: 0, kinds: {} }
    bucket.count++
    bucket.kinds[r.kind] = (bucket.kinds[r.kind] || 0) + 1
    expectedBuckets.set(key, bucket)
  }
  const timeline = obs.timeline({ from: tlFrom, to: tlTo, bucketMs: HOUR })
  check('桶数量正确', timeline.length === expectedBuckets.size, `${timeline.length} vs ${expectedBuckets.size}`)
  check(
    '桶的起点与数量逐个对上',
    timeline.every((b) => {
      const e = expectedBuckets.get(b.bucketStart)
      return e && b.count === e.count
    })
  )
  check(
    '桶内 kinds 统计正确',
    timeline.every((b) => {
      const e = expectedBuckets.get(b.bucketStart)
      if (!e) return false
      return Object.keys(e.kinds).every((k) => b.kinds[k] === e.kinds[k]) &&
        Object.keys(b.kinds).length === Object.keys(e.kinds).length
    })
  )
  check('桶按时间升序', timeline.every((b, i) => i === 0 || b.bucketStart > timeline[i - 1].bucketStart))
  check(
    '每桶最多 3 条样本且都在桶内',
    timeline.every(
      (b) =>
        b.samples.length <= 3 &&
        b.samples.every((s) => s.ts >= b.bucketStart && s.ts < b.bucketStart + HOUR)
    )
  )
  check(
    '样本按时间倒序',
    timeline.every((b) => b.samples.every((s, i) => i === 0 || s.ts <= b.samples[i - 1].ts))
  )
  check(
    '不传 bucketMs 时默认按小时',
    JSON.stringify(obs.timeline({ from: tlFrom, to: tlTo }).map((b) => [b.bucketStart, b.count])) ===
      JSON.stringify(timeline.map((b) => [b.bucketStart, b.count]))
  )
  check('空区间返回空数组', obs.timeline({ from: 0, to: 1000 }).length === 0)

  console.log('5) dayProfile：按本地日历天汇总')
  const expectedDays = new Map()
  for (const r of tlRows) {
    const day = dayKey(r.ts)
    const entry = expectedDays.get(day) || { count: 0, byKind: {}, warnCount: 0 }
    entry.count++
    entry.byKind[r.kind] = (entry.byKind[r.kind] || 0) + 1
    if (r.level === 'warn') entry.warnCount++
    expectedDays.set(day, entry)
  }
  const profile = obs.dayProfile({ from: tlFrom, to: tlTo })
  check('天数正确', profile.length === expectedDays.size, `${profile.length} vs ${expectedDays.size}`)
  check(
    '每天的条数 / 分类 / 警告数都对',
    profile.every((p) => {
      const e = expectedDays.get(p.day)
      if (!e) return false
      return (
        p.count === e.count &&
        p.warnCount === e.warnCount &&
        Object.keys(e.byKind).every((k) => p.byKind[k] === e.byKind[k]) &&
        Object.keys(p.byKind).length === Object.keys(e.byKind).length
      )
    })
  )
  check('按天升序', profile.every((p, i) => i === 0 || p.day > profile[i - 1].day))

  console.log('6) 重复 open：关掉再开、同时开两个，同一个库都不报错')
  // 用独立的小库，免得给上面那 5000 条添乱
  const dirB = path.join(root, 'reopen')
  const silent = { warn() {} }
  const first = openObservations({ dir: dirB, logger: silent })
  first.append([
    { ts: now - 2000, kind: 'event', summary: '重开之前的第一条' },
    { ts: now - 1000, kind: 'event', summary: '重开之前的第二条' }
  ])
  first.close()
  first.close() // 幂等：关两次不能炸
  check('关两次不抛', true)

  let second = null
  let reopenThrew = false
  try {
    second = openObservations({ dir: dirB, logger: silent })
  } catch {
    reopenThrew = true
  }
  check('重开没有抛异常', reopenThrew === false)
  check('重开后数据还在', second.stats().rows === 2, String(second.stats().rows))
  check('重开后还能接着写', second.append([{ ts: now, kind: 'event', summary: '重开之后' }]) === 1)

  // 两个连接同时开：WAL 允许，插件多开宿主时就是这个场景
  let third = null
  let secondOpenThrew = false
  try {
    third = openObservations({ dir: dirB, logger: silent })
  } catch {
    secondOpenThrew = true
  }
  check('同时开第二个连接不抛', secondOpenThrew === false)
  check('第二个连接看到的是同一份数据', third.stats().rows === 3, String(third.stats().rows))
  third.close()
  second.close()
  check('全部关掉后库文件还在', existsSync(path.join(dirB, 'obs.db')))

  console.log('7) prune：原始指标按 48h、事件按 240h，只删老的')
  const pruneAt = Date.now()
  const rawCut = pruneAt - 48 * HOUR
  const eventCut = pruneAt - 240 * HOUR
  const willDelete = rows.filter((r) =>
    RAW_KINDS.includes(r.kind) ? r.ts < rawCut : r.ts < eventCut
  )
  const kept = rows.filter((r) => !willDelete.includes(r))
  const pruned = obs.prune({ rawKeepHours: 48, eventKeepHours: 240 })
  check('返回删除条数', pruned.deleted === willDelete.length, `${pruned.deleted} vs ${willDelete.length}`)
  const afterPrune = obs.stats()
  check('剩下的是该留的', afterPrune.rows === kept.length, `${afterPrune.rows} vs ${kept.length}`)
  check('最新的还在', afterPrune.lastTs === rows[rows.length - 1].ts)
  check('最老的没了', obs.query({ from: rows[0].ts, to: rows[0].ts }).length === 0)
  check(
    '新数据保留窗口内一条不少',
    JSON.stringify(obs.query({ limit: 1000 }).map((r) => r.ts)) ===
      JSON.stringify(kept.map((r) => r.ts).sort((a, b) => b - a).slice(0, 1000))
  )
  const oldEvent = rows.find((r) => r.kind === 'event')
  check('超过 240h 的事件也删了', oldEvent.ts < eventCut && obs.query({ from: oldEvent.ts, to: oldEvent.ts }).length === 0)
  check('再 prune 一次删 0 条（幂等）', obs.prune({ rawKeepHours: 48, eventKeepHours: 240 }).deleted === 0)

  console.log('8) writeDailySummary：写 daily/YYYY-MM-DD.md，先写临时文件再 rename')
  const dayFile = obs.writeDailySummary('2026-01-02', '# 2026-01-02\n\n今天一切正常。\n')
  check('返回文件路径', typeof dayFile === 'string' && dayFile.endsWith(path.join('daily', '2026-01-02.md')))
  check('文件真的写出来了', existsSync(path.join(dirA, 'daily', '2026-01-02.md')))
  const body = await fsp.readFile(path.join(dirA, 'daily', '2026-01-02.md'), 'utf8')
  check('内容没被改', body.includes('今天一切正常'))
  check('非法日期返回 null', obs.writeDailySummary('2026-1-2', 'x') === null)
  check('空内容返回 null', obs.writeDailySummary('2026-01-03', '   ') === null)

  console.log('9) purge：删库 + 删 daily/*.md，之后 stats() 归零')
  obs.purge()
  const purged = obs.stats()
  check('rows 归零', purged.rows === 0, String(purged.rows))
  check('firstTs / lastTs 为 null', purged.firstTs === null && purged.lastTs === null)
  check('daily 目录已空', (await fsp.readdir(path.join(dirA, 'daily'))).length === 0)
  check('库文件已重建（还能继续用）', existsSync(path.join(dirA, 'obs.db')))
  check('清空后仍可写', obs.append([{ ts: Date.now(), kind: 'event', summary: '清空之后' }]) === 1)
  check('写完又能查到', obs.stats().rows === 1)

  console.log('10) 目录不可写：不抛、返回 0、stats 归零')
  const blocked = path.join(root, 'blocked.bin')
  await fsp.writeFile(blocked, 'x')
  const warnings = []
  let bad = null
  let threw = false
  try {
    // 把「文件」当目录用，mkdir 必然失败
    bad = openObservations({
      dir: path.join(blocked, 'sub'),
      logger: { warn: (m) => warnings.push(String(m)) }
    })
  } catch {
    threw = true
  }
  check('open 没有抛', threw === false)
  check('append 返回 0', bad.append(rows.slice(0, 10)) === 0)
  check('query 返回空数组', Array.isArray(bad.query({})) && bad.query({}).length === 0)
  check('stats 全是 0', bad.stats().rows === 0 && bad.stats().bytes === 0)
  check('daily 写不进去时返回 null', bad.writeDailySummary('2026-01-02', '# x') === null)
  check('close 不抛', (() => { bad.close(); bad.close(); return true })())
  check('至少记了一条 warn', warnings.length >= 1, String(warnings.length))
  check('没有在文件里乱建东西', !existsSync(path.join(blocked, 'sub')))

  console.log('11) 没给 dir：彻底停用，不往 cwd 里偷偷建库')
  const inert = openObservations({ logger: { warn() {} } })
  check('append 0', inert.append(rows.slice(0, 3)) === 0)
  check('stats 0 行', inert.stats().rows === 0)
  check('query 空', inert.query({}).length === 0)
  check('timeline 空', inert.timeline({}).length === 0)
  check('close 不抛', (() => { inert.close(); return true })())

  console.log('12) FTS5 缺失的降级路径：只靠 LIKE 也要能搜')
  const likeOnly = openObservations({
    dir: path.join(root, 'like-only'),
    logger: { warn() {} },
    fts: false // 模拟「这台机器的 sqlite 没编 fts5」
  })
  likeOnly.append([
    { ts: now - 3000, kind: 'event', summary: '磁盘 100% 满了，剩余 0G' },
    { ts: now - 2000, kind: 'event', summary: '磁盘告警：磁盘空间不足' },
    { ts: now - 1000, kind: 'window', summary: 'a_b 里的下划线' }
  ])
  check('stats().fts 如实报 false', likeOnly.stats().fts === false)
  check('中文子串照样搜得到', likeOnly.query({ keyword: '磁盘' }).length === 2)
  check('% 被当成字面量而不是通配符', likeOnly.query({ keyword: '100%' }).length === 1)
  check('_ 被当成字面量', likeOnly.query({ keyword: 'a_b' }).length === 1)
  check('_ 没有变成「任意一个字符」', likeOnly.query({ keyword: 'aXb' }).length === 0)
  likeOnly.close()

  // FTS 开着时，怪关键字不能把查询打死（fts5 会把这些当成语法）
  let weird = null
  let weirdThrew = false
  try {
    weird = obs.query({ keyword: 'AND OR * "', limit: 100 })
  } catch {
    weirdThrew = true
  }
  check('FTS 语法味道的关键字不抛', weirdThrew === false && Array.isArray(weird))
}

try {
  await main()
} catch (err) {
  problems.push('未捕获异常')
  console.log(`  FAIL 未捕获异常 -> ${err?.stack ?? err}`)
} finally {
  try {
    obs?.close()
  } catch {
    /* 已经关过了 */
  }
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log('')
if (problems.length) {
  console.log(`observations-smoke: ${problems.length} 项失败`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('observations-smoke: 全部通过')
