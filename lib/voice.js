/**
 * DSH-elysia / voice.js —— 语音朗读（可选功能）
 *
 * ## 它做什么
 *
 * 把助手这一轮的回复文本，交给本机的 GPT-SoVITS 引擎合成成语音，
 * 再由宿主播放。用户听得到「她」说话，而不只是读到。
 *
 * ## 为什么默认关闭
 *
 * 语音需要三样外部条件同时就绪：
 *   1. 本机装了 GPT-SoVITS 引擎（`D:\tts\GPT-SoVITS-*`）
 *   2. 引擎在 9880 端口跑着
 *   3. 有可用的参考音频
 * 换一台机器这些都不在。**插件本身要能干净地跑，语音是加装的皮肤。**
 * 所以 `voice.enabled` 默认 `false`，用户主动打开才生效。
 *
 * ## 为什么不在这里合成
 *
 * GPT-SoVITS 是 Python 栈（torch + CUDA + 一堆模型权重）。
 * 插件是纯 JS，不装任何 Python 依赖、不 import 任何第三方包。
 * 所以这里只做三件事：**预处理文本 → 起子进程调引擎 → 交回音频路径**。
 *
 * ## 静音失败
 *
 * 语音是锦上添花。引擎没起来、权重缺失、显存不够 —— 任何一种都不该
 * 让对话本身出错。所有失败都只记日志，静默降级成"这轮不出声"。
 */

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CUDA_PROBE_CODE, isCpuDevice, prepareDeviceConfig, resolveDevice } from './device.js'

/** 默认引擎地址与权重（用户可在配置里覆盖） */
export const VOICE_DEFAULTS = {
  /**
   * 是否**合成并播放**语音。默认关闭 —— 依赖本机装好 GPT-SoVITS。
   */
  enabled: false,
  /**
   * 气泡（头像 + 文字 + 表情包那一条「微信消息」）是否显示。**和引擎无关**。
   *
   * 换一台没装引擎的电脑时 enabled 仍是 false、引擎也连不上，
   * 但用户要的是「爱莉希雅照样发一条消息，只是不出声」。
   * 所以气泡单独一个开关，默认开；想彻底安静才关掉它。
   */
  bubble: true,
  engineUrl: 'http://127.0.0.1:9880',
  /** GPT-SoVITS 引擎根目录（里面有 api_v2.py）；留空 = 不自动拉起 */
  engineDir: '',
  /**
   * 推理设备：auto（有 CUDA 就用，没有就 CPU）/ cuda / cpu。
   *
   * 为什么需要它：`api_v2.py` 不接受 `--device`，设备只能从
   * `GPT_SoVITS/configs/tts_infer.yaml` 读，所以换机器要派生一份配置。
   * 实测 CPU 约 1.15× 实时（能聊，就是慢）。
   */
  device: 'auto',
  pythonPath: '',
  scriptPath: '',
  /** 跑 elysia_say.py 的 Python（需要 numpy/scipy，不需要 torch）*/
  sayPythonPath: '',
  model: 'v5turbo',
  ref: 'R06',
  speed: 1.0,
  /** 音量增益（dB）。0 = 不调；+6 约两倍响，-6 约一半。只改波形幅度，不动系统音量 */
  volume: 0,
  /** 少于这么多字不朗读（"好的"「嗯」这种没必要出声） */
  /**
   * 合成音频缓存保留天数。引擎每合成一句就在 `_elysia_audio/` 留一个 wav，
   * 自己不会清；插件按这两条自动清理（启动后一次 + 每 6 小时）。
   * `audioKeepDays: 0` 表示不按天数删。
   */
  audioKeepDays: 7,
  /**
   * 合成音频缓存最多保留多少个。`-1` 表示不按数量删。
   */
  audioMaxFiles: 400,
  /**
   * 合成音频缓存的总字节上限（默认 300 MB）。0 = 不限。
   * 只按条数限不住磁盘：400 个文件实测 371 MB。
   */
  audioMaxBytes: 300 * 1024 * 1024,
  minChars: 4,
  /** 超过这么多字截断（长报告念起来很折磨） */
  maxChars: 1200,
  /** 两次朗读之间的最小间隔，毫秒 */
  cooldownMs: 800,
  /** 是否朗读代码块之外的部分 */
  stripCodeBlocks: true,
  /**
   * 英文 → 中文音译：合成前把正文里的常见英文词/缩写换成中文音译。
   *
   * 本机爱莉希雅 TTS 训练语料几乎 100% 中文（英文占 0.012%），
   * 念英文单词像中式英语。换成音译后，中文 TTS 念起来就自然了。
   * 设 false 可关掉（表里没有的词本来就原样保留，这个开关只影响「替换」这一步）。
   */
  transliterateEnglish: true,
  /** 合成完是否直接播放（false = 只出文件，测试用） */
  play: true,
  /**
   * 整轮聚合：等这一轮说完，把多段文本拼成一段再念。
   *
   * 为什么默认开：一轮对话里 assistant/message 会来好几次
   * （说一句 → 调工具 → 再说一句 → 再调工具……）。
   * 逐句念的听感是「说一句…安静 10 秒…说一句…安静 10 秒」，
   * 用户原话：「不同任务的都在一起说话，而且中间停顿很多」。
   *
   * 聚合成一段 → 合成一次 → 播一次，才像一段自然的叙述。
   * 代价是要等这一轮结束才出声，但用户明确选了「整轮说完再念」。
   */
  aggregateTurn: true,
  /**
   * 聚合上限：攒够这么多字就先念，不等整轮结束。
   *
   * ⚠️ 2026-11-06：原来设的 240 太小了。一条完整回复经常 800-1500 字，
   * 于是被切成 4-5 段分别念——用户听到的就是「又开始抢句子」。
   *
   * 现在设成 2000：正常一轮回复（< 2000 字）会完整攒到 turn/end 再念一次。
   * 只有超长回复才中途先念，避免憋太久。
   *
   * 注意：聚合的是「正文」，念的是「口播摘要」（50-90 字），
   * 所以阈值大不会导致念很久——只是决定什么时候触发摘要。
   */
  aggregateMaxChars: 2000,
  /**
   * 流式逐句朗读：**默认关闭**。
   *
   * ⚠️ 2026-11-06：这条线和「整轮聚合」同时开着，导致两套语音互相抢——
   * 流式那条边生成边念（碎），聚合那条在 turn/end 再念一次（完整），
   * 用户听到的是「句子之间互抢」。
   *
   * 现在统一走「整轮聚合 + 口播」，流式那条只在显式设 true 时才启用。
   */
  streaming: false,
  /** C 方案：没调 announce 时，用 LLM 把正文压成口播（默认开） */
  summarizeForSpeech: true,
  /** 口播长度上限（字）。三段结构（招呼+结论+收尾）比纯总结略长，放宽到 180 */
  announceMaxChars: 180,
  /** 摘要请求超时（毫秒） */
  announceTimeoutMs: 20000,
  /**
   * 播放是否串行：正在播一段时，后面的排队等它播完，而不是同时播。
   *
   * fire-and-forget 的 playWav 在两条 say 挨得近时会让两个 SoundPlayer
   * 同时出声，互相盖住——用户听到的就是「互抢」。
   */
  serializePlayback: true
}

