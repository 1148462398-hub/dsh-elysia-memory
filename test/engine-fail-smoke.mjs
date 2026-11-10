/**
 * 引擎启动的「失败路径」自检。
 *
 * 起因：第三轮审查发现 `ensureEngine` 里 `spawn(py, …)` 之后**没有挂 `'error'` 监听**。
 * Node 的 spawn 失败是异步事件，没有监听器时会被当成未捕获异常抛出去，
 * 直接把宿主（DSH 主进程）带走。触发条件很普通：机器上 python 不在 PATH，
 * 或者 pythonPath 指到了目录 / 不可执行文件。
 *
 * 这个测试就是盯这条：**引擎起不来只能返回失败，绝不能让进程退出**。
 *
 * 用法：node test/engine-fail-smoke.mjs
 */
import { promises as fsp } from 'node:fs'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { ensureEngine } = await import('../lib/voice.js')

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

const root = path.join(os.tmpdir(), `elysia-enginefail-${Date.now()}`)
const engineDir = path.join(root, 'engine')
mkdirSync(path.join(engineDir, 'GPT_SoVITS', 'configs'), { recursive: true })
// 放一份最小的、结构正确的引擎配置，让流程能走到 spawn
await fsp.writeFile(
  path.join(engineDir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'),
  'custom:\n  device: cuda\n  is_half: true\n  version: v5turbo\n',
  'utf8'
)

// 一个肯定没人监听的端口：连接会被立刻拒绝，不会让 engineAlive 等满超时
const DEAD_URL = 'http://127.0.0.1:19999'
const logs = []
const logger = {
  info: (m) => logs.push(['info', m]),
  warn: (m) => logs.push(['warn', m])
}

console.log('1) python 根本不存在（不带路径分隔符 → 交给 spawn 去报错）')
{
  let threw = false
  let r = null
  try {
    r = await ensureEngine(
      {
        engineUrl: DEAD_URL,
        engineDir,
        pythonPath: 'dsh-definitely-not-a-real-python-xyz',
        device: 'cpu',
        timeoutMs: 5000
      },
      logger
    )
  } catch (e) {
    threw = true
    console.log('    抛出来了：' + e.message)
  }
  check('没有抛异常（进程还活着）', threw === false)
  check('返回了 alive:false', r && r.alive === false, JSON.stringify(r))
  check('带上了失败原因', Boolean(r && r.reason), r && r.reason)
  check('reason 里能看到 spawn 失败', /启动失败|ENOENT|找不到/i.test(String(r && r.reason)), r && r.reason)
}

console.log('2) 明确给了不存在的 python 路径 → 提前返回，不去 spawn')
{
  const r = await ensureEngine(
    {
      engineUrl: DEAD_URL,
      engineDir,
      pythonPath: path.join(root, 'nope', 'python.exe'),
      device: 'cpu',
      timeoutMs: 5000
    },
    logger
  )
  check('alive:false', r.alive === false)
  check('提示 Python 不存在', /Python 不存在/.test(String(r.reason)), r.reason)
}

console.log('3) engineUrl 写错（漏了 http://）→ 返回原因，不抛')
{
  let threw = false
  let r = null
  try {
    r = await ensureEngine(
      { engineUrl: '127.0.0.1:9880', engineDir, pythonPath: 'python', device: 'cpu', timeoutMs: 1000 },
      logger
    )
  } catch (e) {
    threw = true
  }
  check('没有抛异常', threw === false)
  check('返回 alive:false', r && r.alive === false, JSON.stringify(r))
}

console.log('4) 引擎目录不存在 → 直接说明，不尝试启动')
{
  const r = await ensureEngine({ engineUrl: DEAD_URL, engineDir: path.join(root, 'nope'), device: 'cpu' }, logger)
  check('alive:false', r.alive === false)
  check('提示目录不存在', /引擎目录不存在/.test(String(r.reason)), r.reason)
}

await fsp.rm(root, { recursive: true, force: true }).catch(() => {})

console.log('')
if (problems.length) {
  console.log(`engine-fail-smoke: ${problems.length} 项失败`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('engine-fail-smoke: 全部通过')
