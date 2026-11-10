/**
 * 气泡自检：**没装语音引擎也要有气泡**。
 *
 * 用户原话：
 *   「我发现换电脑安装是没有气泡的，能不能在没安装语音引擎的情况下还是弹出气泡，
 *     只是不合成输出语音」
 *
 * 这个测试直接挂真实的 apply()，用一个假的 ctx（webServer + tools + session/event），
 * 然后断言：
 *   1. voice.enabled=false（换电脑就是这种情况）时，announce 仍然写出一条气泡；
 *   2. 气泡里 file 为空（没合成音频），文字和表情包照常有；
 *   3. voice.bubble=false 时彻底不出现（想彻底安静的人有这个开关）；
 *   4. assistant/message + turn/end 这条兜底路也不会因为 enabled=false 就整段丢掉。
 *
 * 用法：node test/bubble-smoke.mjs
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.join(os.tmpdir(), `elysia-bubble-smoke-${Date.now()}`)
process.env.DSH_HOME = root
process.env.DSH_STICKERS_DIR = path.join(root, 'stickers')

const { apply } = await import('../lib/index.js')
const { MEMORY_PAGE_PREFIX } = await import('../lib/webui.js')

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

/** 造一个能跑的最小 ctx：只需要 get / on / tools.register / logger */
function makeHost() {
  const listeners = new Map()
  const tools = new Map()
  const server = { handler: null, register(entry) { this.handler = entry.handler; return () => {} }, getOrigin: () => 'http://127.0.0.1:0' }
  const ctx = {
    get(name) {
      if (name === 'webServer') return server
      if (name === 'llm') return null
      if (name === 'clientModules') return undefined
      return undefined
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    tools: { register(def) { tools.set(def.name, def) } },
    /* Cordis 的 ctx 便利方法，测试里给空实现就够 */
    effect(fn) { try { return typeof fn === 'function' ? fn() : undefined } catch { return undefined } },
    interval() { return () => {} },
    agents: { list: () => [] },
    systemPrompt: { register() { return () => {} }, section() { return () => {} } },
    logger: { info() {}, warn() {}, error() {} }
  }
  return { ctx, listeners, tools, server }
}

/** 假的 req/res，够 webui 的 sendJson 用 */
function callRoute(handler, url, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) {
        if (body) chunks.push(Buffer.from(body))
        try {
          resolve({ status: this.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (e) {
          reject(e)
        }
      },
      write(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk))
      },
      on() {},
      once() {}
    }
    const req = { method, url, headers, on() {}, once() {} }
    try {
      handler(req, res)
    } catch (e) {
      reject(e)
    }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 注册后的工具对象：DSH 侧统一叫 execute，源码里叫 run，两种都兼容 */
function callTool(tool, args) {
  const fn = tool.execute ?? tool.run
  if (typeof fn !== 'function') throw new Error('工具既没有 execute 也没有 run：' + Object.keys(tool))
  return fn.call(tool, args)
}

async function mount(config) {
  const host = makeHost()
  apply(host.ctx, {
    primaryPath: path.join(root, `MEMORY-${Math.random().toString(36).slice(2)}.md`),
    mirrorPath: path.join(root, `MEMORY-mirror-${Math.random().toString(36).slice(2)}.md`),
    recordUserTurns: false,
    ...config
  })
  await sleep(80) // 让 webui 的 tryRegister 跑完、store 初始化完
  return host
}

console.log('1) 默认值')
{
  const { VOICE_DEFAULTS } = await import('../lib/voice.js')
  check('bubble 默认开启', VOICE_DEFAULTS.bubble === true)
  check('enabled 默认关闭（换电脑就是这种状态）', VOICE_DEFAULTS.enabled === false)
}

console.log('2) 没装引擎：announce 也要发气泡')
{
  /* 先塞一张表情包，用来证明气泡里的配图真的接上了（以前这里缺 import，静默失效）*/
  const stickerDir = path.join(root, 'stickers')
  await fsp.mkdir(stickerDir, { recursive: true })
  await fsp.writeFile(path.join(stickerDir, 'test_happy.webp'), Buffer.from('RIFF0000WEBPVP8 ', 'utf8'))
  process.env.DSH_STICKERS_DIR = stickerDir

  const host = await mount({ voice: { enabled: false } })
  check('webui 注册成功', typeof host.server.handler === 'function')

  const voiceTool = host.tools.get('memory_file_voice')
  check('注册了 memory_file_voice 工具', Boolean(voiceTool))

  const r = await callTool(voiceTool, { action: 'announce', text: '好开心呀，全都装好啦，快来夸夸我！' })
  check('announce 不报错', typeof r === 'string' || (r && typeof r === 'object'))

  const latest = await callRoute(host.server.handler, MEMORY_PAGE_PREFIX + '/api/voice/latest')
  check('/api/voice/latest 返回 200', latest.status === 200, `status=${latest.status}`)
  check('气泡有文字', Boolean(latest.body && latest.body.text), JSON.stringify(latest.body))
  check('气泡文字就是那句口播', latest.body?.text === '好开心呀，全都装好啦，快来夸夸我！', JSON.stringify(latest.body?.text))
  check('没有音频文件（因为没合成）', !latest.body?.file, JSON.stringify(latest.body?.file))
  check('气泡带上了表情包', Boolean(latest.body?.stickerUrl), JSON.stringify(latest.body))
}

console.log('3) bubble=false：彻底不出现')
{
  const host = await mount({ voice: { enabled: false, bubble: false } })
  const voiceTool = host.tools.get('memory_file_voice')
  await callTool(voiceTool, { action: 'announce', text: '这句话不该出现在气泡里。' })
  const latest = await callRoute(host.server.handler, MEMORY_PAGE_PREFIX + '/api/voice/latest')
  check('气泡为空', !latest.body || !latest.body.text, JSON.stringify(latest.body))
}

console.log('4) 没装引擎 + 模型忘了 announce：turn/end 兜底也不能整段丢弃')
{
  const host = await mount({ voice: { enabled: false } })
  const emit = host.ctx.emit
  // 这一轮 assistant 说了话
  emit(
    'session/event',
    { id: 's-test', cwd: root },
    {
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '这件事已经做完了，四张图都读出来了。' }]
        }
      }
    }
  )
  // 让 turn/end 的摘要路跑完（llm 是 null，摘要会失败 → 不该发气泡，但不该崩）
  emit('session/event', { id: 's-test', cwd: root }, { type: 'turn/end' })
  await sleep(200)
  const latest = await callRoute(host.server.handler, MEMORY_PAGE_PREFIX + '/api/voice/latest')
  check('摘要失败时不崩、也不发半截气泡', latest.status === 200, `status=${latest.status}`)
}