/**
 * 英文 → 中文音译表。
 *
 * 为什么要有这张表：本机 GPT-SoVITS v5turbo 的训练语料几乎 100% 中文，
 * 英文只占 0.012%，合成英文单词像中式英语。把这些词换成中文音译，
 * 中文 TTS 念音译词就自然了。
 *
 * 规则：
 *   - 每条音译都是**纯中文字**，不能带字母（否则换了等于没换，TTS 还得念英文）。
 *   - 键统一转小写匹配，但用 \b 词边界，只替换独立英文单词/缩写，
 *     不拆中文里夹的字母。
 *   - 纯大写缩写（OK/GPT/CPU…）优先匹配完整缩写——词边界已经保证不会
 *     把 "OK" 拆进 "LOOK"（\b 要求前后是非字母数字下划线）。
 *   - 表里没有的英文原样保留，不硬造。
 */
export const EN_TRANSLITERATION = {
  // —— 口语/日常 ——
  ok: '欧克', hello: '哈喽', hi: '嗨', bye: '拜拜', sorry: '骚瑞',
  thanks: '三克油', thank: '三克', please: '普利斯', yes: '耶斯', no: '诺',
  email: '伊妹儿', phone: '凤', wifi: '歪发哎', good: '顾得', nice: '奈斯',
  cool: '酷', wow: '哇哦', love: '拉夫', baby: '贝比', dude: '丢的',
  // —— 计算机 / 开发 ——
  ai: '爱', gpt: '吉皮提', tts: '踢踢爱思', pc: '皮西', cpu: '西皮尤',
  gpu: '吉皮尤', api: '诶匹爱', app: '爱屁', file: '费欧', bug: '八哥',
  fix: '费克斯', test: '泰斯特', model: '摸斗', python: '拍森', version: '威神',
  plugin: '普拉跟', log: '咯格', code: '扣德', data: '得塔', config: '康费格',
  server: '瑟尔沃', client: '克莱恩特', local: '喽扣', remote: '瑞莫特',
  online: '昂莱', offline: '奥夫莱', github: '给特哈布', npm: '恩皮艾姆',
  json: '杰森', xml: '艾克斯艾姆艾欧', html: '艾区提艾姆艾欧', css: '西艾斯艾斯',
  js: '杰艾斯', sql: '艾斯扣艾欧', http: '艾区提提皮', https: '艾区提提皮艾斯',
  url: '优艾尔艾欧', ip: '爱屁', dns: '迪恩艾斯', vpn: '威批恩', db: '迪比',
  os: '欧艾斯', ram: '瑞姆', rom: '肉姆', ssd: '艾斯艾斯迪', usb: '优艾斯比',
  io: '爱欧', gui: '桂', cli: '西艾尔爱', sdk: '艾斯迪凯', node: '诺德',
  web: '威布', frontend: '芙容恩德', backend: '白可恩德', debug: '迪八哥',
  cache: '凯西', token: '托肯', proxy: '普若西', deploy: '迪普洛伊',
  upgrade: '阿普格雷德', install: '因斯多', update: '阿普得特', download: '当漏的',
  upload: '阿普漏的', source: '苏尔斯', library: '来不蕊', project: '普绕杰科特',
  // —— 通用缩写 / 组织 ——
  lol: '唠嗑', omg: '欧买尬', id: '爱迪', pdf: '皮迪艾夫', doc: '多克',
  jpg: '杰屁居', png: '皮恩居', mp3: '艾姆皮三', mp4: '艾姆皮四',
}

