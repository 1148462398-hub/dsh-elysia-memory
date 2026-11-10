/**
 * 推理设备选择自检：auto / cuda / cpu，以及「派生 yaml」这条唯一可行的路。
 *
 * 背景：`api_v2.py` 里 `# device = args.device` 是注释掉的，设备只从
 * `GPT_SoVITS/configs/tts_infer.yaml` 读。所以「换一台没 N 卡 / A 卡的机器」
 * 必须派生一份 `tts_infer.<device>.yaml` 再用 `-c` 启动。
 *
 * 全程在临时目录里跑，不碰真实引擎。
 * 用法：node test/device-smoke.mjs
 */
import { promises as fsp } from 'node:fs'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const {
  resolveDevice,
  deriveDeviceConfig,
  prepareDeviceConfig,
  isCpuDevice,
  derivedConfigPath,
  engineConfigPath,
  DEVICE_CHOICES
} = await import('../lib/device.js')

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}
const root = path.join(os.tmpdir(), `elysia-device-${Date.now()}`)

const YAML = `custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  device: cuda
  is_half: true
  t2s_weights_path: D:/tts/weights/elysia.ckpt
  version: v5turbo
v1:
  device: cpu
  is_half: false
v2:
  device: cpu
  is_half: false
`

console.log('1) auto：有 CUDA 用 cuda，没有就用 cpu')
{
  check('auto + 有卡 → cuda', resolveDevice('auto', true) === 'cuda')
  check('auto + 没卡 → cpu', resolveDevice('auto', false) === 'cpu')
  check('auto + 探测失败(undefined) → cpu', resolveDevice('auto', undefined) === 'cpu')
  check('显式 cpu → cpu', resolveDevice('cpu', true) === 'cpu')
  check('显式 cuda → cuda（哪怕没探测到，让引擎自己报错更好排查）', resolveDevice('cuda', false) === 'cuda')
  check('空值当作 auto', resolveDevice('', false) === 'cpu' && resolveDevice(undefined, true) === 'cuda')
  check('三个可选值', DEVICE_CHOICES.join(',') === 'auto,cuda,cpu')
}

console.log('2) 派生配置：只动 custom 段，别的段原样')
{
  const cpu = deriveDeviceConfig(YAML, 'cpu')
  check('返回 changed', cpu.changed === true)
  check('custom.device 变 cpu', /custom:[\s\S]*?\n\s+device: cpu/m.test(cpu.text), cpu.text.slice(0, 120))
  check('custom.is_half 变 false', /custom:[\s\S]*?\n\s+is_half: false/m.test(cpu.text))
  check('权重路径没被动', cpu.text.includes('D:/tts/weights/elysia.ckpt'))
  check('v1 段还是 cpu（本来就没变）', cpu.text.includes('v1:\n  device: cpu'))
  check('行数不变', cpu.text.split('\n').length === YAML.split('\n').length)

  const cuda = deriveDeviceConfig(YAML, 'cuda')
  check('cuda：device 回到 cuda', /custom:[\s\S]*?\n\s+device: cuda/m.test(cuda.text))
  check('cuda：is_half 回到 true', /custom:[\s\S]*?\n\s+is_half: true/m.test(cuda.text))

  const broken = deriveDeviceConfig('# 这不是 GPT-SoVITS 配置\nfoo: bar\n', 'cpu')
  check('不认识的配置不硬改', broken.changed === false && broken.found === false)
  const empty = deriveDeviceConfig('', 'cpu')
  check('空文本不炸', empty.changed === false && empty.text === '' && empty.found === false)
}

console.log('2b) CRLF 的配置也能改（真实引擎就是 CRLF）')
{
  const crlf = YAML.replace(/\n/g, '\r\n')
  const r = deriveDeviceConfig(crlf, 'cpu')
  check('CRLF: changed=true', r.changed === true, String(r.changed))
  check('CRLF: device 变 cpu', /custom:[\s\S]*?device: cpu/.test(r.text.replace(/\r/g, '')))
  check('CRLF: 仍保持 CRLF', r.text.includes('\r\n'))
  check('CRLF: 行数一致', r.text.split('\r\n').length === crlf.split('\r\n').length)
}

console.log('3) isCpuDevice：除了 cuda 都算慢')
{
  check('cuda 不算 cpu', isCpuDevice('cuda') === false)
  check('cpu 算', isCpuDevice('cpu') === true)
  check('空值算 cpu', isCpuDevice('') === true)
}

console.log('4) prepareDeviceConfig：读引擎配置并给出派生路径')
{
  const engineDir = path.join(root, 'engine')
  mkdirSync(path.join(engineDir, 'GPT_SoVITS', 'configs'), { recursive: true })
  writeFileSync(engineConfigPath(engineDir), YAML, 'utf8')

  const r = prepareDeviceConfig(engineDir, 'cpu')
  check('ok', r.ok === true, r.reason)
  check('派生路径带设备名', r.path === derivedConfigPath(engineDir, 'cpu'), r.path)
  check('派生路径在 configs 下', r.path.includes('configs') && r.path.endsWith('tts_infer.cpu.yaml'), r.path)
  check('文本里是 cpu', /custom:[\s\S]*?\n\s+device: cpu/m.test(r.text))

  const missing = prepareDeviceConfig(path.join(root, 'nope'), 'cpu')
  check('引擎目录不存在时给出原因', missing.ok === false && Boolean(missing.reason), missing.reason)
}

console.log('5) 派生文件可以落盘并重新读回')
{
  const engineDir = path.join(root, 'engine')
  const r = prepareDeviceConfig(engineDir, 'cpu')
  writeFileSync(r.path, r.text, 'utf8')
  check('文件已生成', existsSync(r.path))
  const again = prepareDeviceConfig(engineDir, 'cuda')
  check('再派生 cuda 也能过（已经一致时 changed=false 但仍可用）', again.ok === true && again.changed === false)
  check('cuda 文本里 device 是 cuda', /custom:[\s\S]*?\n\s+device: cuda/m.test(again.text))
}

await fsp.rm(root, { recursive: true, force: true }).catch(() => {})

console.log('')
if (problems.length) {
  console.log(`device-smoke: ${problems.length} 项失败`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('device-smoke: 全部通过')
