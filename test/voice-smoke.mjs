// voice.js 专项测试：清洗、开关、节流、熔断、真合成
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PLUGIN = 'C:/Users/123/Documents/deepseek-harness/default-workspace/plugins/dsh-shared-memory'
const { cleanForSpeech, createSpeaker, engineAlive, VOICE_DEFAULTS, transliterateEnglish } = await import(
  `file:///${PLUGIN}/lib/voice.js`
)
const { checkVoiceTuning } = await import(`file:///${PLUGIN}/lib/setup.js`)

let pass = 0
let total = 0
function check(label, ok, extra = '') {
  total += 1
  if (ok) pass += 1
  console.log(`  ${ok ? '✅' : '❌'} ${label} ${extra}`)
}

/* ---------- 1. 文本清洗 ---------- */
console.log('【1】cleanForSpeech')
{
  const md = [
    '## 标题',
    '',
    '这是**加粗**和*斜体*，还有`行内代码`。',
    '',
    '```js',
    'const x = 1',
    '```',
    '',
    '| 列1 | 列2 |',
    '|---|---|',
    '| a | b |',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '> 引用的话',
    '',
    '看这个[链接](https://example.com)和![图](a.png)',
    '',
    '♪ 音符要去掉'
  ].join('\n')
  const c = cleanForSpeech(md)
  check('去掉标题符号', !c.includes('##'))
  check('去掉加粗标记', !c.includes('**'))
  check('去掉代码块内容', !c.includes('const x'))
  check('去掉表格', !c.includes('| 列1'))
  check('去掉列表符号', !c.includes('- 列表项'))
  check('去掉引用符号', !c.includes('> 引用'))
  check('链接只留文字', c.includes('链接') && !c.includes('example.com'))
  check('图片只留文字', c.includes('图') && !c.includes('a.png'))
  check('去掉 ♪', !c.includes('♪'))
  check('保留正文内容', c.includes('这是') && c.includes('加粗') && c.includes('斜体'))
  check('保留行内代码内容', c.includes('行内代码'))

  check('纯文本原样', cleanForSpeech('你好呀') === '你好呀')
  check('空输入不炸', cleanForSpeech('') === '')
  check('null 不炸', cleanForSpeech(null) === '')
  check('连续空行收敛', !/\n{3,}/.test(cleanForSpeech('a\n\n\n\n\nb')))
}

/* ---------- 1.5 英文音译 ---------- */
console.log('')
console.log('【1.5】英文 → 中文音译')
{
  const t = transliterateEnglish
  check('OK→欧克', t('OK') === '欧克')
  check('GPT→吉皮提', t('GPT') === '吉皮提')
  check('AI→爱', t('AI') === '爱')
  check('TTS→踢踢爱思', t('TTS') === '踢踢爱思')
  check('hello→哈喽', t('hello') === '哈喽')
  check('小写也替换', t('ok') === '欧克')
  check('https 优先于 http', t('https') === '艾区提提皮艾斯')
  check('thanks 优先于 thank', t('thanks') === '三克油')
  check('没在表里的原样保留', t('kubernetes') === 'kubernetes')
  check('只替换独立单词', t('LOOK') === 'LOOK') // \b 边界保证不把 OK 从 LOOK 里拆出来
  check('不拆中文里夹的字母', t('这就是OK啦') === '这就是欧克啦')
  check('已音译的中文不被再动', t('欧克') === '欧克')
  check('中文标点不动', t('好的，OK。') === '好的，欧克。')
  check('默认 cleanForSpeech 会音译', cleanForSpeech('我们聊聊 AI 吧') === '我们聊聊 爱 吧')
  check('开关关闭时原样保留', cleanForSpeech('我们聊聊 AI 吧', { transliterateEnglish: false }) === '我们聊聊 AI 吧')
}

/* ---------- 2. 默认关闭 ---------- */
console.log('')
console.log('【2】默认状态')
{
  const sp = createSpeaker({})
  const st = sp.status()
  check('默认 enabled = false', st.enabled === false)
  check('默认模型 v5turbo', st.model === 'v5turbo')
  check('默认参考 R06', st.ref === 'R06')
  const r = await sp.say('这句话不该出声')
  check('关闭时 say 返回 disabled', r.spoke === false && r.reason === 'disabled')
}