/**
 * 英文音译替换。把 `\b` 边界包住的英文词/缩写换成中文音译。
 * 没在表里的原样保留；已经在表里的不会重复替换（替换后的结果全是中文，无词边界）。
 *
 * 为什么用「排序后再逐个正则」而不是「一次大正则」：
 *   1. 键有重叠（"http" 与 "https"、"thank" 与 "thanks"），
 *      按长度降序匹配能保证长键优先、不截断。
 *   2. 每个键单独 replace 一次，行为可预测、可单测。
 * 表很小（几十条），逐条替换的成本可忽略。
 */
export function transliterateEnglish(text, options = {}) {
  if (options.transliterateEnglish === false) return text
  const s = String(text ?? '')
  // 先按长度降序排，保证 https 在 http 之前、thanks 在 thank 之前
  const keys = Object.keys(EN_TRANSLITERATION).sort((a, b) => b.length - a.length)
  let out = s
  for (const k of keys) {
    out = out.replace(new RegExp(`\\b${k}\\b`, 'gi'), EN_TRANSLITERATION[k])
  }
  return out
}

/**
 * 把 Markdown 回复清洗成适合朗读的纯文本。
 *
 * 念「三个星号、三个星号、标题、冒号」是灾难。规则：
 *   - 去掉代码块（整段）、行内代码只留内容
 *   - 去掉表格（读出来毫无意义）
 *   - 链接只留文字
 *   - 去掉 Markdown 标记符
 *   - 数字和英文之间补空格，让引擎断句自然
 *   - 压缩连续空行
 */
