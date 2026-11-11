/**
 * 自我感知自检：sampleCheap / 阈值连续触发 / 冷却 / stop / 异常不抛。
 *
 * 全程注入假 sampleFn 和假 now，不真等 2 分钟，也不依赖本机负载。
 * 唯一碰真机的是第 1 段（sampleCheap 必须读真的 os.cpus）和最后一段（timer unref）。
 *
 * 用法：node test/senses-smoke.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises'

import {
  DEFAULT_THRESHOLDS,
  createSenses,
  decide,
  formatDuration,
  formatGB,
  holdSamples,
  inCooldown,
  normalizeThresholds,
  readDiskFreeGB,
  sampleCheap
} from '../lib/senses.js'

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${detail}` : ''}`)
  }
}

const T0 = 1_700_000_000_000 // 固定的假时钟起点，让摘要可预测

/**
 * 造一个全注入的感知器：假时钟 + 假采样 + 静默 logger，并把事件收起来。
 * `tick()` 每次推进一个采样间隔，模拟一次定时器触发。
 */
function harness({
  cpuRatio = 0.96,
  memRatio = 0.3,
  freeMem = 11_200_000_000,
  totalMem = 16_000_000_000,
  intervalSec = 10,
  holdSec = 30,
  thresholds = {},
  sampleFn,
  statfsFn,
  diskPath,
  diskEvery
} = {}) {
  const clock = { t: T0 }
  const events = []
  const samples = []
  const warns = []
  const senses = createSenses({
    intervalSec,
    now: () => clock.t,
    sampleFn:
      sampleFn ??
      (() => ({
        ts: clock.t,
        cpuRatio,
        memRatio,
        freeMem,
        totalMem,
        uptimeSec: 3600
      })),
    thresholds: { cpuHoldSec: holdSec, diskPath, ...thresholds },
    statfsFn,
    diskEvery,
    logger: { warn: (m) => warns.push(String(m)) }
  })
  senses.on('event', (e) => events.push(e))
  senses.on('sample', (s) => samples.push(s))
  const tick = (stepMs = intervalSec * 1000) => {
    clock.t += stepMs
    return senses.sampleNow()
  }
  return { senses, clock, events, samples, warns, tick }
}

console.log('1) sampleCheap：第一次没有基线 → cpuRatio 为 null，第二次是 0~1 的数')
{
  const first = sampleCheap()
  check('cpuRatio 第一次为 null', first.cpuRatio === null, String(first.cpuRatio))
  check('ts 是毫秒时间戳', Number.isFinite(first.ts) && first.ts > 1_600_000_000_000, String(first.ts))
  check('totalMem > 0', first.totalMem > 0, String(first.totalMem))
  check('freeMem 落在 0~totalMem 之间', first.freeMem >= 0 && first.freeMem <= first.totalMem, `${first.freeMem}/${first.totalMem}`)
  check('memRatio 是 0~1 的数', typeof first.memRatio === 'number' && first.memRatio >= 0 && first.memRatio <= 1, String(first.memRatio))
  check('uptimeSec 是正数', first.uptimeSec > 0, String(first.uptimeSec))
  check('字段就是那六个（loadAvg 只在非 Windows 带）', 'cpuRatio' in first && 'memRatio' in first && 'freeMem' in first && 'totalMem' in first && 'uptimeSec' in first)

  /*
   * os.cpus() 的累计量要靠时间 + 实际 CPU 活动才会变。
   * 空转 200ms 顺手制造一点 CPU 活动；再给几次重试，
   * 免得在计时粒度粗的机器上偶发拿到 null。
   */
  let second = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const until = Date.now() + 200
    while (Date.now() < until) {
      /* 空转：既让时间过去，也制造 idle/total 的差值 */
    }
    second = sampleCheap(first)
    if (typeof second.cpuRatio === 'number') break
  }
  check('cpuRatio 第二次是数', typeof second.cpuRatio === 'number', String(second?.cpuRatio))
  check('cpuRatio 落在 0~1', second.cpuRatio >= 0 && second.cpuRatio <= 1, String(second.cpuRatio))

  /*
   * 再隔开一点：两次采样挨得太近时 os 的累计量还没走，
   * 差值算不出来，按设计给 null（那不代表 0% 占用）。
   */
  const until3 = Date.now() + 120
  while (Date.now() < until3) {
    /* 空转 */
  }
  const third = sampleCheap(second)
  check('继续有基线就一直有值', typeof third.cpuRatio === 'number', String(third?.cpuRatio))
}

