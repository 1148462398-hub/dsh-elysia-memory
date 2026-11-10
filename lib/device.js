/**
 * 推理设备选择：CUDA / CPU。
 *
 * 背景：GPT-SoVITS 的 `api_v2.py` **不接受命令行 `--device`**（源码里那行是注释掉的），
 * 设备只能从 `GPT_SoVITS/configs/tts_infer.yaml` 的 `device:` / `is_half:` 读。
 * 所以「换一台没有 N 卡的机器」不是改一个参数就能跑，而是要**派生一份配置**再启动。
 *
 * 实测（Ryzen 7 9800X3D / 16 线程，v5turbo）：CPU 约 1.15× 实时（7.3 秒音频用 8.4 秒），
 * 同一个模型在 RTX 5070 Ti 上是 0.14×。也就是「慢，但完全可用」。
 *
 * ⚠️ 真实引擎的 yaml 是 **CRLF**，处理前必须归一化，否则正则的 `.+$` 吃不到行尾的 `\r`，
 * 替换会静默失败（派生了配置却还是 device: cuda）。
 *
 * 这里只放纯函数，方便直接单测；真正跑 python 探测的部分由调用方注入。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** 可选设备偏好 */
export const DEVICE_CHOICES = ['auto', 'cuda', 'cpu']

/**
 * 把偏好解析成真正要用的设备。
 *
 * `auto` 需要调用方先探测（见 probeTorchDevice），探测结果用 `cudaAvailable` 传进来；
 * 探测不出来（超时、python 不在、没装 torch）一律按 cpu —— 慢总比跑不起来好。
 */
export function resolveDevice(preference, cudaAvailable) {
  const pref = String(preference ?? 'auto').toLowerCase()
  if (pref === 'cpu') return 'cpu'
  if (pref === 'cuda') {
    // 明确要 CUDA 但机器上没有：还是给 cuda，让引擎自己报错，比静默变慢更好排查
    return 'cuda'
  }
  return cudaAvailable === true ? 'cuda' : 'cpu'
}

/** 是不是 CPU 模式（用于提示「会慢一些」） */
export function isCpuDevice(device) {
  return String(device ?? '').toLowerCase() !== 'cuda'
}

/**
 * 从一个 tts_infer.yaml 文本派生出目标设备的配置。
 *
 * 只改 `custom:` 这一段（用户的权重都在这里），其余段（v1/v2 的默认配置）原样保留——
 * 那些段本来就是 cpu，不该被我们动。
 *
 * 返回 `{ text, changed, found }`：
 *   · `found`   —— custom 段里确实有 `device:` 行（说明是 GPT-SoVITS 结构）
 *   · `changed` —— 这次真的改动了行（已经和目标一致时为 false，但配置照样可用）
 */
export function deriveDeviceConfig(yamlText, device) {
  const raw = String(yamlText ?? '')
  if (!raw.trim()) return { text: raw, changed: false, found: false }

  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const src = raw.replace(/\r\n/g, '\n') // 归一化，否则行尾 \r 会让 replace 静默失败

  const wantCuda = String(device ?? '').toLowerCase() === 'cuda'
  const wantDevice = wantCuda ? 'cuda' : 'cpu'
  const wantHalf = wantCuda ? 'true' : 'false'

  let inCustom = false
  let touched = 0
  let found = false
  const out = src.split('\n').map((line) => {
    if (/^custom:\s*$/.test(line)) {
      inCustom = true
      return line
    }
    if (/^[A-Za-z_][\w-]*:\s*$/.test(line)) {
      inCustom = false
      return line
    }
    if (!inCustom) return line
    let next = line
    if (/^\s+device:\s*\S+/.test(line)) {
      found = true
      next = line.replace(/^(\s+device:\s*)\S+.*$/, `$1${wantDevice}`)
    } else if (/^\s+is_half:\s*\S+/.test(line)) {
      next = line.replace(/^(\s+is_half:\s*)\S+.*$/, `$1${wantHalf}`)
    }
    if (next !== line) touched += 1
    return next
  })

  const joined = out.join('\n')
  return {
    text: eol === '\n' ? joined : joined.replace(/\n/g, '\r\n'),
    changed: touched > 0,
    found
  }
}

/** 配置文件路径 */
export function engineConfigPath(engineDir) {
  if (!engineDir) return ''
  return path.join(engineDir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml')
}

/** 派生配置的落盘路径（放在同一个 configs 目录，名字带设备，便于排查） */
export function derivedConfigPath(engineDir, device) {
  if (!engineDir) return ''
  return path.join(engineDir, 'GPT_SoVITS', 'configs', `tts_infer.${device}.yaml`)
}

/**
 * 读引擎原配置并派生出目标设备的配置文本。
 * 引擎目录不在、原配置读不到时返回 `{ ok:false, reason }`。
 */
export function prepareDeviceConfig(engineDir, device) {
  const src = engineConfigPath(engineDir)
  if (!src || !existsSync(src)) {
    return { ok: false, reason: `找不到引擎配置：${src || '(未配置引擎目录)'}`, path: '', text: '' }
  }
  let raw = ''
  try {
    raw = readFileSync(src, 'utf8')
  } catch (error) {
    return { ok: false, reason: `读取引擎配置失败：${error?.message ?? error}`, path: '', text: '' }
  }
  const { text, changed, found } = deriveDeviceConfig(raw, device)
  if (!found) {
    return {
      ok: false,
      reason: '引擎配置里没有 custom.device（可能不是 GPT-SoVITS 结构）',
      path: src,
      text: raw
    }
  }
  // 已经和目标设备一致时 changed=false，但仍然是可以用的配置
  return { ok: true, changed, path: derivedConfigPath(engineDir, device), text, source: src }
}

/** 给 python 探测脚本：能不能用 CUDA */
export const CUDA_PROBE_CODE = 'import torch,sys;sys.stdout.write("cuda" if torch.cuda.is_available() else "cpu")'