export function cleanForSpeech(text, options = {}) {
  const stripCode = options.stripCodeBlocks !== false
  let s = String(text ?? '')

  // 1. 代码块整段去掉（含 ``` 围栏）
  if (stripCode) {
    s = s.replace(/```[\s\S]*?```/g, ' ')
    s = s.replace(/~~~[\s\S]*?~~~/g, ' ')
  }

  // 2. 表格整块去掉（连续的 | ... | 行）
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ')

  // 3. 图片 / 链接 → 只留文字
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 3.5 英文 → 中文音译（代码块/链接里那些已经被剥掉，剩的是正文里的英文）
  s = transliterateEnglish(s, options)

  // 4. HTML 标签
  s = s.replace(/<[^>]+>/g, ' ')

  // 5. 引用符号与列表符号
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*\d+\.\s+/gm, '')

  // 6. 标题符号
  s = s.replace(/^\s*#{1,6}\s+/gm, '')

  // 7. 强调 / 删除线 / 行内代码
  s = s.replace(/`([^`]*)`/g, '$1')
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2')
  s = s.replace(/(\*|_)(.*?)\1/g, '$2')
  s = s.replace(/~~(.*?)~~/g, '$1')

  // 8. 水平线
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ')

  /*
   * 9. emoji / 装饰符 / 特殊符号：**gbk 编码会炸，必须删干净**。
   *
   * 日志证据（2026-11-06）：
   *   'gbk' codec can't encode character '\U0001f380'（🎀）
   *   'gbk' codec can't encode character '\u2705'（✅）
   * 只要回复里有 emoji，合成必然 400，整句静音。
   * 这就是用户说的「语音时灵时不灵」的一大来源——取决于我有没有用 emoji。
   *
   * 覆盖范围：
   *   \u{1F000}-\u{1FAFF}  杂项符号与象形文字（🎀 🎉 🚀 …）
   *   \u{2600}-\u{27BF}    杂项符号、装饰符（✅ ❤ ★ ♪ …）
   *   \u{2B00}-\u{2BFF}    更多箭头与符号
   *   \u{FE00}-\u{FE0F}    变体选择符（emoji 的组合修饰）
   *   \u{20000}-\u{2FFFF} 补充平面 CJK（少见，gbk 也不支持）
   */
  s = s.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{20000}-\u{2FFFF}]/gu,
    ''
  )
  // ♪♫♬♩ 已在上面覆盖，这里再兜一次（可读性考虑）
  s = s.replace(/[♪♫♬♩]/g, '')

  /*
   * 9.5 只保留第一段（语音对话要短）
   *
   * 用户要求「每次只回一小段，能一句一句接」。
   * 这条在记忆里已经记了行为要求，这里再加一道机制兜底：
   * 就算某次写了长报告，语音也只念开头那一段。
   *
   * 为什么要兜底：行为约束靠自觉，机制约束不靠。
   * 而且段落是最自然的切分——一段话正好是一口气。
   *
   * 第一段太短（< 10 字，比如「好的。」）时退回原文，
   * 否则会念出「好的。」这种没信息量的话。
   */
  if (options.firstParagraphOnly !== false) {
    const paras = s
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (paras.length > 1 && paras[0].length >= 10) s = paras[0]
  }

  // 10. 空白收敛
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.trim()

  return s
}

/**
 * 引擎是否活着。
 *
 * ⚠️ 2026-11-06 踩坑：GPT-SoVITS 的 `/docs` 端点**首次请求会卡 4 秒以上**
 * （FastAPI 冷启动 + 模型预热），之后才 0.09s 返回。
 * 老插件 dsh-elysia-vox 用 `timeout=4.0` 探活，撞上这个慢请求就判成 false，
 * 直接返回退出码 2 —— 表现就是「明明引擎在跑，语音却一直不出声」。
 *
 * 所以这里：超时给到 12 秒，并且**失败重试一次**（第二次通常是热的）。
 */
export async function engineAlive(engineUrl, timeoutMs = 12000) {
  const url = String(engineUrl || '').replace(/\/+$/, '')
  if (!url) return false
  const probe = async (ms) => {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), ms)
      const res = await fetch(`${url}/docs`, { signal: ctl.signal })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }
  if (await probe(timeoutMs)) return true
  // 第一次超时可能只是冷启动，再给一次机会
  return probe(Math.min(timeoutMs, 6000))
}

/**
 * 用 PowerShell SoundPlayer 播放 wav，完全脱离父进程。
 *
 * 为什么不用 Node 的音频库：插件是纯 JS、零依赖，装 native 音频模块会拖垮安装。
 * SoundPlayer 是 Windows 自带，`PlaySync()` 在独立进程里跑，DSH 完全不等它。
 */
/**
 * 播放串行链：同一时刻只有一段在播，后面的排队等。
 *
 * 为什么需要：原来 playWav 是 fire-and-forget，两条 say 挨得近时
 * 两个 SoundPlayer 会同时出声互相盖住——用户原话「句子之间会互抢」。
 */
let playChain = Promise.resolve()

/** 当前正在跑的播放进程（用于「立刻停止」） */
let currentPlayer = null

/**
 * 立刻停掉正在播的声音。
 *
 * 为什么不靠「等它播完」：SoundPlayer 的 PlaySync 是阻塞的，
 * 一旦开始就没办法从外部调音量或中断——唯一的办法是 kill 掉那个进程。
 * 面板上点「关闭语音」时调这个，声音立刻消失，不用等整段念完。
 *
 * 返回是否真的停掉了什么（方便 UI 给反馈）。
 */
export function stopPlayback() {
  if (!currentPlayer) return { stopped: false, reason: "not-playing" }
  const pid = currentPlayer.pid
  try {
    currentPlayer.kill()
  } catch {
    /* 已经退了 */
  }
  currentPlayer = null
  return { stopped: true, pid }
}

/** 当前是否正在播 */
export function isPlaying() {
  return Boolean(currentPlayer)
}


export function playWav(wavPath, logger = null) {
  const run = playChain.then(
    () => playOne(wavPath, logger),
    () => playOne(wavPath, logger)
  )
  // 队列不能因为某一段失败而断掉
  playChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * 真正的播放：等它播完（exit）才 resolve，串行链才有效。
 *
 * ⚠️ 两个不能再犯的坑：
 *   1. **不能 detached** —— 子进程进新进程组后音频会话上下文不对，
 *      SoundPlayer 静默不发声（不报错也不返回）。实测四组对照确认。
 *   2. **不能 unref** —— unref 之后父进程不再等它，也就收不到 exit，
 *      队列会以为「播完了」立刻放行下一段，又变回同时播。
 *
 * 父进程不会因此阻塞：调用方 await 的是这个 Promise，不是同步等。
 * 90 秒兜底：万一 exit 不来（进程卡住），强制放行。
 */
function playOne(wavPath, logger = null) {
  return new Promise((resolve) => {
    if (!wavPath || !existsSync(wavPath)) {
      resolve({ played: false, reason: 'file-missing' })
      return
    }
    const ps =
      "$ErrorActionPreference='SilentlyContinue';" +
      `$p=New-Object System.Media.SoundPlayer '${wavPath.replace(/'/g, "''")}';` +
      '$p.PlaySync()'
    const winPs = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const exe = existsSync(winPs) ? winPs : 'powershell'

    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    try {
      const child = spawn(
        exe,
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
        { detached: false, stdio: 'ignore', windowsHide: true }
      )
      // 记下当前播放进程，stopPlayback() 靠它 kill
      currentPlayer = child
      const timer = setTimeout(() => {
        if (currentPlayer === child) currentPlayer = null
        finish({ played: true, timedOut: true })
      }, 90000)
      child.on('error', (e) => {
        if (currentPlayer === child) currentPlayer = null
        clearTimeout(timer)
        logger?.warn?.(`[elysia-voice] 播放失败：${e.message}`)
        finish({ played: false, reason: e.message })
      })
      child.on('exit', (code) => {
        if (currentPlayer === child) currentPlayer = null
        clearTimeout(timer)
        finish({ played: true, exitCode: code ?? 0 })
      })
    } catch (e) {
      finish({ played: false, reason: e.message })
    }
  })
}

