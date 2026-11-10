/**
 * 卫生工作自检：日志轮转 + 音频缓存清理。
 *
 * 起因（都是实测量出来的）：
 *   · voice-debug.log 每轮写一行、没有上限，长到 1.9 MB 还在长；
 *   · _elysia_audio 里 4695 个 wav / 2.9 GB，引擎自己从不清理。
 *
 * 全程在临时目录里跑，不碰真实记忆与真实音频。
 * 用法：node test/housekeeping-smoke.mjs
 */
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { appendCappedLog, pruneAudioDir, humanBytes, LOG_MAX_BYTES } = await import('../lib/housekeeping.js')

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}
const root = path.join(os.tmpdir(), `elysia-housekeep-${Date.now()}`)
await fsp.mkdir(root, { recursive: true })

console.log('1) 日志超过上限就轮转，只留一份 .1，不会无限套娃')
{
  const log = path.join(root, 'voice-debug.log')
  // 每次写 64 KB，写 20 次 = 1.25 MB，必然越过 512 KB
  const chunk = 'x'.repeat(64 * 1024)
  for (let i = 0; i < 20; i++) appendCappedLog(log, chunk)
  const size = (await fsp.stat(log)).size
  check('日志存在', existsSync(log))
  check('当前日志 ≤ 上限', size <= LOG_MAX_BYTES, `${size} > ${LOG_MAX_BYTES}`)
  check('轮转备份存在', existsSync(log + '.1'))
  check('.1 也只有一份（没有 .2）', !existsSync(log + '.2'))
  const backupSize = (await fsp.stat(log + '.1')).size
  check('备份也在合理范围', backupSize <= LOG_MAX_BYTES * 1.1, String(backupSize))
}

console.log('2) 日志写失败不抛异常（只返回 false）')
{
  // 把日志路径指到一个不可能创建的位置
  const bad = process.platform === 'win32' ? path.join('Z:', 'nope', 'x.log') : '/proc/nope/x.log'
  let threw = false
  let ok = true
  try {
    ok = appendCappedLog(bad, 'x')
  } catch {
    threw = true
  }
  check('没有抛异常', threw === false)
  check('返回 false', ok === false)
}

console.log('3) 音频清理：按数量超出的删掉，新的留下')
{
  const dir = path.join(root, 'audio-a')
  await fsp.mkdir(dir, { recursive: true })
  const now = Date.now()
  for (let i = 0; i < 10; i++) {
    const f = path.join(dir, `say_${String(i).padStart(2, '0')}.wav`)
    await fsp.writeFile(f, 'x'.repeat(1000))
    // 第 0 个最旧，第 9 个最新
    const t = new Date(now - (10 - i) * 60_000)
    await fsp.utimes(f, t, t)
  }
  const r = await pruneAudioDir(dir, { keepDays: 0, maxFiles: 4, now })
  check('删了 6 个', r.removed === 6, String(r.removed))
  check('留下 4 个', r.kept === 4, String(r.kept))
  check('最新的还在', existsSync(path.join(dir, 'say_09.wav')))
  check('最旧的没了', !existsSync(path.join(dir, 'say_00.wav')))
  check('释放字节数说得出', r.bytes === 6000, String(r.bytes))
}

console.log('4) 音频清理：按天数过期，且当前正在用的那条永不删')
{
  const dir = path.join(root, 'audio-b')
  await fsp.mkdir(dir, { recursive: true })
  const now = Date.now()
  const old = new Date(now - 30 * 86_400_000)
  for (const name of ['old1.wav', 'old2.wav', 'fresh.wav', 'in_use.wav', 'notes.txt']) {
    const f = path.join(dir, name)
    await fsp.writeFile(f, 'x'.repeat(100))
  }
  await fsp.utimes(path.join(dir, 'old1.wav'), old, old)
  await fsp.utimes(path.join(dir, 'old2.wav'), old, old)
  await fsp.utimes(path.join(dir, 'in_use.wav'), old, old) // 旧的，但正在被播放
  const r = await pruneAudioDir(dir, { keepDays: 7, maxFiles: 100, now, protect: ['in_use.wav'] })
  check('两个过期的删了', !existsSync(path.join(dir, 'old1.wav')) && !existsSync(path.join(dir, 'old2.wav')))
  check('正在用的那个被保住', existsSync(path.join(dir, 'in_use.wav')))
  check('报告里记了 1 个 protected', r.protected === 1, String(r.protected))
  check('新的不受影响', existsSync(path.join(dir, 'fresh.wav')))
  check('非 wav 文件一概不碰', existsSync(path.join(dir, 'notes.txt')))
}

