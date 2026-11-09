/**
 * scripts/publish-github.mjs
 *
 * 没有 git 的环境里把插件目录发布到 GitHub：全程走 Git Data API。
 *
 *   $env:GITHUB_TOKEN = 'github_pat_xxx'
 *   node scripts/publish-github.mjs            # 发布当前目录
 *   node scripts/publish-github.mjs <dir>      # 发布指定目录
 *
 * 可选环境变量：
 *   GH_OWNER    默认 1148462398-hub
 *   GH_REPO     默认 dsh-elysia-memory
 *   GH_BRANCH   默认 main
 *   GH_PRIVATE  1 = 私有（默认公开）
 *   GH_PREFIX   monorepo 子目录
 *   GH_RELEASE  0 = 只推代码、不建 Release（默认建）
 *   GH_TGZ      要传成 Release 资产的 tarball 路径（可选）
 *   GH_NOTES    Release 正文（可选；默认用 package.json 的 description 前三句）
 *   GH_DRY      1 = 只打印将要发布哪些文件，不发任何网络请求
 *
 * 做的事：仓库不存在就建 → 逐文件建 blob → 建 tree → 建 commit → 更新分支
 *        → 打 v<version> 标签 → 建/更新 Release →（可选）上传 tarball 资产。
 *
 * ★ 白名单必须跟着 package.json 的 files 一起长。
 *   上一次漏了 assets/ 和 docs/，结果从 GitHub 装的人气泡头像是破图。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

const OWNER = process.env.GH_OWNER || '1148462398-hub'
const REPO = process.env.GH_REPO || 'dsh-elysia-memory'
const TOKEN = process.env.GITHUB_TOKEN || ''
const BRANCH = process.env.GH_BRANCH || 'main'
const PRIVATE = process.env.GH_PRIVATE === '1'
const DRY = process.env.GH_DRY === '1'
const WANT_RELEASE = process.env.GH_RELEASE !== '0'
const TGZ = process.env.GH_TGZ || ''
const ROOT = path.resolve(process.argv[2] || '.')
/** 推到仓库里的子目录（monorepo 用，例如 packages/dsh-elysia-memory） */
const PREFIX = String(process.env.GH_PREFIX || '').replace(/^\/+|\/+$/g, '')

const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'

/**
 * 跟着 package.json 的 files 走。
 * 少一个目录，别人拿到的东西就是残缺的（assets 缺了 = 气泡头像破图，
 * docs 缺了 = 语音调校手册没了，test 缺了 = 别人没法自检）。
 */
const KEEP = [
  'package.json',
  'README.md',
  'AGENTS.md',
  'LICENSE',
  '.gitignore',
  'lib',
  'dsh',
  'scripts',
  'test',
  'market',
  'assets',
  'docs',
  'packs'
]
const SKIP_DIRS = new Set(['node_modules', '.git', '.history', 'dist', '.bak_rename', '.packs-backup'])

/**
 * 仓库里已经不该存在的路径（改名 / 草稿文件留下的尸体）。
 * Git Data API 是用 base_tree 增量更新的：不显式列出来删，它就一直在。
 */
const PRUNE = [
  'scripts/_apply-probe.mjs',
  'market/1148462398-hub__dsh-shared-memory.yml',
  'market/1148462398-hub__dsh-elysia.yml'
]

if (!TOKEN && !DRY) {
  console.error('缺少 GITHUB_TOKEN 环境变量（GitHub 不允许用密码调用 API，必须用 Personal Access Token）')
  process.exit(2)
}

async function api(method, route, body, raw) {
  const url = raw?.base ? raw.base + route : API + route
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-elysia-memory-publisher'
  }
  if (raw) headers['content-type'] = raw.contentType
  else headers['content-type'] = 'application/json'

  const res = await fetch(url, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const detail = json?.message || String(text).slice(0, 200)
    const error = new Error(`${method} ${route} -> ${res.status} ${detail}`)
    error.status = res.status
    throw error
  }
  return json
}