console.log('2) 连续 3 次超阈值 → 只发 1 个 event（N = ceil(cpuHoldSec / intervalSec)）')
{
  check('holdSamples(10, 120) = 12（设计稿那个例子）', holdSamples(10, 120) === 12, String(holdSamples(10, 120)))
  check('holdSamples 最少 1 次', holdSamples(10, 0) === 1, String(holdSamples(10, 0)))
  check('holdSamples 除零不炸', holdSamples(0, 120) === 120, String(holdSamples(0, 120)))

  const h = harness({ cpuRatio: 0.96, holdSec: 30, intervalSec: 10 })
  h.senses.start()
  h.tick()
  h.tick()
  check('第 2 次还没到 N=3，不发', h.events.length === 0, String(h.events.length))
  h.tick()
  check('第 3 次刚好触发，且只触发 1 次', h.events.length === 1, String(h.events.length))

  const ev = h.events[0]
  check('kind = cpu', ev.kind === 'cpu', ev.kind)
  check('level = warn', ev.level === 'warn', ev.level)
  check('summary 是中文人话', ev.summary.includes('CPU') && ev.summary.includes('96%') && ev.summary.includes('30 秒'), ev.summary)
  check('summary 说清了「可能是某个程序在满载」', ev.summary.includes('满载'), ev.summary)
  check('detail 带上了百分比和连续次数', ev.detail?.cpuPercent === 96 && ev.detail?.holdSamples === 3, JSON.stringify(ev.detail))
  check('sample 事件每次都发（3 次）', h.samples.length === 3, String(h.samples.length))
  check('每个 sample 都带 ts', h.samples.every((s) => Number.isFinite(s.ts)))
  check('status 记下了事件时间', h.senses.status().lastEventAt === T0 + 30_000, String(h.senses.status().lastEventAt))

  // 摘要格式：设计稿里的例子要能原样拼出来
  check('formatDuration(120) = 2 分钟', formatDuration(120) === '2 分钟', formatDuration(120))
  h.senses.stop()
}

console.log('3) 冷却期内不再发；冷却过了、仍然高，才会再发一次')
{
  const h = harness({ cpuRatio: 0.96, holdSec: 30, intervalSec: 10, thresholds: { cooldownSec: 900 } })
  h.senses.start()
  h.tick()
  h.tick()
  h.tick()
  check('先发了一次', h.events.length === 1, String(h.events.length))

  // 仍在持续超阈值，但还在 900 秒冷却里
  h.tick()
  h.tick()
  h.tick()
  check('冷却期内持续超阈值也不再发', h.events.length === 1, String(h.events.length))

  // 冷却差一秒（距离上次事件 899 秒）仍不发：直接把假时钟拨到那一刻
  h.clock.t = T0 + 30_000 + 899_000
  h.tick(0)
  check('冷却差一秒仍然压住', h.events.length === 1, String(h.events.length))

  // 越过冷却（910 秒），立刻补报
  h.tick(10_000)
  check('冷却结束后再发一次', h.events.length === 2, String(h.events.length))

  check('inCooldown 纯函数：刚发过在冷却里', inCooldown(T0, T0 + 1000, 900) === true)
  check('inCooldown 纯函数：从没发过不算冷却', inCooldown(null, T0, 900) === false)
  check('inCooldown 纯函数：冷却为 0 不抑制', inCooldown(T0, T0, 0) === false)
  h.senses.stop()
}

console.log('4) stop() 之后 sampleNow 一个事件都不发（sample / event 都不发）')
{
  const h = harness({ cpuRatio: 0.97, holdSec: 30, intervalSec: 10 })
  h.senses.start()
  h.tick()
  h.tick()
  h.tick()
  check('停之前先发过一次', h.events.length === 1, String(h.events.length))

  h.senses.stop()
  const sampleBefore = h.samples.length
  const eventBefore = h.events.length
  // 时间大步跳，连冷却都绕过去：如果还有残留判定，这里必然冒出来
  for (let i = 0; i < 5; i++) h.tick(1_000_000)
  check('stop 后不再发 event', h.events.length === eventBefore, String(h.events.length))
  check('stop 后也不再发 sample', h.samples.length === sampleBefore, String(h.samples.length))
  check('stop 后 sampleNow 仍返回采样值（只是不发）', h.senses.sampleNow() !== null)
  check('status().running = false', h.senses.status().running === false)

  let threw = false
  try {
    h.senses.stop()
    h.senses.stop()
  } catch {
    threw = true
  }
  check('stop() 幂等，重复调不抛', threw === false)
}

