/**
 * lib/voiceinstall.js —— 语音资产「一键安装」
 *
 * ## 它做什么
 *
 * 用户在侧边栏点一下「一键安装」，这个模块依次完成：
 *   1. 下载 weights 包（约 200 MB，从 GitHub Release）
 *   2. 解压到临时目录
 *   3. 校验关键文件（大小 / 存在）
 *   4. 把权重放到引擎目录的正确位置
 *   5. 把脚本和参考音频放到工作区
 *   6. 写回 voice 配置（scriptPath / ref / model）
 *   7. 清理临时文件
 *
 * ## 它不做什么（重要）
 *
 * **不装引擎本体**（GPT-SoVITS 27 GB，必须用户自己装）。
 * 引擎不在时，这个安装会明确告诉你「先装引擎」，而不是半路失败。
 *
 * ## 为什么要有进度
 *
 * 200 MB 下载 + 220 MB 解压，在慢网下要好几分钟。没有进度反馈，
 * 用户会以为卡死了然后强退——那比没有这个功能更糟。
 * 所以每一步都往状态里写，面板轮询它。
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

/** 语音资产包下载地址（跟仓库改名同步） */
export const ASSETS_URL =
  'https://github.com/1148462398-hub/dsh-elysia-memory/releases/download/voice-assets-v2.7.2/elysia-voice-assets.zip'

/** 包里各文件的落点（相对引擎根目录 或 工作区根目录） */
const LAYOUT = {
  weights: [
    // zip 内路径 → [目标基准, 目标相对路径]
    ['weights/elysia_v5turbo_e12_s2448_l32.pth', 'engine', 'SoVITS_weights_v5turbo/elysia_v5turbo_e12_s2448_l32.pth'],
    ['weights/elysia_v2-e15.ckpt', 'engine', 'GPT_SoVITS/GPT_weights_v2/elysia_v2-e15.ckpt']
  ],
  scripts: [
    ['scripts/elysia_say.py', 'work', 'elysia_say.py'],
    ['scripts/elysia_quality.py', 'work', 'elysia_quality.py'],
    ['scripts/elysia_denoise.py', 'work', 'elysia_denoise.py'],
    ['scripts/elysia_breath_fix3.py', 'work', 'elysia_breath_fix3.py'],
    ['scripts/elysia_timing.py', 'work', 'elysia_timing.py'],
    ['scripts/_timing_lib.py', 'work', '_timing_lib.py']
  ],
  refs: [
    ['refs/elysia_R06_p950.90_d4.9s.wav', 'work', '_game_audio/refs_new/elysia_R06_p950.90_d4.9s.wav']
  ]
}

/** 关键文件的最小体积（字节），用于校验下载是否完整 */
const MIN_BYTES = {
  'weights/elysia_v5turbo_e12_s2448_l32.pth': 60 * 1024 * 1024, // 72 MB
  'weights/elysia_v2-e15.ckpt': 120 * 1024 * 1024, // 148 MB
  'refs/elysia_R06_p950.90_d4.9s.wav': 200 * 1024, // 0.4 MB
  'scripts/elysia_say.py': 10 * 1024
}

/**
 * 创建一个安装任务。状态在闭包里，面板通过 getState() 轮询。
 *
 * @param {object} opts { engineDir, workDir, logger }
 * @returns {{ start: () => Promise<object>, getState: () => object, cancel: () => void }}
 */
