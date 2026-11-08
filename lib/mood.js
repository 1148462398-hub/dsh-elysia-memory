/**
 * lib/mood.js —— 从口播文字推断情绪，用来给气泡配一张表情包
 *
 * ## 为什么不用模型判断
 *
 * 之前考虑过「让模型决定配不配图」，放弃了：
 *   · 模型经常忘（上下文一长就漏）
 *   · 模型判断不稳定，同样的句子有时发有时不发
 *   · 还要多一轮交互
 *
 * 所以改成纯规则：**扫口播文本里的情绪词 → 映射成 mood → 挑图**。
 * 好处是确定性的——同一句话永远得到同一个结果，不会「时灵时不灵」。
 *
 * ## 匹配策略
 *
 * 关键词是**加权**的，越具体的词权重越高。比如「做完啦」比「好」更明确。
 * 多个词命中时累加，取最高分的 mood。
 *
 * 刻意避开「的/了/是」这种高频虚词，否则几乎每句都会命中。
 */

/**
 * 情绪词表：mood → 关键词数组（可以带权重）。
 *
 * 格式 `[词, 权重?]`，权重默认 1。
 * 权重高 = 这个词更能代表该情绪。
 */
const MOOD_WORDS = {
  // —— 工作完成 / 成功 ——
  proud: [
    ['做完', 3], ['完成', 3], ['搞定', 3], ['办妥', 3], ['装好', 2],
    ['修好', 2], ['通过', 2], ['全过', 2], ['成功', 2], ['发布', 2],
    ['上线', 2], ['修好', 2], ['解决了', 3], ['找到了', 2], ['好了', 2]
  ],
  happy: [
    ['太好了', 3], ['开心', 3], ['高兴', 3], ['不错', 1], ['挺好', 2],
    ['顺利', 2], ['棒', 2], ['厉害', 2], ['漂亮', 2]
  ],
  // —— 俏皮 / 得意 ——
  tease: [
    ['不过嘛', 2], ['嘿嘿', 3], ['猜猜', 2], ['你猜', 2],
    ['有趣', 2], ['好玩', 2], ['逗', 2], ['调皮', 2]
    // ⚠️「哎呀」不算情绪词：它 60 次里六种用法，纯语气词，
    // 加进来会让「哎呀，装好啦」被误判成俏皮（实测踩过）。
  ],
  得意: [
    ['厉害吧', 3], ['我说对', 3], ['当然啦', 2], ['早就', 2], ['看我', 2]
  ],
  // —— 抱歉 / 失败 ——
  sad: [
    ['抱歉', 3], ['对不起', 3], ['失败', 3], ['没成', 3], ['不行', 2],
    ['坏掉', 2], ['丢了', 2], ['可惜', 2], ['遗憾', 2], ['没办法', 2]
  ],
  // —— 累 / 困 ——
  sleepy: [
    ['累了', 3], ['好累', 3], ['困', 2], ['睡', 2], ['歇会', 2], ['休息', 2]
  ],
  // —— 疑惑 ——
  confused: [
    ['奇怪', 2], ['怎么回', 2], ['不明白', 3], ['不懂', 3], ['问号', 3]
  ],
  // —— 撒娇 / 亲近 ——
  shy: [
    ['害羞', 3], ['不好意思', 3], ['别夸', 2], ['讨厌', 2], ['谢谢', 1]
  ],
  // —— 安慰 / 温柔 ——
  温柔: [
    ['别急', 2], ['慢慢来', 2], ['别担心', 3], ['没事的', 2], ['陪着你', 3]
  ],
  // —— 无语 ——
  无语: [
    ['这也太', 2], ['真是的', 2], ['算了', 2], ['唉', 2]
  ]
}

/** 这些字出现太频繁，不能当情绪信号 */
const STOPWORDS = new Set(['的', '了', '是', '在', '和', '就', '也', '都', '很', '我', '你'])

/**
 * 从一段文字推断最可能的情绪。
 *
 * @param {string} text 口播文本
 * @returns {{ mood: string, score: number, hits: string[] } | null}
 *          没有明确情绪时返回 null（宁可不发，也别乱发）
 */