console.log('5) 没超阈值就不发；中间掉下去一次，连续计数要清零')
{
  const calm = harness({ cpuRatio: 0.5, memRatio: 0.3, holdSec: 30 })
  calm.senses.start()
  for (let i = 0; i < 5; i++) calm.tick()
  check('CPU 一半负载，5 次采样 0 事件', calm.events.length === 0, String(calm.events.length))
  check('sample 照常发 5 次', calm.samples.length === 5, String(calm.samples.length))
  calm.senses.stop()

  // 尖峰不算数：超、超、掉下来、超、超 —— 一次都不该报
  const clock = { t: T0 }
  let ratio = 0.99
  const events = []
  const s = createSenses({
    intervalSec: 10,
    now: () => clock.t,
    sampleFn: () => ({ ts: clock.t, cpuRatio: ratio, memRatio: 0.2, freeMem: 1e9, totalMem: 16e9, uptimeSec: 1 }),
    thresholds: { cpuHoldSec: 30 },
    logger: { warn: () => {} }
  })
  s.on('event', (e) => events.push(e))
  s.start()
  const tick = () => {
    clock.t += 10_000
    s.sampleNow()
  }
  tick()
  tick()
  ratio = 0.2
  tick() // 掉下来，连续计数归零
  ratio = 0.99
  tick()
  tick()
  check('超两次 + 掉一次 + 超两次 = 不算持续，0 事件', events.length === 0, String(events.length))
  tick()
  check('重新连续满 3 次才发', events.length === 1, String(events.length))
  s.stop()
}

console.log('6) 采样函数抛错：不崩、记 warn、status() 照样能用')
{
  const clock = { t: T0 }
  const warns = []
  const s = createSenses({
    intervalSec: 10,
    now: () => clock.t,
    sampleFn: () => {
      throw new Error('boom')
    },
    logger: { warn: (m) => warns.push(String(m)) }
  })

  let threw = false
  let value
  try {
    s.start()
    clock.t += 10_000
    value = s.sampleNow()
  } catch {
    threw = true
  }
  check('没有异常溢出来', threw === false)
  check('sampleNow 返回 null', value === null, String(value))
  check('logger.warn 记了一笔', warns.length >= 1, warns.join(' | '))
  check('warn 里说清了是采样失败', warns.some((w) => w.includes('[senses]') && w.includes('采样失败')), warns.join(' | '))

  const st = s.status()
  check('status() 仍然可用', !!st && st.running === true && st.lastSample === null, JSON.stringify(st))
  check('status() 字段齐全', 'running' in st && 'intervalSec' in st && 'lastSample' in st && 'lastEventAt' in st)

  // 监听器自己抛错，也不能反噬采样循环
  let listenerThrew = false
  const h = harness({ cpuRatio: 0.1, holdSec: 30 })
  h.senses.on('sample', () => {
    throw new Error('bad listener')
  })
  h.senses.start()
  try {
    h.tick()
  } catch {
    listenerThrew = true
  }
  check('监听器抛错不外溢', listenerThrew === false)
  check('采样还在继续（sample 收到了 1 次）', h.samples.length === 1, String(h.samples.length))
  check('监听器出错记了 warn', h.warns.some((w) => w.includes('监听器')), h.warns.join(' | '))
  h.senses.stop()
  s.stop()
}

