/**
 * 卫生工作：日志轮转 + 合成音频缓存清理。
 *
 * 起因：这个插件自己会越长越大，而且长得没声音——
 *   · `voice-debug.log` 每轮对话写一行，没有上限（实测长到 1.9 MB 还在长）；
 *   · 合成引擎把每个 wav 都堆在 `_elysia_audio/` 里，从不清理
 *     （实测 4695 个文件 / 2.9 GB，最早那个是一周前的）。
 *
 * 这里只放纯函数，不依赖 Cordis，方便直接单测。
 */
import { promises as fsp } from 'node:fs'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

/** 日志上限：超过就轮转成 `.1`（只留一份旧的，不会无限套娃） */
export const LOG_MAX_BYTES = 512 * 1024

/**
 * 带轮转的追加。永不抛异常——日志写失败不能影响任何主流程。
 * 返回是否写成功，方便测试断言。
 */
export function appendCappedLog(file, text, maxBytes = LOG_MAX_BYTES) {
  const body = String(text ?? '')
  if (!file || !body) return false
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      size = 0
    }
    if (size > 0 && size + body.length > maxBytes) {
      const backup = file + '.1'
      // Windows 的 rename 不会覆盖已存在的目标，先删再改名
      try {
        rmSync(backup, { force: true })
      } catch {
        /* 删不掉就换个名字也不必：下面 rename 失败会走 catch */
      }
      try {
        renameSync(file, backup)
      } catch {
        /* 改名失败（被占用）时退化成截断，避免它继续无限长 */
        try {
          rmSync(file, { force: true })
        } catch {
          /* 彻底没辙就让这次写入失败，下次再试 */
        }
      }
    }
    appendFileSync(file, body, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 清理某目录下的合成音频。
 *
 * 两条规则取并集：
 *   · 超过 `keepDays` 天的删；
 *   · 排在前 `maxFiles` 名之外的删（按修改时间，新的留下）。
 *
 * `protect` 里列出的文件名永不删除（比如当前气泡正在引用的那一条）。
 * 只碰 `.wav`，其它文件一概不管。
 * keepDays <= 0 表示「不按天数删」；maxFiles < 0 表示「不按数量删」。
 */
export async function pruneAudioDir(dir, options = {}) {
  const keepDays = Number(options.keepDays ?? 7)
  const maxFiles = Number(options.maxFiles ?? 400)
  const now = Number(options.now ?? Date.now())
  const dryRun = Boolean(options.dryRun)
  const protect = new Set((options.protect ?? []).map((n) => String(n).toLowerCase()))

  const out = { dir, scanned: 0, removed: 0, bytes: 0, kept: 0, protected: 0, exists: false }
  if (!dir) return out

  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return out
  }
  out.exists = true

  const wavs = []
  for (const name of names) {
    if (!/\.wav$/i.test(name)) continue
    if (protect.has(name.toLowerCase())) {
      out.protected++
      continue
    }
    const full = path.join(dir, name)
    try {
      const st = await fsp.stat(full)
      if (!st.isFile()) continue
      wavs.push({ full, name, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* 读不到就跳过 */
    }
  }
  out.scanned = wavs.length

  // 新的在前
  wavs.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const keepMs = keepDays > 0 ? keepDays * 86_400_000 : 0
  const limit = maxFiles >= 0 ? maxFiles : Infinity
  const victims = []
  wavs.forEach((item, index) => {
    const tooOld = keepMs > 0 && now - item.mtimeMs > keepMs
    const tooMany = index >= limit
    if (tooOld || tooMany) victims.push(item)
  })

  for (const item of victims) {
    out.removed++
    out.bytes += item.size
    if (dryRun) continue
    try {
      await fsp.unlink(item.full)
    } catch {
      out.removed--
      out.bytes -= item.size
    }
  }
  out.kept = out.scanned - out.removed
  return out
}

/** 人类可读的字节数 */
export function humanBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}