export function createInstaller({ engineDir = '', workDir = '', logger = null } = {}) {
  let state = {
    phase: 'idle', // idle | downloading | extracting | verifying | placing | writing | done | failed
    percent: 0,
    message: '',
    detail: '',
    error: '',
    startedAt: 0,
    finishedAt: 0,
    placed: [],
    skipped: []
  }
  let cancelled = false
  let running = false

  const set = (patch) => {
    state = { ...state, ...patch }
  }

  /** worker 目录：安装器自己找工作区 */
  function resolveWorkDir() {
    if (workDir && existsSync(workDir)) return workDir
    // 退而求其次：脚本所在目录的上一级（plugin/lib → plugin → ...）
    return process.cwd()
  }

  /** 用什么解压：优先 tar（Win10+ 自带），退回 Expand-Archive */
  function unzip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      // Windows 自带的 bsdtar 能解 zip
      execFile('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true, timeout: 300000 }, (err) => {
        if (!err) return resolve('tar')
        // 退回 PowerShell
        execFile(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
          ],
          { windowsHide: true, timeout: 300000 },
          (err2) => {
            if (err2) reject(new Error(`解压失败：${err2.message}`))
            else resolve('powershell')
          }
        )
      })
    })
  }

  /** 下载到文件，带进度回调 */
  async function download(url, dest) {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') || 0)
    let received = 0

    // Node 18+ 的 res.body 是 Web ReadableStream
    if (!res.body || typeof res.body.getReader !== 'function') {
      // 兜底：整块读
      const buf = Buffer.from(await res.arrayBuffer())
      await fsp.writeFile(dest, buf)
      return buf.length
    }

    const reader = res.body.getReader()
    const ws = createWriteStream(dest)
    let lastTick = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (cancelled) {
        ws.destroy()
        throw new Error('已取消')
      }
      ws.write(Buffer.from(value))
      received += value.length
      const now = Date.now()
      if (total > 0 && now - lastTick > 300) {
        lastTick = now
        const pct = Math.round((received / total) * 100)
        set({
          percent: Math.min(60, Math.round(pct * 0.6)),
          message: `正在下载语音资产包… ${pct}%`,
          detail: `${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
        })
      }
    }
    await new Promise((r) => ws.end(r))
    return received
  }

  async function run() {
    if (running) return state
    running = true
    cancelled = false
    const startedAt = Date.now()
    set({
      phase: 'downloading',
      percent: 0,
      message: '准备下载…',
      detail: '',
      error: '',
      startedAt,
      finishedAt: 0,
      placed: [],
      skipped: []
    })

    let tmpDir = ''
    try {
      // 0. 前置检查：引擎必须在，否则装了权重也没用
      if (!engineDir || !existsSync(path.join(engineDir, 'api_v2.py'))) {
        throw new Error(
          '还没装 GPT-SoVITS 引擎。一键安装只负责权重和脚本，引擎本体（约 27 GB）需要自己装。' +
            '装好后把「引擎目录」填进配置，再回来点一次。'
        )
      }
      const work = resolveWorkDir()

      // 1. 下载
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'elysia-voice-'))
      const zipPath = path.join(tmpDir, 'assets.zip')
      set({ phase: 'downloading', message: '正在下载语音资产包（约 200 MB）…', percent: 1 })
      const bytes = await download(ASSETS_URL, zipPath)
      if (bytes < 50 * 1024 * 1024) {
        throw new Error(`下载的文件太小（${(bytes / 1048576).toFixed(1)} MB），可能下载不完整`)
      }
      set({ percent: 60, message: '下载完成，正在解压…' })

      // 2. 解压
      set({ phase: 'extracting', percent: 62, message: '正在解压…' })
      const extractDir = path.join(tmpDir, 'out')
      mkdirSync(extractDir, { recursive: true })
      await unzip(zipPath, extractDir)

      // 3. 校验
      set({ phase: 'verifying', percent: 72, message: '正在校验文件…' })
      for (const [rel, minBytes] of Object.entries(MIN_BYTES)) {
        const p = path.join(extractDir, rel)
        if (!existsSync(p)) throw new Error(`包里缺少 ${rel}`)
        const size = statSync(p).size
        if (size < minBytes) {
          throw new Error(`${rel} 体积异常（${(size / 1048576).toFixed(1)} MB），可能损坏`)
        }
      }

      // 4. 放置
      set({ phase: 'placing', percent: 78, message: '正在放置文件…' })
      const placed = []
      const skipped = []
      const all = [...LAYOUT.weights, ...LAYOUT.scripts, ...LAYOUT.refs]
      let i = 0
      for (const [src, base, rel] of all) {
        i++
        const from = path.join(extractDir, src)
        const root = base === 'engine' ? engineDir : work
        const to = path.join(root, rel)
        if (!existsSync(from)) {
          skipped.push(`${src}（包里没有）`)
          continue
        }
        mkdirSync(path.dirname(to), { recursive: true })
        copyFileSync(from, to)
        placed.push(rel)
        set({ percent: 78 + Math.round((i / all.length) * 12), message: `正在放置文件… ${i}/${all.length}` })
      }

      // 5. 写配置
      set({ phase: 'writing', percent: 92, message: '正在写入配置…' })
      const cfgPatch = {
        engineDir,
        scriptPath: path.join(work, 'elysia_say.py'),
        ref: 'R06',
        model: 'v5turbo'
      }

      set({
        phase: 'done',
        percent: 100,
        message: '装好啦',
        detail: `放了 ${placed.length} 个文件${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`,
        finishedAt: Date.now(),
        placed,
        skipped
      })
      logger?.info?.(`语音资产安装完成：${placed.length} 个文件 → ${engineDir}`)
      return { ok: true, ...state, configPatch: cfgPatch }
    } catch (e) {
      const msg = String(e?.message ?? e)
      set({
        phase: cancelled ? 'idle' : 'failed',
        message: cancelled ? '已取消' : '安装失败',
        error: cancelled ? '' : msg,
        finishedAt: Date.now()
      })
      logger?.warn?.(`语音资产安装失败：${msg}`)
      return { ok: false, ...state }
    } finally {
      running = false
      // 清理临时目录（失败也清，别占盘）
      try {
        if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* 清理失败无所谓 */
      }
    }
  }

  return {
    start: run,
    getState: () => ({ ...state, running }),
    cancel: () => {
      cancelled = true
    },
    /** 只看状态不启动（面板首次渲染用） */
    status: () => ({
      url: ASSETS_URL,
      running,
      ...state
    })
  }
}

/**
 * 静态信息：一键安装能装什么、不能装什么。
 * 面板要在按钮旁边说清楚，避免用户以为点一下连引擎也装了。
 */
export const INSTALL_INFO = {
  url: ASSETS_URL,
  size: '约 200 MB',
  contains: [
    'v5turbo SoVITS 权重（72 MB）',
    'GPT 权重（148 MB）',
    '参考音频 R06（0.4 MB）',
    '6 个合成 / 后处理脚本'
  ],
  requires: [
    '已装好的 GPT-SoVITS v5 引擎（约 27 GB，需自己装）',
    'NVIDIA 显卡 + CUDA（A 卡跑不了这套权重）'
  ],
  writes: [
    '权重 → 引擎目录的 SoVITS_weights_v5turbo/ 和 GPT_weights_v2/',
    '脚本与参考音频 → 工作区根目录',
    'voice 配置 → engineDir / scriptPath / model / ref'
  ]
}