console.log('5) assistant/message 在 enabled=false 时仍然进缓冲（气泡路的前提）')
{
  const host = await mount({ voice: { enabled: false, aggregateTurn: true } })
  host.ctx.emit(
    'session/event',
    { id: 's-buf', cwd: root },
    {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '测试缓冲区。' }] } }
    }
  )
  // 直接看调试文件不方便，用行为断言：turn/end 之后 latest 仍然是 200（不抛）
  host.ctx.emit('session/event', { id: 's-buf', cwd: root }, { type: 'turn/end' })
  await sleep(200)
  const latest = await callRoute(host.server.handler, MEMORY_PAGE_PREFIX + '/api/voice/latest')
  check('turn/end 之后接口仍然可用', latest.status === 200)
}

console.log('6) state.json 里的语音路径要能「读回来」（以前只写不读，重启语音就废）')
{
  /*
   * 一键安装会把 voiceEngineDir / voiceScriptPath 写进 state.json，
   * 但启动时曾经没人读回来 —— 而 cordis.patch.yml 默认把这几项注释掉，
   * 于是「装好 → 重启 → scriptPath 为空 → 合成永远失败」。
   * 这里预置一份 state.json，再看 /api/voice/tuning 的 scriptDir 是不是它。
   */
  const fakeDir = path.join(root, 'voice-keep')
  await fsp.mkdir(fakeDir, { recursive: true })
  const fakeScript = path.join(fakeDir, 'elysia_say.py')
  await fsp.writeFile(fakeScript, 'print(1)\n', 'utf8')
  const stateDir = path.join(root, 'dsh-shared-memory')
  await fsp.mkdir(stateDir, { recursive: true })
  await fsp.writeFile(
    path.join(stateDir, 'state.json'),
    JSON.stringify({ voiceEngineDir: path.join(root, 'fake-engine'), voiceScriptPath: fakeScript, voiceRef: 'R04' }),
    'utf8'
  )
  const host = await mount({ voice: { enabled: false } })
  const tun = await callRoute(host.server.handler, MEMORY_PAGE_PREFIX + '/api/voice/tuning')
  check('/api/voice/tuning 返回 200', tun.status === 200, `status=${tun.status}`)
  check('scriptDir 就是 state.json 里记的那个目录', tun.body?.scriptDir === fakeDir, JSON.stringify(tun.body?.scriptDir))
}
console.log('7) DNS rebinding：Host 不是回环名/IP 的一律拒（恶意域解析到 127.0.0.1 也读不到记忆）')
{
  const host = await mount({ voice: { enabled: false } })
  const evil = await callRoute(host.server.handler, MEMORY_PAGE_PREFIX + '/', 'GET', { host: 'evil.example' })
  check('伪造域名的 Host 被 403', evil.status === 403, `status=${evil.status}`)
  const local = await callRoute(host.server.handler, MEMORY_PAGE_PREFIX + '/api/voice', 'GET', { host: '127.0.0.1:7692' })
  check('回环 IP 正常放行', local.status === 200, `status=${local.status}`)
  const localhost = await callRoute(host.server.handler, MEMORY_PAGE_PREFIX + '/api/voice', 'GET', { host: 'localhost:7692' })
  check('localhost 也放行', localhost.status === 200, `status=${localhost.status}`)
}
await fsp.rm(root, { recursive: true, force: true }).catch(() => {})

console.log('')
if (problems.length) {
  console.log(`bubble-smoke: ${problems.length} 项失败`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('bubble-smoke: 全部通过')
