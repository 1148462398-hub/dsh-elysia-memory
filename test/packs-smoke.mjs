/**
 * 记忆包端到端自检（全部在临时目录里跑，绝不碰真实 MEMORY.md）。
 * 用法：node test/packs-smoke.mjs
 */
import { promises as fsp, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { MemoryStore, SECTIONS } from '../lib/store.js'
import { DEFAULT_IDENTITY, DEFAULT_PERSONA, hashText } from '../lib/store.js'
import {
  listPacks,
  readPack,
  previewPack,
  installPack,
  uninstallPack,
  packStatus,
  packsDir,
  backupRoot
} from '../lib/packs.js'

const root = path.join(os.tmpdir(), `shared-memory-packs-${Date.now()}`)
const primary = path.join(root, 'A', 'MEMORY.md')
const mirror = path.join(root, 'B', 'MEMORY.md')

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

const logger = { info() {}, warn() {}, error() {} }
const store = new MemoryStore({ primaryPath: primary, mirrorPath: mirror, logger })

const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n').trim()

await fsp.mkdir(path.dirname(primary), { recursive: true })
await fsp.mkdir(path.dirname(mirror), { recursive: true })
await store.init()

const packIdentity = norm(readFileSync(path.join(packsDir(), 'elysia', 'identity.md'), 'utf8'))
const packPersona = norm(readFileSync(path.join(packsDir(), 'elysia', 'persona.md'), 'utf8'))

console.log('1) list：能看到 elysia')
{
  const packs = listPacks()
  check('packs/ 扫到 1 个包', packs.length === 1, String(packs.length))
  const ely = packs[0]
  check('id 是 elysia', ely?.id === 'elysia')
  check('manifest 版本可读', ely?.version === '1.0.0', ely?.version)
  check('identity 字数与文件一致', ely?.sections.identity.chars === packIdentity.length, `${ely?.sections.identity.chars} vs ${packIdentity.length}`)
  check('persona 字数与文件一致', ely?.sections.persona.chars === packPersona.length, `${ely?.sections.persona.chars} vs ${packPersona.length}`)
  check('identity hash 与文件一致', ely?.sections.identity.hash === hashText(packIdentity))
  check('两个分区都存在', ely?.sections.identity.exists && ely?.sections.persona.exists)
}

console.log('2) preview：前 2000 字 + 章节')
{
  const pv = await previewPack('elysia')
  check('identity 预览 2000 字', pv.preview.identity.head.length === 2000, String(pv.preview.identity.head.length))
  check('identity 标了截断', pv.preview.identity.truncated === true)
  check('identity 章节 9 章', pv.preview.identity.chapters.length === 9, String(pv.preview.identity.chapters.length))
  check('章节里含「语料来源」', pv.preview.identity.chapters.includes('语料来源'))
  check('persona 也截到 2000 字', pv.preview.persona.head.length === 2000 && pv.preview.persona.truncated === true, String(pv.preview.persona.head.length))
  check('persona 全文字数 > 2000', pv.preview.persona.chars > 2000, String(pv.preview.persona.chars))
  check('persona 章节可读', pv.preview.persona.chapters.length > 0, String(pv.preview.persona.chapters.length))
  check('预览带 warnings', Array.isArray(pv.warnings) && pv.warnings.length >= 2)
  check('预览 head 是文档开头', pv.preview.identity.head.startsWith('# 爱莉希雅'))
}

console.log('3) install 不带 confirm：只给计划，不写文件')
{
  const before = store.view()
  const r = await installPack(store, 'elysia', {})
  check('返回 needsConfirm', r.needsConfirm === true)
  check('计划含 identity 与 persona', r.plan.length === 2 && r.plan.every((p) => p.willWrite))
  check('未写 identity', norm(store.view().sections.identity) === norm(before.sections.identity))
  check('未写 persona', norm(store.view().sections.persona) === norm(before.sections.persona))
  check('还没有备份目录', !existsSync(backupRoot(store)))
  check('message 里要求 confirm', /confirm/i.test(r.message), r.message)
}

console.log('4) install 带 confirm：写入 + 备份')
{
  const beforeSections = store.view().sections
  const beforeOthers = Object.fromEntries(
    SECTIONS.filter((s) => s !== 'identity' && s !== 'persona').map((s) => [s, norm(beforeSections[s])])
  )
  const r = await installPack(store, 'elysia', { confirm: true })
  check('安装成功', r.ok === true, r.error)
  check('写了 identity 和 persona', r.written.includes('identity') && r.written.includes('persona'), JSON.stringify(r.written))
  check('备份目录已生成', Boolean(r.backupDir) && existsSync(r.backupDir), r.backupDir)

  const after = store.view().sections
  check('identity 字数与包一致', norm(after.identity).length === packIdentity.length, `${norm(after.identity).length} vs ${packIdentity.length}`)
  check('persona 字数与包一致', norm(after.persona).length === packPersona.length, `${norm(after.persona).length} vs ${packPersona.length}`)
  check('identity hash 与包一致', hashText(norm(after.identity)) === hashText(packIdentity))
  check('persona hash 与包一致', hashText(norm(after.persona)) === hashText(packPersona))

  const othersSame = SECTIONS.filter((s) => s !== 'identity' && s !== 'persona')
    .every((s) => norm(after[s]) === beforeOthers[s])
  check('其它 8 个分区一字未变', othersSame)

  check('备份里有 identity.md', existsSync(path.join(r.backupDir, 'identity.md')))
  check('备份里有 persona.md', existsSync(path.join(r.backupDir, 'persona.md')))
  check('备份里有 meta.json', existsSync(path.join(r.backupDir, 'meta.json')))
  const meta = JSON.parse(readFileSync(path.join(r.backupDir, 'meta.json'), 'utf8'))
  check('meta 记了安装时间', Boolean(meta.installedAt))
  check('meta 记了当时是默认占位', meta.sections.identity.wasDefault === true && meta.sections.persona.wasDefault === true)
  const backupIdentity = readFileSync(path.join(r.backupDir, 'identity.md'), 'utf8')
  check('备份的 identity 是安装前那份', norm(backupIdentity) === norm(beforeSections.identity))
  const backupPersona = readFileSync(path.join(r.backupDir, 'persona.md'), 'utf8')
  check('备份的 persona 是安装前那份', norm(backupPersona) === norm(beforeSections.persona))
  check('镜像文件也同步了', readFileSync(mirror, 'utf8').includes('爱莉希雅'))
  check('状态文件已写', existsSync(store.primaryPath.replace(/[^\\/]+$/, '.packs-state.json')))
}

console.log('5) status：显示已安装（按 hash 判断）')
{
  const st = await packStatus(store)
  const ely = st.packs.find((p) => p.id === 'elysia')
  check('installed 为 true', ely?.installed === true)
  check('fullyInstalled 为 true', ely?.fullyInstalled === true)
  check('identity 与包一致', ely?.sections.identity.installed === true)
  check('persona 与包一致', ely?.sections.persona.installed === true)
  check('记录了安装时间', Boolean(ely?.record?.installedAt))
  check('记录里带备份目录', Boolean(ely?.record?.backupDir))
  check('installed 列表含 elysia', st.installed.includes('elysia'))
}

console.log('6) 冲突检测：用户自写内容会被识别为「将覆盖」')
{
  await store.setSection('identity', '# 我自己的记忆\n\n这条是用户自己写的，不是默认占位。')
  const st = await packStatus(store)
  const ely = st.packs.find((p) => p.id === 'elysia')
  check('hash 不匹配 → 显示未装', ely?.sections.identity.installed === false)
  check('识别为用户自定义', ely?.sections.identity.customized === true)
  check('不再认为 isDefault', ely?.sections.identity.isDefault === false)

  const plan = await installPack(store, 'elysia', {})
  check('计划里标了会覆盖用户内容', plan.overwritesUserContent === true)
  check('计划理由指向 identity', plan.plan.find((p) => p.section === 'identity')?.overwritesUserContent === true)

  const r = await installPack(store, 'elysia', { confirm: true })
  check('覆盖型安装也成功', r.ok === true)
  check('覆盖后与包一致', hashText(norm(store.view().sections.identity)) === hashText(packIdentity))
  const meta = JSON.parse(readFileSync(path.join(r.backupDir, 'meta.json'), 'utf8'))
  check('这次的备份记下 wasDefault=false', meta.sections.identity.wasDefault === false)
  const backedUp = readFileSync(path.join(r.backupDir, 'identity.md'), 'utf8')
  check('备份保住了用户自己那份', backedUp.includes('这条是用户自己写的'))
}

console.log('7) uninstall：从备份恢复')
{
  const st = await packStatus(store)
  const record = st.packs.find((p) => p.id === 'elysia').record
  const r = await uninstallPack(store, 'elysia')
  check('卸载成功', r.ok === true)
  check('两个分区都从备份恢复', r.restoredFromBackup.includes('identity') && r.restoredFromBackup.includes('persona'), JSON.stringify(r.restoredFromBackup))
  check('identity 恢复成用户那份', store.view().sections.identity.includes('这条是用户自己写的'))
  check('状态文件已移除记录', !(await packStatus(store)).records.elysia)
  check('备份目录还在（留证据）', existsSync(record.backupDir))
  const st2 = await packStatus(store)
  const ely2 = st2.packs.find((p) => p.id === 'elysia')
  // 第二次安装是在「persona 已是包内容」的基础上做的，所以卸载把 persona 还原成
  // 第二次安装前的样子 = 包内容。identity 则还原成用户自己那份 → 未装。
  check('identity 已不是包内容 → 未装', ely2?.sections.identity.installed === false)
  check('persona 还原成第二次安装前的状态（仍是包内容）', ely2?.sections.persona.installed === true)
  check('整体不算完整安装', ely2?.fullyInstalled === false)
}

console.log('8) uninstall 无备份 → 复位默认')
{
  // 手工清掉状态文件里的记录，模拟"备份丢了"
  const stateFile = store.primaryPath.replace(/[^\\/]+$/, '.packs-state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  delete state.packs.elysia
  await fsp.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')

  const r = await uninstallPack(store, 'elysia')
  check('没有备份时复位默认', r.restoredToDefault.includes('identity') && r.restoredToDefault.includes('persona'))
  check('identity 回到默认占位', norm(store.view().sections.identity) === norm(DEFAULT_IDENTITY.join('\n')))
  check('persona 回到默认人设', norm(store.view().sections.persona) === norm(DEFAULT_PERSONA))
}

console.log('9) 边界：非法 id / 不存在的包')
{
  let err = ''
  try {
    await readPack('../evil')
  } catch (e) {
    err = e.message
  }
  check('路径穿越被拒', err.includes('非法'), err)
  let err2 = ''
  try {
    await installPack(store, 'nope', { confirm: true })
  } catch (e) {
    err2 = e.message
  }
  check('不存在的包报错', err2.includes('没有这个记忆包'), err2)
}

console.log('10) 只写两个分区（结构层面保证）')
{
  const { PACK_SECTIONS } = await import('../lib/packs.js')
  check('PACK_SECTIONS 正好是 identity + persona', PACK_SECTIONS.length === 2 && PACK_SECTIONS.includes('identity') && PACK_SECTIONS.includes('persona'))
  check('PACK_SECTIONS 不含 methodbook', !PACK_SECTIONS.includes('methodbook'))
}

await fsp.rm(root, { recursive: true, force: true })

console.log('')
if (problems.length) {
  console.log(`失败 ${problems.length} 项：${problems.join(' / ')}`)
  process.exit(1)
}
console.log('记忆包自检全部通过')