/* ---------- 3. 节流与去重 ---------- */
console.log('')
console.log('【3】节流 / 去重 / 太短')
{
  const sp = createSpeaker({ enabled: true })
  const r1 = await sp.say('好的')
  check('太短不朗读', r1.spoke === false && r1.reason === 'too-short')
  sp._reset()
}

/* ---------- 4. 引擎探活 ---------- */
console.log('')
console.log('【4】engineAlive')
{
  const dead = await engineAlive('http://127.0.0.1:59999', 800)
  check('不存在的端口返回 false', dead === false)
  check('空地址返回 false', (await engineAlive('', 300)) === false)
}

/* ---------- 5. 引擎挂了：静默降级 + 熔断 ---------- */
console.log('')
console.log('【5】引擎不可用时的降级')
{
  const sp = createSpeaker({ enabled: true, engineUrl: 'http://127.0.0.1:59999' })
  const r1 = await sp.say('这是一句足够长的话，应该尝试合成')
  check('引擎挂了返回 engine-down', r1.spoke === false && r1.reason === 'engine-down')
  const st1 = sp.status()
  check('失败连击计数 +1', st1.failStreak === 1, `(${st1.failStreak})`)
  await sp.say('第二句话也不能炸')
  await sp.say('第三句话也不能炸')
  const st3 = sp.status()
  check('连击 3 次后熔断', st3.cooldownUntil !== null, st3.cooldownUntil ?? '')
  const r4 = await sp.say('熔断期间第四句')
  check('熔断期间直接返回 cooldown', r4.reason === 'cooldown')
}

/* ---------- 6. 真合成（引擎在线时） ---------- */
console.log('')
console.log('【6】真实合成')
const alive = await engineAlive('http://127.0.0.1:9880', 2000)
if (!alive) {
  console.log('  ⏭  引擎没起，跳过（这是允许的降级）')
} else {
  const sp = createSpeaker({
    enabled: true,
    engineUrl: 'http://127.0.0.1:9880',
    pythonPath: 'C:/Users/123/Documents/deepseek-harness/default-workspace/.quant-env/Scripts/python.exe',
    scriptPath: 'C:/Users/123/Documents/deepseek-harness/default-workspace/elysia_say.py',
    model: 'v5turbo',
    ref: 'R06'
  })
  const r = await sp.say('哎呀，你终于回来啦。我等了你好久呢。', { cooldownMs: 0 })
  check('合成成功', r.spoke === true, r.error ?? r.file ?? '')
  if (r.spoke) {
    const ok = await fsp.stat(r.file).then((s) => s.size > 10000).catch(() => false)
    check('产出文件有效（>10KB）', ok, r.file)
  }
}

console.log('')
console.log('【7】调校完整性自检')
{
  const none = checkVoiceTuning({})
  check('空配置返回 ok=false 且有清单', none.ok === false && Array.isArray(none.items) && none.items.length > 0)
  check('空配置缺失项含合成入口', none.missing.includes('合成入口 elysia_say.py'))

  const scriptPath = 'C:/Users/123/Documents/deepseek-harness/default-workspace/elysia_say.py'
  const fake = checkVoiceTuning({
    scriptPath,
    engineDir: 'Z:/不存在的引擎目录',
    model: 'v5turbo',
    ref: 'R06'
  })
  check('真实脚本路径判定存在', fake.items.find((i) => i.label.startsWith('合成入口'))?.ok === true)
  check('后处理模块清单被列出', fake.items.some((i) => i.label.startsWith('后处理模块') && i.ok === true))
  check('缺失项只报不存在的', fake.missing.every((m) => !m.startsWith('后处理模块')))
  check('缺失项含权重（引擎目录不存在）', fake.missing.some((m) => m.includes('权重')))
  check('参考音频项被列出', fake.items.some((i) => i.label.includes('参考音频 R06')))

  const missingRef = checkVoiceTuning({
    scriptPath: 'Z:/不存在的目录/elysia_say.py',
    engineDir: '',
    model: 'v5turbo',
    ref: 'R06'
  })
  check('脚本目录不存在时参考音频判缺失', missingRef.missing.some((m) => m.includes('参考音频')))
}

console.log('')
console.log(`${pass}/${total} ${pass === total ? '全部通过' : '有失败'}`)
process.exit(pass === total ? 0 : 1)
