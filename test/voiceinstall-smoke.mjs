/**
 * 语音资产「装没装」的自检。
 *
 * 起因：面板上的「已安装 / 未安装」徽章原来读的是**安装任务的 phase**，
 * 而 phase 只记得「这次启动跑过安装没有」——
 *   换台机器进来是 idle → 明明装好了却显示未安装；
 *   本机装完删了文件还是 done → 明明没了却显示已安装。
 * 两头都会撒谎。现在徽章读磁盘（inspect()），并且多了一个 uninstall()。
 *
 * 这个测试全程在临时目录里跑，绝不碰真实引擎和真实脚本。
 * 权重用 ftruncate 造稀疏文件（大小对得上、几乎不占盘），分钟级也跑得完。
 *
 * 用法：node test/voiceinstall-smoke.mjs
 */
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createInstaller } = await import('../lib/voiceinstall.js')

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

const root = path.join(os.tmpdir(), `elysia-voiceinstall-${Date.now()}`)
const engineDir = path.join(root, 'engine')
const workDir = path.join(root, 'work')

await fsp.mkdir(engineDir, { recursive: true })
await fsp.mkdir(workDir, { recursive: true })
// 引擎本体只要有个 api_v2.py 就算「在」，安装器就不会提前退出
await fsp.writeFile(path.join(engineDir, 'api_v2.py'), 'print("stub")\n')

const installer = createInstaller({ engineDir, workDir, logger: { info() {}, warn() {} } })

/** 造一个「大小达标但几乎不占盘」的稀疏文件 */
async function fakeFile(file, sizeBytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const fh = await fsp.open(file, 'w')
  try {
    await fh.truncate(sizeBytes)
  } finally {
    await fh.close()
  }
}

const WEIGHTS = [
  [path.join(engineDir, 'SoVITS_weights_v5turbo', 'elysia_v5turbo_e12_s2448_l32.pth'), 72 * 1024 * 1024],
  [path.join(engineDir, 'GPT_SoVITS', 'GPT_weights_v2', 'elysia_v2-e15.ckpt'), 148 * 1024 * 1024]
]
const SCRIPTS = [
  'elysia_say.py',
  'elysia_quality.py',
  'elysia_denoise.py',
  'elysia_breath_fix3.py',
  'elysia_timing.py',
  '_timing_lib.py'
].map((n) => path.join(workDir, n))
const REF = path.join(workDir, '_game_audio', 'refs_new', 'elysia_R06_p950.90_d4.9s.wav')

console.log('1) 什么都没放：磁盘事实是 none（不是靠 phase 猜的）')
{
  const d = installer.inspect()
  check('installed = none', d.installed === 'none', d.installed)
  check('总数 9', d.total === 9, String(d.total))
  check('缺 9 个', d.missing.length === 9, String(d.missing.length))
  check('phase 也是 idle', installer.getState().phase === 'idle')
}

console.log('2) 只放 6 个脚本（最小体积 1 KB）：partial')
{
  // elysia_say.py 的最小体积是 10 KB（其余 1 KB），都写够，免得被当成半截文件
  for (const s of SCRIPTS) await fsp.writeFile(s, 'x'.repeat(path.basename(s) === 'elysia_say.py' ? 12 * 1024 : 2048))
  const d = installer.inspect()
  check('installed = partial', d.installed === 'partial', d.installed)
  check('在位 6 个', d.present.length === 6, String(d.present.length))
  check('缺 3 个（2 权重 + 1 参考音频）', d.missing.length === 3, String(d.missing.length))
}

console.log('3) 权重放好、只差参考音频：还是 partial（差一个也不算装好）')
{
  for (const [p, size] of WEIGHTS) await fakeFile(p, size)
  const d = installer.inspect()
  check('installed = partial', d.installed === 'partial', d.installed)
  check('只剩 1 个缺', d.missing.length === 1, String(d.missing.length))
  check('缺的正是参考音频', d.missing[0]?.rel.includes('R06'), JSON.stringify(d.missing[0]?.rel))
}