async function ensureRepo() {
  try {
    const repo = await api('GET', `/repos/${OWNER}/${REPO}`)
    console.log(`仓库已存在：${repo.full_name}（${repo.private ? '私有' : '公开'}）`)
    return repo
  } catch (error) {
    if (error.status !== 404) throw error
    console.log(`仓库不存在，创建 ${OWNER}/${REPO} …`)
    try {
      const created = await api('POST', '/user/repos', {
        name: REPO,
        private: PRIVATE,
        description: 'Elysia (爱莉希雅) lives in your DeepSeek Harness: one shared Markdown memory, her voice, her stickers.',
        has_issues: true,
        has_wiki: false,
        auto_init: false
      })
      console.log(`已创建：${created.html_url}`)
      return created
    } catch (createError) {
      throw new Error(
        `建仓库失败（${createError.message}）。细粒度 token 没有"创建仓库"权限，` +
          `请在网页上先建空仓库，或用 GH_REPO=<已有仓库> + GH_PREFIX=<子目录> 推成 monorepo。`
      )
    }
  }
}

/** 不该进仓库的东西：下划线开头的草稿、.bak 备份、.tmp 临时文件、日志、锁、真实记忆 */
function shouldSkip(rel) {
  const base = path.basename(rel)
  if (base === '.gitignore') return false
  if (base.startsWith('.')) return true
  if (base.startsWith('_')) return true
  if (/\.bak/i.test(base)) return true
  if (/^\.tmp/i.test(base)) return true
  if (/\.(log|lock)$/i.test(base)) return true
  if (/^(MEMORY\.|\.conflict-)/i.test(base)) return true
  return false
}

async function collectFiles(dir, prefix = '') {
  const out = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.')) continue
      out.push(...(await collectFiles(path.join(dir, entry.name), rel)))
    } else if (entry.isFile()) {
      if (shouldSkip(rel)) continue
      out.push(rel)
    }
  }
  return out
}

function keep(rel) {
  return KEEP.some((entry) => rel === entry || rel.startsWith(entry + '/'))
}

function withPrefix(rel) {
  return PREFIX ? `${PREFIX}/${rel}` : rel
}

/** Release 正文：优先 GH_NOTES，否则用一句通用说明 + 版本号 */
function releaseNotes(pkg) {
  if (process.env.GH_NOTES && process.env.GH_NOTES.trim()) return process.env.GH_NOTES.trim()
  return [
    `## ${pkg.name} v${pkg.version}`,
    '',
    '这个版本可以直接用：',
    '',
    '```powershell',
    `dsh plugin --profile web add ${pkg.name}`,
    '```',
    '',
    '源码 / 更新日志见仓库根目录的 `README.md`。'
  ].join('\n')
}

async function upsertTag(sha, tag) {
  try {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/tags/${tag}`, sha })
    console.log(`已打标签 ${tag}`)
  } catch (error) {
    if (error.status !== 422) throw error
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/tags/${tag}`, { sha, force: true })
    console.log(`标签 ${tag} 已存在，已指到新提交`)
  }
}