/**
 * 引擎没起就把它拉起来。
 *
 * 为什么不写在「每次合成前」：GPT-SoVITS 加载权重 + 上 CUDA 要 40-60 秒，
 * 每轮都等这个会让人以为卡死了。只在**开关刚打开**或**首次朗读前**试一次，
 * 成功就记住，失败也记住（不再反复 spawn）。
 *
 * 用法：`python api_v2.py -a 127.0.0.1 -p 9880`，工作目录必须是引擎根目录
 * （脚本用相对路径找 GPT_SoVITS/configs/tts_infer.yaml）。
 */
/**
 * 探测这台机器能不能用 CUDA。
 *
 * 探测要跑一次 python（约 2~6 秒），所以结果缓存在进程内。
 * 探测失败（python 不在、没装 torch、超时）一律当作「不能用 CUDA」——
 * 慢一点总比跑不起来好。
 */
let cudaProbeCache = null
export function probeTorchDevice({ pythonPath = '', engineDir = '', timeoutMs = 25000 } = {}) {
  if (cudaProbeCache !== null) return Promise.resolve(cudaProbeCache)
  return new Promise((resolve) => {
    const py = pythonPath || 'python'
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      cudaProbeCache = value
      resolve(value)
    }
    let child = null
    try {
      child = spawn(py, ['-c', CUDA_PROBE_CODE], {
        cwd: engineDir || undefined,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      finish(false)
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 杀不掉也没关系，下面按不可用处理 */
      }
      finish(false)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.on('data', (d) => {
      out += String(d)
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(out.includes('cuda'))
    })
  })
}

/** 换机器 / 换显卡后想重新探测时用 */
export function resetDeviceProbe() {
  cudaProbeCache = null
}

/**
 * 起引擎。
 *
 * ⚠️ 设备不是命令行参数：`api_v2.py` 里那行 `# device = args.device` 是注释掉的，
 * 真正的设备只从 `GPT_SoVITS/configs/tts_infer.yaml` 读。所以这里会
 * **派生**一份 `tts_infer.<device>.yaml`，再用 `-c` 指过去——
 * 原配置一个字节都不动，用户随时能手改回来。
 */
export async function ensureEngine(options = {}, logger = null) {
  const {
    engineUrl = VOICE_DEFAULTS.engineUrl,
    engineDir = '',
    pythonPath = '',
    device = 'auto',
    timeoutMs = 180000
  } = options

  if (await engineAlive(engineUrl, 1500)) {
    return { started: false, alive: true, reason: 'already-running', device: '' }
  }
  if (!engineDir || !existsSync(engineDir)) {
    return { started: false, alive: false, reason: `引擎目录不存在：${engineDir || '(未配置)'}`, device: '' }
  }
  const py = pythonPath || 'python'
  if (!existsSync(py) && py !== 'python') {
    return { started: false, alive: false, reason: `Python 不存在：${py}`, device: '' }
  }

  /* ---- 1) 决定设备 ---- */
  const pref = String(device || 'auto').toLowerCase()
  let chosen
  if (pref === 'auto') {
    const cuda = await probeTorchDevice({ pythonPath: py, engineDir })
    chosen = resolveDevice('auto', cuda)
    logger?.info?.(`[elysia-voice] 设备探测：CUDA ${cuda ? '可用' : '不可用'}，改用 ${chosen}`)
  } else {
    chosen = pref === 'cpu' ? 'cpu' : 'cuda'
  }

  /* ---- 2) 派生配置 ---- */
  const args = ['api_v2.py']
  try {
    const cfg = prepareDeviceConfig(engineDir, chosen)
    if (cfg.ok) {
      writeFileSync(cfg.path, cfg.text, 'utf8')
      args.push('-c', cfg.path)
      logger?.info?.(`[elysia-voice] 已生成 ${chosen} 配置：${cfg.path}`)
    } else {
      logger?.warn?.(`[elysia-voice] 无法派生设备配置，将沿用引擎原配置：${cfg.reason}`)
    }
  } catch (error) {
    logger?.warn?.(`[elysia-voice] 写设备配置失败，沿用原配置：${error?.message ?? error}`)
  }

  const url = new URL(engineUrl)
  const port = url.port || '9880'
  const host = url.hostname || '127.0.0.1'
  args.push('-a', host, '-p', port)

  try {
    logger?.info?.(`[elysia-voice] 启动引擎（${chosen}）：${engineDir}`)
    const child = spawn(py, args, {
      cwd: engineDir,
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    })
    // 脱离父进程：DSH 关掉时引擎可以继续跑，下次就不用再等
    child.unref()
  } catch (e) {
    return { started: false, alive: false, reason: `启动失败：${e.message}`, device: chosen }
  }

  // CPU 模式加载权重慢得多（实测约 25 秒，GPU 约 20 秒），超时留足
  const waitMs = isCpuDevice(chosen) ? Math.max(timeoutMs, 240000) : timeoutMs
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await engineAlive(engineUrl, 1500)) {
      logger?.info?.(`[elysia-voice] 引擎已就绪（${chosen}）`)
      return { started: true, alive: true, device: chosen }
    }
  }
  return { started: true, alive: false, reason: '启动超时', device: chosen }
}

