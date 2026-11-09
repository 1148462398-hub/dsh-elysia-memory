/**
 * 严格可逆验证：在**真实** MEMORY.md 上走完整的「覆盖 → 卸载恢复 → 还原原文」路径。
 *
 * ⚠️ 这个脚本会写真实记忆文件。所以：
 *    - 必须显式设 DSH_ALLOW_REAL_MEMORY_TEST=1 才会执行（否则直接退出，防止误跑）
 *    - 执行前把主 + 镜像原文拷到 .real-overwrite-check-<时间戳>/
 *    - 无论中途成败，finally 里都会把原文双写回去并核对 hash
 *    - 跑完建议肉眼确认一次：git status / 打开 MEMORY.md 看一眼
 *
 * 用法：
 *   PowerShell:  $env:DSH_ALLOW_REAL_MEMORY_TEST=1; node test/real-overwrite-reversibility.mjs
 *   bash:        DSH_ALLOW_REAL_MEMORY_TEST=1 node test/real-overwrite-reversibility.mjs
 *
 * 不设环境变量时它会打印说明并退出 0，因此放进 CI / npm test 也是安全的。
 */
import { readFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { MemoryStore, SECTIONS, parseSections, hashText } from '../lib/store.js'
import { listPacks, installPack, uninstallPack, packStatus, packsDir } from '../lib/packs.js'

if (process.env.DSH_ALLOW_REAL_MEMORY_TEST !== '1') {
  console.log('跳过：这个测试会写真实 MEMORY.md。')
  console.log('要跑请设 DSH_ALLOW_REAL_MEMORY_TEST=1 再执行。')
  console.log('（不跑也没关系：test/packs-smoke.mjs 已经在临时目录里覆盖了全部核心逻辑）')
  process.exit(0)
}

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PRIMARY = process.env.DSH_MEMORY_PRIMARY || path.join(HOME, 'dsh-shared-memory', 'MEMORY.md')
const MIRROR = process.env.DSH_MEMORY_MIRROR ?? ''

const SAFETY = path.join(path.dirname(PRIMARY), `.real-overwrite-check-${Date.now()}`)

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}
const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n')

mkdirSync(SAFETY, { recursive: true })
const origPrimary = readFileSync(PRIMARY, 'utf8')
copyFileSync(PRIMARY, path.join(SAFETY, 'PRIMARY.md'))
const hasMirror = Boolean(MIRROR) && existsSync(MIRROR)
if (hasMirror) copyFileSync(MIRROR, path.join(SAFETY, 'MIRROR.md'))
console.log(`安全副本：${SAFETY}`)
console.log(`原文 ${origPrimary.length} 字`)

const store = new MemoryStore({
  primaryPath: PRIMARY,
  mirrorPath: hasMirror ? MIRROR : '',
  logger: { info() {}, warn: (m) => console.log(`  [warn] ${m}`), error() {} }
})
await store.init()

const originalHashes = Object.fromEntries(SECTIONS.map((s) => [s, hashText(norm(parseSections(store.raw)[s]))]))
const packIdentityHash = hashText(norm(readFileSync(path.join(packsDir(), 'elysia', 'identity.md'), 'utf8')).trim())
const packPersonaHash = hashText(norm(readFileSync(path.join(packsDir(), 'elysia', 'persona.md'), 'utf8')).trim())

try {
  console.log('\n1) 写入一段用户自有内容（模拟"我已经有自己的记忆"）')
  const userIdentity = '# 我自己的记忆\n\n- 这一行是用户自己写的，绝不能丢。\n- 记忆包安装会覆盖它，卸载必须把它还回来。'
  const userPersona = '你是一名务实的工程助手。\n这一行也是用户自己写的人设，卸载后必须原样回来。'
  await store.setSection('identity', userIdentity)
  await store.setSection('persona', userPersona)
  await store.reload(true)
  const userSections = parseSections(store.raw)
  check('identity 已改成用户自有内容', userSections.identity.includes('绝不能丢'))
  check('persona 已改成用户自有内容', userSections.persona.includes('卸载后必须原样回来'))
  const userIdentityHash = hashText(norm(userSections.identity))
  const userPersonaHash = hashText(norm(userSections.persona))
  const othersBefore = {}
  for (const s of SECTIONS) {
    if (s === 'identity' || s === 'persona') continue
    othersBefore[s] = hashText(norm(parseSections(store.raw)[s]))
  }

  console.log('\n2) 安装（会真的覆盖用户自有内容）')
  const applied = await installPack(store, 'elysia', { confirm: true })
  check('安装成功', applied.ok === true, applied.error)
  check('确实覆盖了用户内容', applied.overwritesUserContent === true)
  check('两个分区都真的写了', applied.written.includes('identity') && applied.written.includes('persona'), JSON.stringify(applied.written))
  check('备份目录已生成', Boolean(applied.backupDir) && existsSync(applied.backupDir))

  await store.reload(true)
  const instSections = parseSections(store.raw)
  check('identity 现在是包内容', hashText(norm(instSections.identity).trim()) === packIdentityHash)
  check('persona 现在是包内容', hashText(norm(instSections.persona).trim()) === packPersonaHash)
  check('用户原话已经被覆盖（确实不在了）', !instSections.identity.includes('绝不能丢'))
  check(
    '其它 8 个分区 hash 全未变',
    Object.keys(othersBefore).every((s) => othersBefore[s] === hashText(norm(parseSections(store.raw)[s])))
  )
  check('status = 已安装', (await packStatus(store)).packs.find((p) => p.id === 'elysia')?.installed === true)

  console.log('\n3) 卸载（必须还回用户自己那份，而不是默认占位）')
  const off = await uninstallPack(store, 'elysia')
  check('卸载成功', off.ok === true)
  check('从备份恢复（不是复位默认）', off.restoredFromBackup.length === 2 && off.restoredToDefault.length === 0, JSON.stringify(off))

  await store.reload(true)
  const backSections = parseSections(store.raw)
  check('identity 恢复成用户那份', hashText(norm(backSections.identity)) === userIdentityHash)
  check('persona 恢复成用户那份', hashText(norm(backSections.persona)) === userPersonaHash)
  check('用户原话回来了', backSections.identity.includes('绝不能丢') && backSections.persona.includes('卸载后必须原样回来'))
  check('没有退化成默认占位', !backSections.identity.includes('自我记忆（尚未导入）'))
  check(
    '其它 8 个分区仍然未变',
    Object.keys(othersBefore).every((s) => othersBefore[s] === hashText(norm(parseSections(store.raw)[s])))
  )
} finally {
  console.log('\n4) 还原原始 MEMORY.md（双写）并核对')
  await store.writeBoth(origPrimary)
  await store.reload(true)
  const finalSections = parseSections(store.raw)
  check('还原后 10 个分区 hash 全等于最初', SECTIONS.every((s) => hashText(norm(finalSections[s])) === originalHashes[s]))
  check('主文件逐字等于安全副本', readFileSync(PRIMARY, 'utf8') === origPrimary)
  if (hasMirror) check('镜像逐字等于原文', norm(readFileSync(MIRROR, 'utf8')) === norm(origPrimary))
  console.log(`安全副本保留：${SAFETY}`)
}

console.log('')
if (problems.length) {
  console.log(`失败 ${problems.length} 项：${problems.join(' / ')}`)
  process.exit(1)
}
console.log('严格可逆验证（覆盖 → 卸载恢复 → 还原原文）全部通过')