console.log('7) 阈值/摘要的纯函数 + 磁盘每 20 次采样读一次')
{
  check('阈值默认值齐全', DEFAULT_THRESHOLDS.cpu === 90 && DEFAULT_THRESHOLDS.mem === 92 && DEFAULT_THRESHOLDS.cpuHoldSec === 120)
  const th = normalizeThresholds({ cpu: '85', cpuHoldSec: 'abc', diskPath: '  D:  ' })
  check('合法项被采用', th.cpu === 85, String(th.cpu))
  check('脏数据回落到默认（不变成 NaN）', th.cpuHoldSec === 120, String(th.cpuHoldSec))
  check('盘符去掉空白', th.diskPath === 'D:', th.diskPath)
  check('冷却默认 900', th.cooldownSec === 900, String(th.cooldownSec))
  check('formatGB(0.5) 用 MB', formatGB(0.5) === '512 MB', formatGB(0.5))
  check('formatGB(3.24) 用 GB', formatGB(3.24) === '3.2 GB', formatGB(3.24))

  // decide 是纯函数：同样的输入永远同样的输出，且不篡改入参
  const streaks = { cpu: 0, mem: 0, disk: 0 }
  const r1 = decide({
    sample: { cpuRatio: 0.96, memRatio: 0.2 },
    thresholds: normalizeThresholds({ cpuHoldSec: 20 }),
    holdN: 2,
    intervalSec: 10,
    streaks,
    lastEventAt: {},
    nowMs: T0,
    disk: null
  })
  check('纯函数：入参 streaks 没被改', streaks.cpu === 0, JSON.stringify(streaks))
  check('第 1 次只攒计数不发事件', r1.streaks.cpu === 1 && r1.events.length === 0, JSON.stringify(r1.streaks))
  const r2 = decide({
    sample: { cpuRatio: 0.96, memRatio: 0.2 },
    thresholds: normalizeThresholds({ cpuHoldSec: 20 }),
    holdN: 2,
    intervalSec: 10,
    streaks: r1.streaks,
    lastEventAt: r1.lastEventAt,
    nowMs: T0 + 20_000,
    disk: null
  })
  check('第 2 次发事件', r2.events.length === 1 && r2.events[0].kind === 'cpu', String(r2.events.length))
  check('summary 里的时长 = holdN × intervalSec', r2.events[0].summary.includes('20 秒'), r2.events[0].summary)

  // 磁盘：低空间 + 每 20 次读一次盘
  const h = harness({
    cpuRatio: 0.1,
    holdSec: 10,
    intervalSec: 10,
    thresholds: { diskFreeGB: 5, cpuHoldSec: 10 },
    statfsFn: () => ({ bavail: 100, bsize: 10 * 1024 * 1024 }) // 1000 MB ≈ 0.98 GB
  })
  h.senses.start()
  for (let i = 0; i < 19; i++) h.tick()
  check('前 19 次不读盘，因此没有磁盘事件', h.events.length === 0, String(h.events.length))
  h.tick()
  check('第 20 次读到只剩 1 GB，发磁盘事件', h.events.length === 1, String(h.events.length))
  const diskEvent = h.events[0]
  check('kind = disk / level = notice', diskEvent.kind === 'disk' && diskEvent.level === 'notice', `${diskEvent.kind}/${diskEvent.level}`)
  check('摘要里说了盘符和剩余空间', diskEvent.summary.includes('C:') && diskEvent.summary.includes('GB') && diskEvent.summary.includes('低于 5 GB'), diskEvent.summary)
  h.senses.stop()

  // statfs 抛错：静默跳过，不报错也不发事件
  const broken = harness({
    cpuRatio: 0.1,
    holdSec: 10,
    thresholds: { cpuHoldSec: 10 },
    statfsFn: () => {
      throw new Error('no statfs here')
    }
  })
  broken.senses.start()
  let broke = false
  try {
    for (let i = 0; i < 25; i++) broken.tick()
  } catch {
    broke = true
  }
  check('读盘抛错不崩', broke === false)
  check('读盘抛错不发磁盘事件', broken.events.length === 0, String(broken.events.length))
  check('读盘失败是静默的（不刷 warn）', broken.warns.length === 0, broken.warns.join(' | '))
  broken.senses.stop()

  // statfs 返回垃圾 / 抛错，都要安静给 null，不能编一个数字出来
  check('statfs 返回垃圾时给 null', readDiskFreeGB('C:', { statfsFn: () => null }) === null)
  check('statfs 返回非数值时给 null', readDiskFreeGB('C:', { statfsFn: () => ({ bavail: 'x', bsize: 'y' }) }) === null)
  check('盘符不存在（抛错）时给 null', readDiskFreeGB('Z:\\nope\\nope', { statfsFn: () => { throw new Error('ENOENT') } }) === null)
}

console.log('8) start() 幂等：调三次也只有一条 timer')
{
  const clock = { t: T0 }
  const samples = []
  const s = createSenses({
    intervalSec: 0.05,
    now: () => clock.t,
    sampleFn: () => ({ ts: clock.t, cpuRatio: 0.1, memRatio: 0.2, freeMem: 1e9, totalMem: 16e9, uptimeSec: 1 }),
    logger: { warn: () => {} }
  })
  s.on('sample', () => samples.push(1))
  s.start()
  s.start()
  s.start()
  await sleep(500)
  s.stop()
  // 50ms 一条，500ms 大约 10 条；三条 timer 的话会是 30 条左右
  check('500ms 内采样约 10 次（单条 timer）', samples.length >= 5 && samples.length <= 14, String(samples.length))
  const again = s.start()
  check('start() 返回自身，方便链式调用', again === s)
  s.stop()
  const st = s.status()
  check('stop 后 status 干净', st.running === false && st.sampleCount >= 5, JSON.stringify({ running: st.running, count: st.sampleCount }))
}

console.log('9) timer 必须 unref（这一段故意留一个在跑，进程还得能退出）')
{
  /*
   * 下面这个实例不 stop。
   * 如果 setInterval 忘了 unref()，事件循环会一直被它吊着、进程退不出去，
   * 5 秒后的看门狗就会把它打掉并报错；反过来，进程安静退出就说明 unref 生效了。
   */
  const lingering = createSenses({ intervalSec: 1, logger: { warn: (m) => problems.push(String(m)) } })
  lingering.start()
  const watchdog = setTimeout(() => {
    console.log('  FAIL timer 没有 unref —— 进程被 setInterval 拖住了')
    process.exit(1)
  }, 5000)
  watchdog.unref?.()
  check('留了一个在跑的感知器（进程能退出即证明 unref 生效）', lingering.status().running === true)
}

console.log('')
if (problems.length) {
  console.log(`senses-smoke: ${problems.length} 项失败`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('senses-smoke: 全部通过')
