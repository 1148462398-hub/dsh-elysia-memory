/**
 * 自我感知（senses）：看看这台机器自己累不累。
 *
 * 设计稿见 `docs/proactive-assistant.md` 第 2 节，这里是它的实现。
 *
 * 三条铁律都照顾到了：
 *   · 默认关——模块自己不起 timer，必须有人显式 `start()`；
 *   · 只读——只碰 `node:os` / `node:fs` 的只读接口，不 spawn 子进程、不改任何东西
 *     （前台窗口那类要 user32 的，本期不做）；
 *   · 不塞主记忆——这里只产出结构化的 sample / event，落库是 observations 的事。
 *
 * 为什么要「持续 N 次」而不是「一超就报」：
 *   编译一次、加载一次场景、一次 GC，都能把 CPU 顶到 100%。那种一秒钟的尖峰不值得打扰人，
 *   所以连续 N 次采样都超阈值才算数，N = ceil(cpuHoldSec / intervalSec)。
 *   发过一次之后进冷却（默认 900 秒），持续高负载也只会在冷却结束后再提醒一次。
 *
 * 所有 timer 都 unref()：这个插件是住在别人家里的，不能拖住宿主退出。
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'

/** 默认阈值。任何一项都能被 `createSenses({ thresholds })` 覆盖。 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  cpu: 90,
  cpuHoldSec: 120,
  mem: 92,
  diskFreeGB: 5,
  diskPath: 'C:'
})

/** 默认采样间隔（秒） */
export const DEFAULT_INTERVAL_SEC = 10
/** 触发一次事件后，抑制同类事件重复的时长（秒） */
export const DEFAULT_COOLDOWN_SEC = 900
/** 磁盘检查的步长：每 20 次采样才读一次盘 */
export const DEFAULT_DISK_EVERY = 20
/**
 * 采样间隔下限（秒）。
 * 不是为了精确，是为了防止配置写错（0 / 负数）把 setInterval 变成忙循环。
 */
export const MIN_INTERVAL_SEC = 0.05

/* ------------------------------- 小工具 ------------------------------- */

/** 压到 0~1；不是有限数就返回 null（别把 NaN 当 0 混进来） */
function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** 取一个有限数，取不到就用 fallback */
function pickNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 百分比的显示：3.14159 -> 3；96.6 -> 97 */
function roundPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n)
}

/** 异常转一行字，日志里用 */
function errText(error) {
  try {
    if (!error) return '未知错误'
    return String(error?.message ?? error)
  } catch {
    return '未知错误'
  }
}

