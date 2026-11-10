/**
 * relocate / destroyBoth 的安全性自检。
 *
 * 起因：`relocate` 原来在 `await this.writeBoth(text)` 之后**无条件**删旧文件。
 * 而 writeBoth 的策略是「任一侧成功就算成功」（只有两侧全失败才 throw），
 * 所以「新主位置写不进去、新镜像写成功」时它不抛错 → 旧主文件被删 →
 * 用户的记忆静默降级成只剩一份镜像。反过来同理。
 *
 * 顺带盯住两件事：
 *   · 归档（MEMORY.archive.md）与 .history 快照要跟着搬，别在新目录里丢；
 *   · destroyBoth 要连 .history 一起清，否则「清空」之后 rollback 还能把记忆复活。
 *
 * 全程在临时目录里跑，不碰真实记忆。
 * 用法：node test/relocate-smoke.mjs
 */
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { MemoryStore } = await import('../lib/store.js')

const problems = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    problems.push(name)
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}
const exists = (p) => existsSync(p)

const root = path.join(os.tmpdir(), `elysia-relocate-${Date.now()}`)
const logger = { info() {}, warn() {}, error() {} }

console.log('1) 正常迁移：新位置可写 → 旧文件删除，附属文件跟着搬')
{
  const A = path.join(root, 'A', 'MEMORY.md')
  const M = path.join(root, 'AM', 'MEMORY.md')
  const store = new MemoryStore({ primaryPath: A, mirrorPath: M, entryCap: 20, logger })
  store.bootstrapSync()
  await store.appendEntry('lessons', '迁移前写入的一条教训', { scope: 'global' })
  // 造一份归档与一份历史快照
  await fsp.writeFile(store.archivePath, '# 归档\n\n- 旧条目\n', 'utf8')
  await fsp.mkdir(store.historyDir, { recursive: true })
  await fsp.writeFile(path.join(store.historyDir, '2026-01-01T00-00-00-000Z.md'), '# 旧快照\n', 'utf8')

  const nextP = path.join(root, 'B', 'MEMORY.md')
  const nextM = path.join(root, 'BM', 'MEMORY.md')
  const st = await store.relocate(nextP, nextM)

  check('新主生效', st.primaryPath === path.resolve(nextP), st.primaryPath)
  check('新镜像生效', st.mirrorPath === path.resolve(nextM), st.mirrorPath)
  check('内容搬过去了', (await fsp.readFile(nextP, 'utf8')).includes('迁移前写入的一条教训'))
  check('旧主已删除', !exists(A))
  check('旧镜像已删除', !exists(M))
  check('归档搬到新目录了', exists(path.join(root, 'B', 'MEMORY.archive.md')), store.archivePath)
  check('历史快照搬到新目录了', exists(path.join(path.dirname(nextP), '.history')))
  check('旧历史目录已清空', !exists(path.join(path.dirname(A), '.history')))
}

console.log('2) 新主位置不可写：**绝不能**删旧主文件（数据安全）')
{
  const A = path.join(root, 'C', 'MEMORY.md')
  const M = path.join(root, 'CM', 'MEMORY.md')
  const store = new MemoryStore({ primaryPath: A, mirrorPath: M, entryCap: 20, logger })
  store.bootstrapSync()
  await store.appendEntry('lessons', '这条不能被迁丢', { scope: 'global' })
  const oldText = await fsp.readFile(A, 'utf8')

  // Z: 盘不存在 → writeOne 必失败；镜像位仍可写
  const badPrimary = path.join('Z:', 'nope', 'MEMORY.md')
  const goodMirror = path.join(root, 'CM2', 'MEMORY.md')
  await store.relocate(badPrimary, goodMirror)

  check('旧主文件还在', exists(A), A)
  check('旧主内容完整', exists(A) && (await fsp.readFile(A, 'utf8')) === oldText)
  check('新镜像确实写了', exists(goodMirror))
}

console.log('3) destroyBoth 要连 .history 一起清（否则 rollback 能复活）')
{
  const A = path.join(root, 'D', 'MEMORY.md')
  const M = path.join(root, 'DM', 'MEMORY.md')
  const store = new MemoryStore({ primaryPath: A, mirrorPath: M, entryCap: 20, logger })
  store.bootstrapSync()
  await store.appendEntry('lessons', '清空前的记忆', { scope: 'global' })
  const histDir = store.historyDir
  check('清空前有历史目录', exists(histDir))

  const tomb = path.join(root, 'deleted.json')
  const r = await store.destroyBoth(tomb)
  check('返回里记录了删除项', r.removed.length >= 2, String(r.removed.length))
  check('主文件没了', !exists(A))
  check('镜像没了', !exists(M))
  check('历史目录没了', !exists(histDir), histDir)
  check('tombstone 写出来了', exists(tomb))
}

await fsp.rm(root, { recursive: true, force: true }).catch(() => {})

console.log('')
if (problems.length) {
  console.log(`relocate-smoke: ${problems.length} 项失败`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('relocate-smoke: 全部通过')