console.log('4b) 按总字节封顶：条数没超但体积超了也要删')
{
  const dir = path.join(root, 'audio-bytes')
  await fsp.mkdir(dir, { recursive: true })
  const now = Date.now()
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, `big_${i}.wav`)
    await fsp.writeFile(f, 'x'.repeat(1024 * 1024)) // 每个 1 MB
    const t2 = new Date(now - (6 - i) * 60_000)
    await fsp.utimes(f, t2, t2)
  }
  const r = await pruneAudioDir(dir, { keepDays: 0, maxFiles: 100, maxBytes: 2_500_000, now })
  check('条数没超（100）也删了', r.removed === 4, 'removed=' + r.removed)
  const left = (await fsp.readdir(dir)).filter((n) => n.endsWith('.wav'))
  check('剩下的不超过预算', left.length === 2, 'left=' + left.length)
  check('留下的是最新的', left.includes('big_5.wav') && left.includes('big_4.wav'), left.join(','))
}

console.log('4c) 非均匀大小：不能「删大的留小的」')
{
  const dir = path.join(root, 'audio-mixed')
  await fsp.mkdir(dir, { recursive: true })
  const now = Date.now()
  // 新 → 旧：1.5MB / 1.0MB / 0.3MB，预算 2MB
  const spec = [
    ['new_big.wav', 1.5],
    ['mid.wav', 1.0],
    ['old_small.wav', 0.3]
  ]
  for (let i = 0; i < spec.length; i++) {
    const [name, mb] = spec[i]
    const f = path.join(dir, name)
    await fsp.writeFile(f, Buffer.alloc(Math.round(mb * 1024 * 1024), 120))
    const t2 = new Date(now - i * 60_000)
    await fsp.utimes(f, t2, t2)
  }
  const r = await pruneAudioDir(dir, { keepDays: 0, maxFiles: 100, maxBytes: 2 * 1024 * 1024, now })
  const left = await fsp.readdir(dir)
  check('最大的新的留下', left.includes('new_big.wav'), left.join(','))
  check('放不下的那个被删', !left.includes('mid.wav'), left.join(','))
  check('更旧的小文件也不会被塞回来', !left.includes('old_small.wav'), left.join(','))
  check('共删 2 个', r.removed === 2, 'removed=' + r.removed)
}

console.log('5) dryRun 只试算不真删')
{
  const dir = path.join(root, 'audio-c')
  await fsp.mkdir(dir, { recursive: true })
  for (let i = 0; i < 5; i++) await fsp.writeFile(path.join(dir, `a${i}.wav`), 'x'.repeat(200))
  const r = await pruneAudioDir(dir, { keepDays: 0, maxFiles: 1, dryRun: true })
  check('报告会删 4 个', r.removed === 4, String(r.removed))
  check('文件一个都没少', (await fsp.readdir(dir)).length === 5, String((await fsp.readdir(dir)).length))
}

console.log('6) 目录不存在时安静返回，不抛')
{
  let ok = false
  try {
    const r = await pruneAudioDir(path.join(root, 'nope'), { keepDays: 7, maxFiles: 10 })
    ok = r.exists === false && r.removed === 0
  } catch {
    ok = false
  }
  check('不存在也不报错', ok)
}

console.log('7) 字节数格式化')
{
  check('KB', humanBytes(2048) === '2.0 KB', humanBytes(2048))
  check('MB', humanBytes(3 * 1024 * 1024) === '3.0 MB', humanBytes(3 * 1024 * 1024))
  check('GB', humanBytes(2.5 * 1024 ** 3) === '2.50 GB', humanBytes(2.5 * 1024 ** 3))
}

await fsp.rm(root, { recursive: true, force: true }).catch(() => {})

console.log('')
if (problems.length) {
  console.log(`housekeeping-smoke: ${problems.length} 项失败`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('housekeeping-smoke: 全部通过')
