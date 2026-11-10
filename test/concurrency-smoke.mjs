/**
 * 并发 / 数据安全自检。
 *
 * 覆盖三条曾经真出过问题的地方：
 *  1. withLock 把「并发调用」误判成「重入」——B 在 A 持锁期间直接放行，
 *     两边读到同一份 raw，后写的覆盖先写的（实测丢过一条）。
 *  2. rebalance 先 commit 再 writeArchive——归档写失败时条目两边都没有，还报成功。
 *  3. 归档只读主侧——主侧缺失时会把镜像归档也删掉。
 *
 * 全程在临时目录里跑，不碰真实记忆。
 * 用法：node test/concurrency-smoke.mjs
 */
import { promises as fsp } from 'node:fs'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = path.join(os.tmpdir(), `elysia-conc-${Date.now()}`)
const logger = { info() {}, warn() {}, error() {} }
const mk = (name, opts = {}) =>
  new MemoryStore({
    primaryPath: path.join(root, name, 'MEMORY.md'),
    mirrorPath: path.join(root, `${name}M`, 'MEMORY.md'),
    entryCap: opts.entryCap ?? 50,
    logger
  })

console.log('1) 并发 withLock 必须排队，不能互相插队')
{
  const store = mk('lock')
  store.bootstrapSync()
  const order = []
  const p1 = store.withLock(async () => {
    order.push('a-in')
    await sleep(40)
    order.push('a-out')
  })
  await sleep(5)
  const p2 = store.withLock(async () => {
    order.push('b-in')
    order.push('b-out')
  })
  await Promise.all([p1, p2])
  check('没有重叠执行', order.join(',') === 'a-in,a-out,b-in,b-out', order.join(','))
}

console.log('2) 真重入（临界区里再进一次）不能死锁')
{
  const store = mk('reent')
  store.bootstrapSync()
  let depth = 0
  await store.withLock(async () => {
    depth += 1
    await store.withLock(async () => {
      depth += 1
    })
  })
  check('嵌套两层都执行了', depth === 2, String(depth))
}

console.log('3) 并发写 10 条：一条都不能丢（旧代码会丢）')
{
  const store = mk('writes')
  store.bootstrapSync()
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.appendEntry('lessons', `并发写入第 ${i} 条`, { scope: 'global' }))
  )
  const text = await fsp.readFile(store.primaryPath, 'utf8')
  const missing = []
  for (let i = 0; i < 10; i++) if (!text.includes(`并发写入第 ${i} 条`)) missing.push(i)
  check('10 条都在主文件里', missing.length === 0, `缺: ${missing.join(',')}`)
}

console.log('4) 归档写失败时，条目必须留在主文件（不能两边都没有）')
{
  const store = mk('archive-fail', { entryCap: 3 })
  store.bootstrapSync()
  const total = 8
  for (let i = 0; i < total; i++) await store.appendEntry('lessons', `分层测试条目 ${i}`, { scope: 'global' })

  // 让归档写入必失败
  const orig = store.writeOne.bind(store)
  store.writeOne = async (target, text) => {
    if (/\.archive\.md$/.test(String(target))) throw new Error('模拟归档写失败')
    return orig(target, text)
  }
  // 再灌几条，逼出一次 rebalance
  for (let i = total; i < total + 4; i++) await store.appendEntry('lessons', `分层测试条目 ${i}`, { scope: 'global' })
  store.writeOne = orig

  const main = await fsp.readFile(store.primaryPath, 'utf8')
  const archive = await fsp.readFile(store.archivePath, 'utf8').catch(() => '')
  const all = main + '\n' + archive
  const lost = []
  for (let i = 0; i < total + 4; i++) if (!all.includes(`分层测试条目 ${i}`)) lost.push(i)
  check('12 条一条都没丢', lost.length === 0, `丢: ${lost.join(',')}`)
}

console.log('5) 归档读取要主+镜像取并集；主侧缺失不能连累镜像')
{
  const store = mk('archive-read')
  store.bootstrapSync()
  // 主侧归档写一份，镜像侧写另一份（模拟两侧不一致）
  await fsp.mkdir(path.dirname(store.archivePath), { recursive: true })
  await fsp.mkdir(path.dirname(store.mirrorArchivePath), { recursive: true })
  await fsp.writeFile(store.archivePath, '# 归档\n\n## lessons\n- [2026-01-01] 只在主侧\n', 'utf8')
  await fsp.writeFile(store.mirrorArchivePath, '# 归档\n\n## lessons\n- [2026-01-02] 只在镜像侧\n', 'utf8')
  const map = store.readArchiveSync()
  const lines = (map.get('lessons') ?? []).join('\n')
  check('读到了主侧的', lines.includes('只在主侧'))
  check('也读到了镜像侧的', lines.includes('只在镜像侧'))

  // 主侧被删掉之后，仍然要读到镜像那份
  await fsp.rm(store.archivePath, { force: true })
  const map2 = store.readArchiveSync()
  check('主侧缺失时回退到镜像', (map2.get('lessons') ?? []).join('\n').includes('只在镜像侧'))
}

console.log('6) 索引孤儿回收：删掉的条目不该继续占索引')
{
  const store = mk('index')
  store.bootstrapSync()
  /*
   * 注意：带 `- [时间]` 前缀的才是「正式条目」——纯文本行不会进索引
   * （工具写入时都走 entryLine，所以真实使用里一定带前缀）。
   */
  await store.appendEntry('lessons', '- [2026-11-11 00:00:00] 会留下来的条目', { scope: 'global' })
  await store.appendEntry('lessons', '- [2026-11-11 00:01:00] 会被删掉的条目', { scope: 'global' })
  const before = Object.keys(store.index.load().entries).length
  check('索引里有 2 条', before === 2, String(before))
  // 直接把正文改成只剩一条
  const body = await fsp.readFile(store.primaryPath, 'utf8')
  const next = body.replace(/^.*会被删掉的条目.*$/m, '')
  await fsp.writeFile(store.primaryPath, next, 'utf8')
  await fsp.writeFile(store.mirrorPath, next, 'utf8')
  await store.reload(true)
  const removed = store.pruneIndexOrphans()
  const after = Object.keys(store.index.load().entries).length
  check('确实回收了', removed >= 1, String(removed))
  check('索引条数变少', after < before, `${before} -> ${after}`)
}

console.log('7) 项目作用域：中文目录不能再塌成同一个键，老条目还要认')
{
  const { projectScope, scopeVisible } = await import('../lib/store.js')
  const dirs = [
    'C:\\项目A\\记忆插件',
    'D:\\项目B\\记忆插件',
    'C:\\work\\记忆',
    'C:\\Users\\x\\default-workspace'
  ]
  const keys = dirs.map((d) => projectScope(d))
  check('四个目录四个不同的键', new Set(keys).size === dirs.length, keys.join(' | '))
  check('纯中文目录退化成 dir-xxx', /^project:dir-[0-9a-f]{6}$/.test(keys[0]), keys[0])
  check('ASCII 目录保留可读名', keys[3].startsWith('project:default-workspace-'), keys[3])
  check('老格式条目仍然可见', scopeVisible('project:default-workspace', keys[3]) === true)
  check('别的作用域不可见', scopeVisible('project:other-abcdef', keys[3]) === false)
  check('global 永远可见', scopeVisible('global', keys[0]) === true)
  check('同一个目录稳定', projectScope(dirs[0]) === keys[0])
}

await fsp.rm(root, { recursive: true, force: true }).catch(() => {})

console.log('')
if (problems.length) {
  console.log(`concurrency-smoke: ${problems.length} 项失败`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('concurrency-smoke: 全部通过')