/** 把秒数说成人话：45 -> 45 秒；120 -> 2 分钟；5400 -> 1.5 小时 */
export function formatDuration(seconds) {
  const s = Math.max(0, pickNumber(seconds, 0))
  if (s < 60) return `${Math.round(s)} 秒`
  const minutes = s / 60
  if (minutes < 60) return Number.isInteger(minutes) ? `${minutes} 分钟` : `${minutes.toFixed(1)} 分钟`
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours} 小时` : `${hours.toFixed(1)} 小时`
}

/** GB 说人话：小于 1 GB 用 MB，免得出一个 0.0 GB */
export function formatGB(gb) {
  const v = Number(gb)
  if (!Number.isFinite(v) || v < 0) return '未知'
  if (v >= 1) return `${v.toFixed(1)} GB`
  return `${Math.round(v * 1024)} MB`
}

/* --------------------------- 纯函数：阈值与节奏 --------------------------- */

/**
 * 阈值归一化：缺项补默认、脏数据丢掉、越界的夹回合理区间。
 * 永远返回一个字段齐全的对象，调用方不用再判空。
 */
export function normalizeThresholds(input) {
  const src = input && typeof input === 'object' ? input : {}
  const num = (key) => pickNumber(src[key], DEFAULT_THRESHOLDS[key])
  return {
    // 提示百分比：0 是「一直算超」，100 是「几乎不可能超」，两个极端都合法
    cpu: Math.min(100, Math.max(0, num('cpu'))),
    cpuHoldSec: Math.max(0, num('cpuHoldSec')),
    mem: Math.min(100, Math.max(0, num('mem'))),
    diskFreeGB: Math.max(0, num('diskFreeGB')),
    // 盘符只认非空字符串，其它一律回默认，别拿对象去喂 statfs
    diskPath:
      typeof src.diskPath === 'string' && src.diskPath.trim() ? src.diskPath.trim() : DEFAULT_THRESHOLDS.diskPath,
    // 冷却跟着阈值一起归一化，集成时只传一个 thresholds 就够
    cooldownSec: Math.max(0, pickNumber(src.cooldownSec, DEFAULT_COOLDOWN_SEC))
  }
}

/**
 * 「持续」到底要几次采样：N = ceil(cpuHoldSec / intervalSec)，最少 1 次。
 * 除 ZeroDivision 也防了（intervalSec <= 0 当 1 秒算）。
 */
export function holdSamples(intervalSec, holdSec) {
  const iv = pickNumber(intervalSec, 0) > 0 ? pickNumber(intervalSec, 0) : 1
  const hold = Math.max(0, pickNumber(holdSec, 0))
  return Math.max(1, Math.ceil(hold / iv))
}

/**
 * 冷却判定（纯函数）：true = 还在冷却里，这次不许发。
 * `lastAt` 不是有限数（从没发过）时永远返回 false。
 */
export function inCooldown(lastAt, nowMs, cooldownSec) {
  if (!Number.isFinite(Number(lastAt))) return false
  const cool = Math.max(0, pickNumber(cooldownSec, 0)) * 1000
  if (cool <= 0) return false
  const now = pickNumber(nowMs, Date.now())
  return now - Number(lastAt) < cool
}

/**
 * 节流（纯函数）：true = 现在允许发。
 * 就是 `!inCooldown`，单独导出一份是因为「读起来更顺」——决定发不发的时候用它。
 */
export function throttle(lastAt, nowMs, cooldownSec) {
  return !inCooldown(lastAt, nowMs, cooldownSec)
}

/* ----------------------------- 纯函数：摘要 ----------------------------- */

/** CPU 事件的摘要，例：「CPU 连续 2 分钟高于 90%（现在 96%），可能是某个程序在满载」 */
export function cpuSummary({ holdSec, percent, threshold }) {
  return `CPU 连续 ${formatDuration(holdSec)}高于 ${roundPct(threshold)}%（现在 ${roundPct(percent)}%），可能是某个程序在满载`
}

/** 内存事件的摘要，例：「内存连续 2 分钟高于 92%（现在 95%，可用约 0.8 GB），可能有程序在占着大量内存」 */
export function memSummary({ holdSec, percent, threshold, freeMem }) {
  const now = `现在 ${roundPct(percent)}%`
  const free = Number(freeMem) > 0 ? `，可用约 ${formatGB(Number(freeMem) / 1024 ** 3)}` : ''
  return `内存连续 ${formatDuration(holdSec)}高于 ${roundPct(threshold)}%（${now}${free}），可能有程序在占着大量内存`
}

/** 磁盘事件的摘要，例：「C: 盘只剩 1.0 GB 可用（低于 5 GB），建议抽空清理一下」 */
export function diskSummary({ freeGB, threshold, diskPath }) {
  const path = diskPath || DEFAULT_THRESHOLDS.diskPath
  const lim = Number(threshold)
  const limText = Number.isInteger(lim) ? String(lim) : lim.toFixed(1)
  return `${path} 盘只剩 ${formatGB(freeGB)} 可用（低于 ${limText} GB），建议抽空清理一下`
}

/* ------------------------------ 廉价采样 ------------------------------ */

/**
 * 上一轮 `os.cpus()` 的累计量。
 * 用 WeakMap 挂在返回的 sample 对象上，这样 `sampleCheap(prev)` 的签名就够用了，
 * 又不用在返回结构里塞一个「内部字段」污染对外的形状（对外的字段是定死的六个）。
 */
const CPU_BASELINE = new WeakMap()
/** 没传 prevSample 时的兜底基线（模块级，多个 Senses 实例共用也没关系：都只是差值） */
let lastCpuTotals = null

/** 读一次 CPU 累计时间（idle / total）。读不到就返回 null，绝不抛。 */
function readCpuTotals() {
  let cpus
  try {
    cpus = os.cpus()
  } catch {
    return null
  }
  if (!Array.isArray(cpus) || cpus.length === 0) return null
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const times = cpu?.times
    if (!times) continue
    const i = pickNumber(times.idle, 0)
    idle += i
    total += i + pickNumber(times.user, 0) + pickNumber(times.nice, 0) + pickNumber(times.sys, 0) + pickNumber(times.irq, 0)
  }
  if (!(total > 0)) return null
  return { idle, total }
}

/**
 * 用两次累计量的差值算 CPU 占用。纯函数，方便单测。
 * 差值为 0（两次采样挨得太近）返回 null——那不代表「0% 占用」，代表「没测出来」。
 */
export function cpuRatioBetween(baseline, current) {
  if (!baseline || !current) return null
  const dTotal = Number(current.total) - Number(baseline.total)
  const dIdle = Number(current.idle) - Number(baseline.idle)
  if (!(dTotal > 0) || !Number.isFinite(dIdle)) return null
  return clamp01(1 - dIdle / dTotal)
}

/**
 * 最廉价的一次采样（只读 os，实测 < 1ms）。
 *
 * @param {object} [prevSample] 上一次 `sampleCheap()` 的返回值；给了就用它做 CPU 基线
 * @returns {{ts:number, cpuRatio:number|null, memRatio:number|null, freeMem:number, totalMem:number, uptimeSec:number}}
 *
 * `cpuRatio` 是**前后两次**采样的差值，所以第一次调用（没有基线）一定是 `null`——
 * 别把它当 0，那会让「刚启动那一秒很闲」的假象流进观测库。
 * 两次调用挨得太近（os 的累计量还没走、差值为 0）时同样是 `null`：
 * 那是「没测出来」，不是「占用 0%」。正常 10 秒一采是不会碰上这种情况的。
 */
export function sampleCheap(prevSample) {
  const ts = Date.now()
  const sample = {
    ts,
    cpuRatio: null,
    memRatio: null,
    freeMem: 0,
    totalMem: 0,
    uptimeSec: 0
  }

  let totals = null
  try {
    totals = readCpuTotals()
    if (totals) {
      const baseline = prevSample && typeof prevSample === 'object' ? CPU_BASELINE.get(prevSample) : null
      sample.cpuRatio = cpuRatioBetween(baseline || lastCpuTotals, totals)
    }
  } catch {
    // 读 CPU 失败就当没测出来，cpuRatio 留 null
  }

  try {
    const totalMem = pickNumber(os.totalmem(), 0)
    const freeMem = pickNumber(os.freemem(), 0)
    sample.totalMem = totalMem
    sample.freeMem = freeMem
    sample.memRatio = totalMem > 0 ? clamp01(1 - freeMem / totalMem) : null
  } catch {
    // 读内存失败同上
  }

  try {
    sample.uptimeSec = Math.max(0, Math.round(pickNumber(os.uptime(), 0)))
  } catch {
    // 拿不到开机时长就当 0
  }

  /*
   * loadAvg 只在能给真值的平台带。
   * Windows 上 os.loadavg() 永远返回 [0,0,0]，带出去就是骗自己。
   */
  if (process.platform !== 'win32') {
    try {
      const load = os.loadavg()
      if (Array.isArray(load) && load.length) sample.loadAvg = load.map((v) => pickNumber(v, 0))
    } catch {
      // 没有就算了，它本来就是可选的
    }
  }

  // 基线只在新值可读时更新，否则下次会拿一个坏基线去算，越算越离谱
  if (totals) {
    lastCpuTotals = totals
    try {
      CPU_BASELINE.set(sample, totals)
    } catch {
      // sample 一定是对象，这里理论上不会进；进了也不影响主流程
    }
  }
  return sample
}

/* ------------------------------- 读磁盘 ------------------------------- */

/**
 * 读某个盘的剩余空间（GB）。读不到 / 平台不支持 / 抛错，一律返回 null。
 *
 * `fs.statfsSync` 是 Node 18.15+ 才有的，老运行时上直接没有这个函数——
 * 按设计稿要求「静默跳过」，不报错、不降级成猜一个数字。
 */
export function readDiskFreeGB(diskPath, options = {}) {
  const statfsFn = typeof options.statfsFn === 'function' ? options.statfsFn : fs?.statfsSync
  if (typeof statfsFn !== 'function') return null
  const path = diskPath || DEFAULT_THRESHOLDS.diskPath
  try {
    const st = statfsFn(path)
    if (!st || typeof st !== 'object') return null
    // bavail = 非特权用户可用块数；bsize = 块大小（字节）
    const freeBytes = Number(st.bavail) * Number(st.bsize)
    if (!Number.isFinite(freeBytes) || freeBytes < 0) return null
    return freeBytes / 1024 ** 3
  } catch {
    return null
  }
}

/* ---------------------------- 纯函数：判定 ---------------------------- */

/**
 * 一次判定的全部输入输出都摆在参数和返回值里，不藏状态——这是它能被单测的原因。
 *
 * @param {object} input
 * @param {object} input.sample 归一化后的采样
 * @param {object} input.thresholds `normalizeThresholds()` 的结果
 * @param {number} input.holdN 连续多少次算「持续」
 * @param {number} [input.intervalSec] 采样间隔（只用来把 N 换算成「连续多少秒」写进摘要）
 * @param {{cpu:number,mem:number,disk:number}} [input.streaks] 上一轮的连续计数
 * @param {{cpu:number|null,mem:number|null,disk:number|null}} [input.lastEventAt] 上一轮各种事件的最后时间
 * @param {number} [input.nowMs] 当前时间
 * @param {{path:string,freeGB:number}|null} [input.disk] 本轮磁盘读数；null = 这一轮没读盘
 * @returns {{streaks:object, lastEventAt:object, events:object[], holdN:number, holdSec:number}}
 *
 * 几个刻意的决定：
 *   · 触发后**不清零** streak——冷却结束后仍持续的话，下一次采样就能再报一次；
 *   · 冷却按 kind 分开（cpu 的冷却不该压住磁盘的提醒）；
 *   · 磁盘那一项只在真的读了盘的那一次推进/清零，否则每 20 次才读一次盘，
 *     中间 19 次空采样会把连续计数抹掉，永远攒不满 N。
 */
export function decide(input = {}) {
  const sample = input.sample && typeof input.sample === 'object' ? input.sample : {}
  const th = input.thresholds ?? DEFAULT_THRESHOLDS
  const holdN = Math.max(1, Math.floor(pickNumber(input.holdN, 1)))
  const intervalSec = pickNumber(input.intervalSec, 0) > 0 ? pickNumber(input.intervalSec, 0) : 0
  const holdSec = holdN * intervalSec
  const nowMs = pickNumber(input.nowMs, Date.now())
  const cool = Math.max(0, pickNumber(th.cooldownSec, DEFAULT_COOLDOWN_SEC))
  const disk = input.disk && typeof input.disk === 'object' ? input.disk : null

  const streaks = { cpu: 0, mem: 0, disk: 0, ...(input.streaks ?? {}) }
  const lastEventAt = { cpu: null, mem: null, disk: null, ...(input.lastEventAt ?? {}) }
  const events = []

  /** 推进一项的连续计数；够久、没在冷却里，就产出一个事件 */
  const step = (kind, isOver, build) => {
    const prev = Math.max(0, Math.floor(pickNumber(streaks[kind], 0)))
    streaks[kind] = isOver ? prev + 1 : 0
    if (!isOver) return
    if (streaks[kind] < holdN) return
    if (inCooldown(lastEventAt[kind], nowMs, cool)) return
    lastEventAt[kind] = nowMs
    events.push(build(streaks[kind]))
  }

  const cpuRatio = Number.isFinite(sample.cpuRatio) ? clamp01(sample.cpuRatio) : null
  const cpuPercent = cpuRatio === null ? null : cpuRatio * 100
  step('cpu', cpuPercent !== null && cpuPercent >= th.cpu, () => ({
    ts: nowMs,
    kind: 'cpu',
    level: 'warn',
    summary: cpuSummary({ holdSec, percent: cpuPercent, threshold: th.cpu }),
    detail: {
      cpuPercent: roundPct(cpuPercent),
      cpuRatio,
      threshold: th.cpu,
      holdSec,
      holdSamples: holdN
    }
  }))

  const memRatio = Number.isFinite(sample.memRatio) ? clamp01(sample.memRatio) : null
  const memPercent = memRatio === null ? null : memRatio * 100
  step('mem', memPercent !== null && memPercent >= th.mem, () => ({
    ts: nowMs,
    kind: 'mem',
    level: 'warn',
    summary: memSummary({ holdSec, percent: memPercent, threshold: th.mem, freeMem: sample.freeMem }),
    detail: {
      memPercent: roundPct(memPercent),
      memRatio,
      freeMem: pickNumber(sample.freeMem, 0),
      totalMem: pickNumber(sample.totalMem, 0),
      threshold: th.mem,
      holdSec,
      holdSamples: holdN
    }
  }))

  if (disk && Number.isFinite(disk.freeGB)) {
    const freeGB = Math.max(0, Number(disk.freeGB))
    step('disk', freeGB <= th.diskFreeGB, () => ({
      ts: nowMs,
      kind: 'disk',
      level: 'notice',
      summary: diskSummary({ freeGB, threshold: th.diskFreeGB, diskPath: disk.path || th.diskPath }),
      detail: {
        freeGB: Number(freeGB.toFixed(2)),
        threshold: th.diskFreeGB,
        path: disk.path || th.diskPath
      }
    }))
  }

  return { streaks, lastEventAt, events, holdN, holdSec }
}

/* ------------------------------ 监听器本体 ------------------------------ */

/**
 * `createSenses()` 造出来的东西。继承 EventEmitter，额外给 start/stop/sampleNow/status。
 *
 * 事件：
 *   · `'sample'` → (sample) 每次采到值都发（只在 start 之后、stop 之前）；
 *   · `'event'`  → ({ts, kind, level, summary, detail}) 满足「持续超阈值」才发。
 */
class Senses extends EventEmitter {
  #intervalSec
  #thresholds
  #holdN
  #logger
  #now
  #sampleFn
  #statfsFn
  #diskEvery
  #running
  #timer
  #sampleCount
  #lastSample
  #streaks
  #lastEventAt

  constructor(options = {}) {
    super()
    const opts = options && typeof options === 'object' ? options : {}

    const interval = pickNumber(opts.intervalSec, DEFAULT_INTERVAL_SEC)
    this.#intervalSec = interval >= MIN_INTERVAL_SEC ? interval : DEFAULT_INTERVAL_SEC
    this.#thresholds = normalizeThresholds(opts.thresholds)
    this.#holdN = holdSamples(this.#intervalSec, this.#thresholds.cpuHoldSec)
    this.#logger = opts.logger ?? null
    this.#now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.#sampleFn = typeof opts.sampleFn === 'function' ? opts.sampleFn : null
    this.#statfsFn = typeof opts.statfsFn === 'function' ? opts.statfsFn : null

    const every = pickNumber(opts.diskEvery, DEFAULT_DISK_EVERY)
    this.#diskEvery = every > 0 ? Math.floor(every) : DEFAULT_DISK_EVERY

    this.#running = false
    this.#timer = null
    this.#sampleCount = 0
    this.#lastSample = null
    this.#streaks = { cpu: 0, mem: 0, disk: 0 }
    this.#lastEventAt = { cpu: null, mem: null, disk: null }
  }

  /** 采样间隔（秒） */
  get intervalSec() {
    return this.#intervalSec
  }

  /** 「持续」需要连续几次采样 */
  get holdSamples() {
    return this.#holdN
  }

  /** 现在在跑吗 */
  get running() {
    return this.#running
  }

  /**
   * 开始采样。幂等：已经在跑时直接返回 this，不会多出一条 timer。
   * 用默认采样器时会先悄悄采一次当 CPU 基线（不发事件）——
   * 否则第一个 tick 的 cpuRatio 是 null，白丢十秒。
   */
  start() {
    if (this.#running) return this
    this.#running = true
    try {
      if (!this.#sampleFn) {
        // 只为了建立基线，不计数、不发事件
        try {
          sampleCheap()
        } catch (error) {
          this.#warn(`预热采样失败，首个采样点可能没有 CPU 读数：${errText(error)}`)
        }
      }
      if (this.#intervalSec > 0) {
        this.#timer = setInterval(() => {
          this.#runOnce()
        }, Math.round(this.#intervalSec * 1000))
        // 关键：unref()，否则插件会把 DSH 的进程吊在这里，退出不了
        this.#timer?.unref?.()
      }
    } catch (error) {
      // timer 都造不出来（极罕见）就当没启动，别让调用方以为在跑
      this.#running = false
      this.#timer = null
      this.#warn(`启动采样失败：${errText(error)}`)
    }
    return this
  }

  /**
   * 停止采样。幂等：重复调用不抛。
   * 顺手清零连续计数（重启这一轮重新攒），但保留各 kind 的最后事件时间——
   * 用户刚被提醒过 CPU 高，重启一下不该立刻再被提醒一次。
   */
  stop() {
    this.#running = false
    if (this.#timer) {
      try {
        clearInterval(this.#timer)
      } catch {
        // clearInterval 基本不抛；抛了也无所谓，timer 已经 unref 过
      }
      this.#timer = null
    }
    this.#streaks = { cpu: 0, mem: 0, disk: 0 }
    return this
  }

  /**
   * 立刻采一次。
   *
   * 跑着的时候：发 `'sample'`，并按判定结果可能发 `'event'`。
   * 停了以后：只把采样值给你（返回值），**一个事件都不发**——
   * 这就是「stop() 之后不能再触发任何事件」的落点。
   *
   * @returns {object|null} 采样值；采不到（抛错 / 返回垃圾）时是 null
   */
  sampleNow() {
    return this.#runOnce()
  }

  /** 当前状态。任何时候都能调，不抛。 */
  status() {
    const stamps = Object.values(this.#lastEventAt).filter((v) => Number.isFinite(v))
    return {
      running: this.#running,
      intervalSec: this.#intervalSec,
      sampleCount: this.#sampleCount,
      lastSample: this.#lastSample ? { ...this.#lastSample } : null,
      lastEventAt: stamps.length ? Math.max(...stamps) : null,
      lastEventByKind: { ...this.#lastEventAt },
      streaks: { ...this.#streaks },
      holdN: this.#holdN,
      cooldownSec: this.#thresholds.cooldownSec,
      diskEvery: this.#diskEvery,
      thresholds: { ...this.#thresholds }
    }
  }

  /* ----------------------------- 内部实现 ----------------------------- */

  /** 一次采样的全流程。异常一律吞掉并记 warn——感知层不许把宿主搞崩。 */
  #runOnce() {
    try {
      const nowMs = this.#nowMs()
      const raw = this.#takeRaw()
      if (!raw) return null
      const sample = this.#normalize(raw, nowMs)
      if (!sample) return null

      this.#lastSample = sample
      this.#sampleCount++

      // stop 之后（或还没 start）只给值，不发事件
      if (!this.#running) return sample

      this.#emitSafe('sample', sample)

      // 磁盘每 diskEvery 次采样读一次；读不到就传 null，decide 会原样跳过
      let disk = null
      if (this.#diskEvery > 0 && this.#sampleCount % this.#diskEvery === 0) {
        const freeGB = readDiskFreeGB(this.#thresholds.diskPath, { statfsFn: this.#statfsFn })
        if (freeGB !== null) disk = { path: this.#thresholds.diskPath, freeGB }
      }

      const result = decide({
        sample,
        thresholds: this.#thresholds,
        holdN: this.#holdN,
        intervalSec: this.#intervalSec,
        streaks: this.#streaks,
        lastEventAt: this.#lastEventAt,
        nowMs,
        disk
      })
      this.#streaks = result.streaks
      this.#lastEventAt = result.lastEventAt
      for (const event of result.events) this.#emitSafe('event', event)

      return sample
    } catch (error) {
      this.#warn(`采样出错，跳过本次：${errText(error)}`)
      return null
    }
  }

  /** 取一次原始采样；采样器抛错就记一笔然后返回 null */
  #takeRaw() {
    try {
      const raw = this.#sampleFn ? this.#sampleFn() : sampleCheap(this.#lastSample)
      if (raw === undefined) return null
      return raw
    } catch (error) {
      this.#warn(`采样失败，跳过本次：${errText(error)}`)
      return null
    }
  }

  /** 把外部（可能是注入的假采样器）给的东西收敛成固定形状 */
  #normalize(raw, nowMs) {
    if (!raw || typeof raw !== 'object') return null
    const num = (key) => (Number.isFinite(Number(raw[key])) ? Number(raw[key]) : null)
    const totalMem = Math.max(0, pickNumber(raw.totalMem, 0))
    const freeMem = Math.max(0, pickNumber(raw.freeMem, 0))
    let memRatio = num('memRatio')
    // 只给了 free/total 也能算出来，别为难调用方
    if (memRatio === null && totalMem > 0) memRatio = clamp01(1 - freeMem / totalMem)
    return {
      ts: Number.isFinite(num('ts')) ? Number(raw.ts) : nowMs,
      cpuRatio: Number.isFinite(num('cpuRatio')) ? clamp01(num('cpuRatio')) : null,
      memRatio: memRatio === null ? null : clamp01(memRatio),
      freeMem,
      totalMem,
      uptimeSec: Math.max(0, pickNumber(raw.uptimeSec, 0))
    }
  }

  /** 时间函数可能被注入成怪东西，这里兜住 */
  #nowMs() {
    try {
      const value = this.#now()
      const n = Number(value)
      return Number.isFinite(n) ? n : Date.now()
    } catch {
      return Date.now()
    }
  }

  /**
   * 发事件也要防：监听器抛错不能反噬到采样循环里。
   * （EventEmitter 默认会把监听器的异常往上抛，后台模块不能吃这个亏。）
   */
  #emitSafe(type, payload) {
    try {
      this.emit(type, payload)
    } catch (error) {
      this.#warn(`监听器处理 ${type} 时出错：${errText(error)}`)
    }
  }

  /** 日志也防一手：logger 自己坏了不能连累采样 */
  #warn(text) {
    try {
      this.#logger?.warn?.(`[senses] ${text}`)
    } catch {
      // 日志写不出去就算了
    }
  }
}

/**
 * 造一个感知器。默认关——不调 `start()` 就一点动静都没有。
 *
 * @param {object} [options]
 * @param {number} [options.intervalSec=10] 采样间隔（秒）
 * @param {{warn?:Function}} [options.logger] 只需要 warn，鸭子类型即可
 * @param {object} [options.thresholds] 见 DEFAULT_THRESHOLDS（另含 cooldownSec，默认 900）
 * @param {Function} [options.now] 注入时间函数（测试用，返回毫秒）
 * @param {Function} [options.sampleFn] 注入采样函数（测试用）
 * @param {Function} [options.statfsFn] 注入读盘函数（测试用，签名同 fs.statfsSync）
 * @param {number} [options.diskEvery=20] 每多少次采样读一次盘
 * @returns {Senses}
 */
export function createSenses(options = {}) {
  return new Senses(options)
}

export default createSenses