export function inferMood(text) {
  const src = String(text ?? '')
  if (src.length < 6) return null

  /*
   * ⚠️ 先做「否定/失败语境」的压制。
   *
   * 实测踩过的坑（2026-11-08）：
   *   「抱歉哦，这次没修好，还有个问题卡着。」
   *   → 命中「修好」+「好了」→ proud(4) → 配了一张「暗自认可」的得意表情
   *   → 失败的事配了得意的脸，非常怪。
   *
   * 所以：如果句子里有明确的问题词，就把「完成类」情绪的分数压下去。
   * 宁可不配图，也不能把失败配成得意。
   */
  const NEGATIVE = /抱歉|对不起|失败|没修好|没成|不行|坏了|坏掉|出错|报错|卡着|卡住|问题|丢失|丢了|遗憾|可惜/
  const hasNegative = NEGATIVE.test(src)

  const scores = new Map()
  const hitsByMood = new Map()

  for (const [mood, words] of Object.entries(MOOD_WORDS)) {
    let total = 0
    const hits = []
    for (const entry of words) {
      const word = Array.isArray(entry) ? entry[0] : entry
      const weight = Array.isArray(entry) ? entry[1] : 1
      if (!word || STOPWORDS.has(word)) continue
      const idx = src.indexOf(word)
      // 同一个词出现多次只算一次，避免刷分
      if (idx >= 0) {
        total += weight
        hits.push(word)
      }
    }
    // 负面语境下压制「完成/得意」类，避免「没修好」被当成「修好了」
    if (hasNegative && (mood === 'proud' || mood === 'happy' || mood === '得意')) {
      total = Math.floor(total / 3)
    }
    if (total > 0) {
      scores.set(mood, total)
      hitsByMood.set(mood, hits)
    }
  }

  if (!scores.size) return null

  // 取最高分；同分时按固定顺序（sad 优先，因为失败要如实反映）保证确定性
  const ORDER = ['sad', 'confused', '无语', 'sleepy', '温柔', 'shy', 'tease', '得意', 'proud', 'happy']
  let best = null
  for (const mood of ORDER) {
    const s = scores.get(mood) ?? 0
    if (s > 0 && (!best || s > best.score)) {
      best = { mood, score: s, hits: hitsByMood.get(mood) ?? [] }
    }
  }
  // ORDER 里没覆盖到的新 mood 也兜一下
  if (!best) {
    for (const [mood, s] of scores) {
      if (!best || s > best.score) best = { mood, score: s, hits: hitsByMood.get(mood) ?? [] }
    }
  }

  // 分数太低说明只是偶然撞词，不配图
  if (!best || best.score < 2) return null
  return best
}

/**
 * 根据口播文本挑一张表情包。
 *
 * @param {string} text 口播文本
 * @param {{ matchSticker: Function, recordUsage?: Function }} stickers stickers 模块
 * @param {object} options { stickerOptions, exclude, recentMs }
 * @returns {{ file: string, url?: string, mood: string, hits: string[] } | null}
 */
export function pickStickerForSpeech(text, stickers, options = {}) {
  const inferred = inferMood(text)
  if (!inferred) return null

  /*
   * ⚠️ exclude 必须传给 matchSticker —— 之前漏传，导致「避免连发同一张」失效：
   * 调用方明明传了 exclude，但这里只传了 stickerOptions，排除名单丢了。
   * 实测：同一句话连发两次，两次都选到 21_暗自认可.webp。
   */
  const matchOpts = { ...(options.stickerOptions ?? {}) }
  if (Array.isArray(options.exclude) && options.exclude.length) {
    matchOpts.exclude = options.exclude
  }

  let hit = null
  try {
    hit = stickers.matchSticker(inferred.mood, matchOpts)
  } catch {
    return null
  }
  if (!hit) {
    // 精确 mood 没匹配上，退一步用命中词再试一次（matchSticker 支持多词）
    try {
      hit = stickers.matchSticker(inferred.hits.join(','), matchOpts)
    } catch {
      return null
    }
  }
  if (!hit) return null

  return {
    file: hit.file,
    mood: inferred.mood,
    score: inferred.score,
    hits: inferred.hits
  }
}