async function upsertRelease(tag, pkg) {
  let release = null
  try {
    release = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`)
    console.log(`Release ${tag} 已存在，更新它`)
    release = await api('PATCH', `/repos/${OWNER}/${REPO}/releases/${release.id}`, {
      name: `${pkg.name} ${tag}`,
      body: releaseNotes(pkg)
    })
  } catch (error) {
    if (error.status !== 404) throw error
    release = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: tag,
      name: `${pkg.name} ${tag}`,
      body: releaseNotes(pkg),
      draft: false,
      prerelease: false
    })
    console.log(`已建 Release ${tag}`)
  }
  return release
}

async function uploadAsset(release, filePath) {
  if (!filePath) return
  const name = path.basename(filePath)
  try {
    const assets = await api('GET', `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`)
    const old = (assets || []).find((a) => a.name === name)
    if (old) {
      await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${old.id}`)
      console.log(`删掉旧资产 ${name}`)
    }
  } catch (error) {
    if (error.status !== 404) throw error
  }
  const buffer = await fsp.readFile(filePath)
  const asset = await api('POST', `/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, buffer, {
    base: UPLOADS,
    contentType: 'application/gzip'
  })
  console.log(`已上传资产 ${asset.name}（${(asset.size / 1024).toFixed(0)} KB）`)
  return asset
}

async function main() {
  console.log(`发布目录：${ROOT}${PREFIX ? ` → 仓库子目录 ${PREFIX}/` : ''}`)

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const tag = `v${pkg.version}`
  const all = (await collectFiles(ROOT)).filter(keep).sort()
  if (!all.length) throw new Error('没有可发布的文件（检查 KEEP 白名单）')

  console.log(`版本 ${pkg.version}，待发布文件 ${all.length} 个：`)
  for (const rel of all) console.log(`  + ${withPrefix(rel)}`)

  // 关键目录缺席 = 装上去是残缺的，直接拦住
  for (const must of ['lib/index.js', 'lib/client.js', 'package.json', 'assets']) {
    const present = all.some((rel) => rel === must || rel.startsWith(must + '/'))
    if (!present) throw new Error(`白名单里缺了 ${must}，发布出去会残缺；先补 KEEP`)
  }

  if (DRY) {
    console.log('')
    console.log('GH_DRY=1：只检查，没有发任何请求。')
    return
  }

  await ensureRepo()

  /*
   * 空仓库（刚建、零提交）调 git/blobs 会返回 409 "Git Repository is empty"。
   * 先用 Contents API 建第一个提交，把仓库变成"非空"，后面的 Git Data API 才可用。
   */
  try {
    await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
  } catch (error) {
    if (error.status === 404 || error.status === 409) {
      console.log('仓库是空的，先建一个初始提交…')
      await api('PUT', `/repos/${OWNER}/${REPO}/contents/README.md`, {
        message: 'chore: init',
        content: Buffer.from('# dsh-elysia-memory\n').toString('base64')
      })
      console.log('初始提交完成')
    } else {
      throw error
    }
  }

  const blobs = []
  for (const rel of all) {
    const buffer = await fsp.readFile(path.join(ROOT, rel))
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: buffer.toString('base64'),
      encoding: 'base64'
    })
    blobs.push({ path: withPrefix(rel), mode: '100644', type: 'blob', sha: blob.sha })
  }

  let baseTree
  let parents = []
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
    parents = [ref.object.sha]
    const commit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${ref.object.sha}`)
    baseTree = commit.tree.sha
    console.log(`在已有 ${BRANCH} 之上提交（父提交 ${ref.object.sha.slice(0, 8)}）`)
  } catch (error) {
    if (error.status !== 409 && error.status !== 404) throw error
    console.log(`${BRANCH} 还不存在，本次是第一个提交`)
  }

  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    // sha: null = 从新 tree 里删掉这个路径
    tree: [...blobs, ...PRUNE.map((p) => ({ path: withPrefix(p), mode: '100644', type: 'blob', sha: null }))],
    ...(baseTree ? { base_tree: baseTree } : {})
  })

  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: `release: ${pkg.name} v${pkg.version}`,
    tree: tree.sha,
    parents
  })

  if (parents.length) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true })
  } else {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha })
  }

  try {
    await api('PUT', `/repos/${OWNER}/${REPO}/topics`, {
      names: ['dsh-plugin', 'deepseek-harness', 'memory', 'elysia', 'honkai']
    })
    console.log('已设置 topic')
  } catch (error) {
    console.log(`设置 topic 失败（可手动加）：${error.message}`)
  }

  if (WANT_RELEASE) {
    await upsertTag(commit.sha, tag)
    const release = await upsertRelease(tag, pkg)
    if (TGZ) await uploadAsset(release, path.resolve(TGZ))
    console.log(`Release：${release.html_url}`)
  }

  console.log('')
  console.log(`完成：https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`)
  console.log(`仓库地址：https://github.com/${OWNER}/${REPO}`)
}

main().catch((error) => {
  console.error('发布失败：' + error.message)
  process.exit(1)
})