/**
 * 调 elysia_say.py 合成一句话，返回音频文件路径。
 *
 * 用子进程而不是直接打 HTTP，因为 elysia_say.py 里有一整套后处理链
 * （去齿音、谱减降噪、吸气压缩、语速、说话时机对齐），
 * 这些是反复调出来的，不该在插件里重写一遍。
 */
export function synthesizeViaScript({ scriptPath, pythonPath, text, options = {}, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    if (!scriptPath || !existsSync(scriptPath)) {
      resolve({ ok: false, error: `找不到合成脚本：${scriptPath || '(未配置)'}` })
      return
    }
    const py = pythonPath || 'python'
    /*
     * ⚠️ 文本必须放在 `--` 之后。
     * 它是 argparse 的位置参数，而 argparse 会把以 `-` 开头的值当成选项：
     * 口播如果以「——」或「-」开头（很常见），会被解析成未知参数直接报错。
     * `--` 之后一律当位置参数，选项名也就没法和正文混淆了。
     */
    const args = [
      scriptPath,
      '--save-only', // 只出文件，不自己播放（播放交给宿主）
      '--no-auto-start', // 引擎没起就算了，别在这里拉起一个几百 MB 的进程
      '--model', String(options.model ?? VOICE_DEFAULTS.model),
      '--ref', String(options.ref ?? VOICE_DEFAULTS.ref)
    ]
    if (Number.isFinite(options.speed)) args.push('--speed', String(options.speed))
    // 音量：只在非 0 时传。0 是脚本默认值（不调），传了反而多跑一次读写。
    if (Number.isFinite(options.volume) && options.volume !== 0) {
      args.push('--volume', String(options.volume))
    }
    args.push('--', text)

    let out = ''
    let err = ''
    let done = false
    const child = spawn(py, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
        resolve({ ok: false, error: '合成超时' })
      }
    }, timeoutMs)

    child.stdout?.on('data', (b) => {
      out += b.toString('utf8')
    })
    child.stderr?.on('data', (b) => {
      err += b.toString('utf8')
    })
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, error: `启动失败：${e.message}` })
    })
    child.on('close', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      // elysia_say.py 成功时 stdout 形如：
      //   [ok] 3.37s | 316KB | 合成 1.63s | RTF=0.49
      //        C:\...\say_20261106_015437.wav
      const m = /(\S+\.wav)\s*$/m.exec(out)
      if (m && existsSync(m[1])) {
        resolve({ ok: true, file: m[1], stdout: out, stderr: err })
      } else {
        resolve({ ok: false, error: (err || out || '没有产出音频').slice(-400) })
      }
    })

    /*
     * ★ 2026-11-06 卡死修复：再加一道 'exit' 监听。
       *
     * 'close' 要求**子进程退出且所有 stdio 管道关闭**。如果 Python 那边
     * 因为任何原因挂住（等 CUDA、等 socket、stdout 阻塞），'close' 永远不来。
     * 上面虽有 timer 兜底，但实际观测到的现象是：
     * 日志有 [say]、永远没有 [sayResult]，后面的句子全堵在串行队列里。
       *
     * 'exit' 只要进程真的结束就触发，不依赖 stdio 排空。
     * 留 120ms 让 stdout 最后几个 chunk 到齐（[ok] 行含文件路径）。
       */
      child.on('exit', () => {
      setTimeout(() => {
        if (done) return
        done = true
        clearTimeout(timer)
          const m = /(\S+\.wav)\s*$/m.exec(out)
        if (m && existsSync(m[1])) {
          resolve({ ok: true, file: m[1], stdout: out, stderr: err })
        } else {
          resolve({ ok: false, error: (err || out || '进程退出但没有产出音频').slice(-400) })
        }
      }, 120)
    })
  })
}