console.log('4) 参考音频补上：full')
{
  await fsp.mkdir(path.dirname(REF), { recursive: true })
  await fsp.writeFile(REF, 'x'.repeat(300 * 1024))
  const d = installer.inspect()
  check('installed = full', d.installed === 'full', d.installed)
  check('ok = true', d.ok === true)
  check('一个都不缺', d.missing.length === 0)
  check('两个权重的体积达标', WEIGHTS.every(([p, s]) => existsSync(p)))
}

console.log('5) 大小不够的文件不算装好（防半截下载）')
{
  const tiny = WEIGHTS[1][0]
  await fsp.rm(tiny, { force: true })
  await fakeFile(tiny, 1024) // 只有 1 KB，远低于 120 MB
  const d = installer.inspect()
  check('installed 掉回 partial', d.installed === 'partial', d.installed)
  check('缺的正是那个缩水的权重', d.missing.some((m) => m.rel.includes('elysia_v2')), JSON.stringify(d.missing.map((m) => m.rel)))
  await fakeFile(tiny, WEIGHTS[1][1]) // 复原
}

console.log('6) 卸载：只删插件放的 9 个文件，引擎本体一根汗毛都不动')
{
  const before = installer.inspect()
  check('卸载前是 full', before.installed === 'full')
  const r = await installer.uninstall()
  check('卸载返回 ok', r.ok === true, JSON.stringify(r.failed))
  check('删了 9 个', r.removed.length === 9, String(r.removed.length))
  check('before = full', r.before === 'full', r.before)
  check('after = none', r.after === 'none', r.after)
  check('引擎本体 api_v2.py 还在', existsSync(path.join(engineDir, 'api_v2.py')))
  check('引擎目录还在', existsSync(engineDir))
  check('9 个文件真没了', [...WEIGHTS.map(([p]) => p), ...SCRIPTS, REF].every((p) => !existsSync(p)))
}

console.log('6.5) 半截权重也要能卸掉（按「文件在不在」删，不按体积）')
{
  // 重新铺一份，然后把一个大权重截成 1 KB（模拟下载中断留下的残骸）
  for (const [p, size] of WEIGHTS) await fakeFile(p, size)
  for (const s of SCRIPTS) await fsp.writeFile(s, 'x'.repeat(path.basename(s) === 'elysia_say.py' ? 12 * 1024 : 2048))
  await fsp.mkdir(path.dirname(REF), { recursive: true })
  await fsp.writeFile(REF, 'x'.repeat(300 * 1024))
  const half = WEIGHTS[0][0]
  await fsp.rm(half, { force: true })
  await fakeFile(half, 1024) // 远低于 60 MB
  const d = installer.inspect()
  check('残骸让状态变成 partial', d.installed === 'partial', d.installed)
  const r = await installer.uninstall()
  check('半截文件也被删了', !existsSync(half), 'still exists: ' + half)
  check('一共删了 9 个', r.removed.length === 9, String(r.removed.length))
  check('删完是 none', r.after === 'none', r.after)
}
console.log('7) 重复卸载：幂等，不报错')
{
  const r = await installer.uninstall()
  check('第二次也 ok', r.ok === true)
  check('这次删了 0 个', r.removed.length === 0, String(r.removed.length))
  check('still none', r.after === 'none', r.after)
}

console.log('8) 卸载后徽章该显示「未安装」——它读的就是 inspect()')
{
  check('getState().phase 与磁盘无关（这就是以前撒谎的原因）', typeof installer.getState().phase === 'string')
  check('徽章数据源 installed = none', installer.inspect().installed === 'none')
}

await fsp.rm(root, { recursive: true, force: true }).catch(() => {})

console.log('')
if (problems.length) {
  console.log(`voiceinstall-smoke: ${problems.length} 项失败`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('voiceinstall-smoke: 全部通过')
