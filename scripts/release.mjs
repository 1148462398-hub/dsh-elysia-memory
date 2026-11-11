/**
 * scripts/release.mjs
 *
 * 一条命令发一个版本：跑测试 → 打包 tgz → 推到 GitHub → 建 Release → 更新市场条目 → 开 PR。
 *
 *   $env:GITHUB_TOKEN = 'github_pat_xxx'
 *   node scripts/release.mjs
 *
 * 可选环境变量：
 *   GH_MARKET=0   只发 GitHub，不动市场
 *   GH_SKIP_TESTS=1  跳过测试（不推荐；只在明确知道改动无关时用）
 *   GH_TAG_NOTES  Release 正文（也会写进 GitHub Release）
 *
 * 为什么要有这个脚本：发版是四步，而且顺序不能错——
 *   tgz 必须先打出来，市场条目里的 tarball 地址必须指向这个版本的资产，
 *   所以「更新 YAML」只能发生在打完之后、推送之前。
 *   手工做很容易忘掉其中一步，结果市场里挂着一个 404 的 tarball。
 */

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const OWNER = process.env.GH_OWNER || '1148462398-hub'
const REPO = process.env.GH_REPO || 'dsh-elysia-memory'
const SKIP_TESTS = process.env.GH_SKIP_TESTS === '1'
const WITH_MARKET = process.env.GH_MARKET !== '0'
const node = process.execPath

const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'))
const tag = `v${pkg.version}`
const TGZ_NAME = `${pkg.name}-${pkg.version}.tgz`
const RELEASE_DIR = path.join(ROOT, '.release')
const STAGE = path.join(RELEASE_DIR, 'stage')
const TGZ = path.join(RELEASE_DIR, TGZ_NAME)
const TARBALL_URL = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${TGZ_NAME}`

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))))
  })
}

async function copyInto(src, destRoot, rel) {
  const abs = path.join(src, rel)
  const stat = await fsp.stat(abs).catch(() => null)
  if (!stat) throw new Error(`package.json files 里列了 ${rel}，但目录里没有`)
  if (stat.isDirectory()) {
    for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
      await copyInto(src, destRoot, path.join(rel, entry.name))
    }
    return
  }
  if (/\.bak/i.test(rel) || path.basename(rel).startsWith('_')) return
  const target = path.join(destRoot, rel)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.copyFile(abs, target)
}

/** 按 package.json 的 files 字段铺一个 package/ 目录，再打 tar.gz */
async function buildTarball() {
  await fsp.rm(RELEASE_DIR, { recursive: true, force: true })
  const pkgRoot = path.join(STAGE, 'package')
  await fsp.mkdir(pkgRoot, { recursive: true })

  for (const entry of pkg.files ?? []) {
    // files 里可以写 lib/*.js 这种通配，铺目录时只取目录本身
    const rel = entry.includes('*') ? path.dirname(entry) : entry
    await copyInto(ROOT, pkgRoot, rel)
  }
  // package.json 永远要在包根
  await fsp.copyFile(path.join(ROOT, 'package.json'), path.join(pkgRoot, 'package.json'))

  await run('tar', ['-czf', TGZ, '-C', STAGE, 'package'])
  const stat = await fsp.stat(TGZ)
  console.log(`已打包 ${TGZ_NAME}（${(stat.size / 1024).toFixed(0)} KB）`)

  // 自检：头像和 cordis patch 必须真在包里，否则用户装上去是半残的
  const list = await new Promise((resolve, reject) => {
    const chunks = []
    const child = spawn('tar', ['-tzf', TGZ], { stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', (c) => chunks.push(c))
    child.on('error', reject)
    child.on('exit', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
  for (const must of ['package/assets/elysia-avatar.png', 'package/dsh/cordis.patch.yml', 'package/lib/index.js', 'package/lib/client.js']) {
    if (!list.includes(must)) throw new Error(`打出来的包里缺 ${must}`)
  }
  console.log('包内容自检通过（头像 / patch / 宿主 / 客户端 都在）')
}

/** 市场条目的 tarball 地址必须指到本版本，否则市场里挂的是 404 */
async function syncMarketEntry() {
  const file = path.join(ROOT, 'market', `${OWNER}__${pkg.name}.yml`)
  const text = await fsp.readFile(file, 'utf8')
  const next = text.replace(/^tarball:\s*\S+$/m, `tarball: ${TARBALL_URL}`)
  if (next !== text) {
    await fsp.writeFile(file, next, 'utf8')
    console.log(`市场条目的 tarball 已指向 ${tag}`)
  } else {
    console.log('市场条目的 tarball 已是本版本')
  }
  return file
}

async function main() {
  console.log(`发版：${pkg.name} ${tag}`)

  if (!SKIP_TESTS) {
    for (const t of ['smoke', 'packs-smoke', 'client-smoke', 'voice-smoke', 'bubble-smoke', 'voiceinstall-smoke', 'relocate-smoke', 'housekeeping-smoke', 'concurrency-smoke', 'device-smoke', 'engine-fail-smoke', 'observations-smoke', 'senses-smoke', 'bilibili-smoke']) {
      console.log(`\n=== test/${t}.mjs ===`)
      await run(node, [path.join('test', `${t}.mjs`)])
    }
  }

  await buildTarball()
  await syncMarketEntry()

  console.log('\n=== 推 GitHub ===')
  await run(node, [path.join('scripts', 'publish-github.mjs'), ROOT], {
    env: { ...process.env, GH_OWNER: OWNER, GH_REPO: REPO, GH_TGZ: TGZ }
  })

  if (WITH_MARKET) {
    console.log('\n=== 更新市场 ===')
    await run(node, [path.join('scripts', 'open-market-pr.mjs')], {
      env: { ...process.env, GH_OWNER: OWNER }
    })
  } else {
    console.log('\nGH_MARKET=0：跳过市场 PR')
  }

  console.log('')
  console.log(`完成 ${tag}`)
  console.log(`仓库：https://github.com/${OWNER}/${REPO}`)
  console.log(`Release：https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`)
  console.log(`Tarball：${TARBALL_URL}`)
}

main().catch((error) => {
  console.error('\n发版失败：' + error.message)
  process.exit(1)
})