/**
 * 语音朗读器：带节流、去重、失败熔断。
 *
 * 熔断的理由：引擎挂了的时候，每一轮都去 spawn 一个 python 进程、
 * 等 120 秒超时，会拖慢整个对话。连续失败 3 次就停 5 分钟再试。
 */
export function createSpeaker(config = {}, logger = null) {
  const cfg = { ...VOICE_DEFAULTS, ...config }
  let lastAt = 0
  let failStreak = 0
  /** 排队中（含正在合成）的句子数，用来给队列设上限 */
  let pendingSay = 0
  /**
   * 队列深度上限。一轮里 assistant/message 可能来好几次，一次合成 5-8 秒、
   * 一句播 10-20 秒，全排队会拖到几分钟后——合成是装饰，超过就放弃，别拖住宿主。
   */
  const MAX_PENDING_SAY = 3
  let cooldownUntil = 0
  let lastHash = ''
  /** 引擎自动拉起只试一次：失败后不再反复 spawn（每次要等 40-60 秒） */
  let engineAttempted = false
  /** 实际启动时用的设备（cuda / cpu），只用于展示 */
  let engineDevice = ''
  /**
   * 串行队列：同一时刻只跑一个合成。
   *
   * 为什么不是「丢掉后到的」：一次合成要 5-6 秒，而一轮对话里
   * assistant/message 可能来三四次（短句 → 工具 → 长回复）。
   * 如果后到的直接 return，长回复永远轮不上，用户听到的是沉默。
   * 排队的话，最多慢一点，但每句都会念到。
   */
  let chain = Promise.resolve()

  const log = (level, msg) => {
    try {
      logger?.[level]?.(`[elysia-voice] ${msg}`)
    } catch {
      /* 日志本身不该抛 */
    }
  }

  return {
    cfg,

    get enabled() {
      return Boolean(cfg.enabled)
    },

    /** 状态：给 UI / 工具用 */
    status() {
      return {
        enabled: Boolean(cfg.enabled),
        /** 气泡是否显示（与引擎无关，只发文字和表情） */
        bubble: cfg.bubble !== false,
        engineUrl: cfg.engineUrl,
        model: cfg.model,
        ref: cfg.ref,
        speed: cfg.speed,
        volume: cfg.volume,
        failStreak,
        /**
         * 推理设备。engineDevice 是**实际启动时**用的（探测结果），
         * auto 表示还没探测过。面板与 status 靠它提示「CPU 模式会慢一些」。
         */
        device: engineDevice || String(cfg.device ?? 'auto').toLowerCase(),
        // 只有「确定是 cpu」才算 cpu；auto 还没探测时不能吓唬人
        cpu: String(engineDevice || cfg.device).toLowerCase() === 'cpu',
        cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
        lastAt: lastAt ? new Date(lastAt).toISOString() : null
      }
    },

    /**
     * 朗读一段文本。返回 { spoke, reason?, file? }。
     * 任何情况下都不抛异常。
     */
    /**
     * 朗读一段文本。返回 { spoke, reason?, file? }。
     * 任何情况下都不抛异常。
     *
     * 外面套一层串行队列：并发的调用会排队而不是互相挤掉。
     * 一轮对话里 assistant/message 可能来好几次（短句 → 工具 → 长回复），
     * 丢掉后到的意味着长回复永远念不出来。
     */
    say(rawText, overrides = {}) {
      if (pendingSay >= MAX_PENDING_SAY) {
        return Promise.resolve({ spoke: false, reason: 'queue-full' })
      }
      pendingSay += 1
      const run = chain.then(() => this._sayOnce(rawText, overrides))
      // 队列本身不能因为单次失败而断掉
      chain = run.then(
        () => undefined,
        () => undefined
      )
      const done = () => {
        pendingSay = Math.max(0, pendingSay - 1)
      }
      run.then(done, done)
      /*
       * 兜底超时：_sayOnce 内部已经有多道超时（合成 120s / 探活 12s），
       * 但如果某处 await 真的悬住（例如 spawn 的 close 事件没触发），
       * 整个 Promise 会永远 pending —— 表现就是「日志里有 [say]，
       * 但永远没有 [sayResult]」，用户端一片沉默且毫无线索。
       * 这里加一道总闸：180 秒还没结果，就当作失败返回，让调用方继续。
       */
      let timer = null
      const guard = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ spoke: false, reason: 'timeout' }), 180000)
        // unref：这个定时器不该拖住宿主退出
        if (typeof timer.unref === 'function') timer.unref()
      })
      // 无论谁先完成，都要把兜底定时器清掉（以前它一直悬着，每句泄漏一个）
      return Promise.race([run, guard]).finally(() => {
        if (timer) clearTimeout(timer)
      })
    },

    async _sayOnce(rawText, overrides = {}) {
      if (!cfg.enabled) return { spoke: false, reason: 'disabled' }

      const now = Date.now()
      if (cooldownUntil > now) {
        return { spoke: false, reason: 'cooldown', until: new Date(cooldownUntil).toISOString() }
      }
      /*
       * ⚠️ 清零必须放在 return **之前**。
       *
       * 原来这两行写在 `if (cooldownUntil > now) { return ... }` 的 return 后面，
       * 属于永远执行不到的死代码：熔断结束后 failStreak 一直是 3，
       * 下一句只要再失败一次就又立刻熔断 2 分钟——注释承诺的「3 次机会」并不存在。
       */
      if (cooldownUntil !== 0) {
        cooldownUntil = 0
        failStreak = 0
      }
      /*
       * 排队而不是丢弃。
       *
       * ⚠️ 2026-11-06 实测的坑：一轮对话里模型会先冒一句「好的，我来看看」
       * 然后立刻调工具，真正的内容在后面的长回复里。一次合成要 5-6 秒，
       * 如果第二次到达时因为 cooldown（800ms）直接 return 'throttled'，
       * 那么**长句永远轮不到**——用户听到的是沉默。
       *
       * 所以：同一时间只跑一个合成，后来的**排队**等前一个跑完，
       * 而不是丢掉。队列里只保留最新一条（旧的话已经过时了）。
       */
      const text = cleanForSpeech(rawText, {
        stripCodeBlocks: cfg.stripCodeBlocks,
        transliterateEnglish: cfg.transliterateEnglish !== false
      })
      if (text.length < Number(cfg.minChars)) return { spoke: false, reason: 'too-short' }

      const clipped = text.length > Number(cfg.maxChars) ? text.slice(0, Number(cfg.maxChars)) : text

      // 完全相同的内容不重复朗读（重试、刷新都可能触发）
      const hash = `${clipped.length}:${clipped.slice(0, 64)}`
      if (hash === lastHash) return { spoke: false, reason: 'duplicate' }
      lastHash = hash

      const alive = await engineAlive(cfg.engineUrl)
      if (!alive) {
        // 第一次发现没起就试着拉一次；成败都记住，不反复 spawn
        if (!engineAttempted) {
          engineAttempted = true
          const r = await ensureEngine(
            {
              engineUrl: cfg.engineUrl,
              engineDir: cfg.engineDir,
              pythonPath: cfg.pythonPath,
              device: cfg.device
            },
            logger
          )
          // 记住实际用的设备，面板与 status 要显示（cuda / cpu）
          if (r.device) engineDevice = r.device
          if (!r.alive) {
            failStreak += 1
            if (failStreak >= 3) cooldownUntil = Date.now() + 2 * 60 * 1000
            return { spoke: false, reason: 'engine-down', error: r.reason }
          }
        } else {
          failStreak += 1
          if (failStreak >= 3) cooldownUntil = Date.now() + 2 * 60 * 1000
          return { spoke: false, reason: 'engine-down' }
        }
      }

      const r = await synthesizeViaScript({
        scriptPath: cfg.scriptPath,
        pythonPath: cfg.sayPythonPath || cfg.pythonPath,
        text: clipped,
        options: {
          model: overrides.model ?? cfg.model,
          ref: overrides.ref ?? cfg.ref,
          speed: overrides.speed ?? cfg.speed,
          volume: overrides.volume ?? cfg.volume
        }
      })

      if (!r.ok) {
        /*
         * ⚠️ 合成失败**不计数**。
         *
         * 原因：合成失败大多是**内容问题**（emoji、特殊字符编不了），
         * 换个句子就能成功。算进熔断会让整段对话静音 2 分钟，
         * 而其实下一句可能完全没问题。
         *
         * 实测证据（2026-11-06）：一句带 🎀 的回复失败后，
         * 下一句不带 emoji 是能合成的——但熔断已经拦住了。
         * 这就是用户说的「时灵时不灵」的另一半。
         */
        log('warn', `合成失败：${r.error}`)
        return { spoke: false, reason: 'synth-failed', error: r.error }
      }

      failStreak = 0
      lastAt = Date.now()
      log('info', `已合成 ${path.basename(r.file)}`)

      // 合成完直接播。cfg.play === false 时只出文件不发声（测试 / 调试用）。
      let played = false
      if (cfg.play !== false) {
        const pr = await playWav(r.file, logger)
        played = Boolean(pr.played)
        if (!played) log('warn', `播放失败：${pr.reason}`)
      }
      return { spoke: true, file: r.file, played }
    },

    /** 给测试用：手动清状态 */
    _reset() {
      lastAt = 0
      failStreak = 0
      cooldownUntil = 0
      lastHash = ''
      engineAttempted = false
    }
  }
}
