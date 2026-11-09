/**
 * scripts/open-market-pr.mjs
 *
 * 把 market/ 下的条目 YAML 提交到 awesome-dsh-plugin 仓库（fork → 建文件 → 开 PR）。
 *
 *   $env:GITHUB_TOKEN = 'ghp_xxx'
 *   node scripts/open-market-pr.mjs
 *
 * 可选环境变量：
 *   GH_OWNER    默认 1148462398-hub（fork 落在谁名下）
 *   GH_DRY      1 = 只比对内容、不发请求
 *
 * 行为：
 *   - 条目内容和上游**完全一致**时直接跳过（不制造空 PR）
 *   - 上游还没有这个文件 → 新增
 *   - 上游有但内容旧了 → 更新（版本号 / tarball 地址变了才需要）
 *   - 同一版本重复执行 → 复用已有分支，PR 已存在就打印它，不重复开
 *
 * 只用经典 token 的 repo scope 就够。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOKEN = process.env.GITHUB_TOKEN || ''
const UPSTREAM_OWNER = 'awesome-dsh-plugin'
const UPSTREAM_REPO = 'awesome-dsh-plugin'
const ME = process.env.GH_OWNER || '1148462398-hub'
const DRY = process.env.GH_DRY === '1'

const here = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.resolve(here, '..')

const pkg = JSON.parse(await fsp.readFile(path.join(PKG_DIR, 'package.json'), 'utf8'))
const ENTRY_FILE = `${ME}__${pkg.name}.yml`
const localEntry = path.join(PKG_DIR, 'market', ENTRY_FILE)

/** 分支名带版本号：同一个分支被上一次 PR 用掉之后，下次才不会撞上 */
const BRANCH = `market-${pkg.name}-v${pkg.version}`

if (!TOKEN && !DRY) {
  console.error('缺少 GITHUB_TOKEN')
  process.exit(2)
}

async function api(method, route, body) {
  const res = await fetch('https://api.github.com' + route, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-elysia-memory-publisher',
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const error = new Error(`${method} ${route} -> ${res.status} ${json?.message || text.slice(0, 160)}`)
    error.status = res.status
    throw error
  }
  return json
}

/** 读上游当前条目；不存在返回 null */
async function readUpstream(owner) {
  try {
    const got = await api('GET', `/repos/${owner}/${UPSTREAM_REPO}/contents/data/plugins/${ENTRY_FILE}`)
    return {
      sha: got.sha,
      text: Buffer.from(got.content, 'base64').toString('utf8')
    }
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim()

async function ensureFork() {
  try {
    const fork = await api('GET', `/repos/${ME}/${UPSTREAM_REPO}`)
    console.log(`已存在 fork：${fork.full_name}`)
    return fork
  } catch (error) {
    if (error.status !== 404) throw error
    console.log(`创建 fork：${UPSTREAM_OWNER}/${UPSTREAM_REPO} → ${ME}/${UPSTREAM_REPO}`)
    await api('POST', `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/forks`, { default_branch_only: true })
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      try {
        const fork = await api('GET', `/repos/${ME}/${UPSTREAM_REPO}`)
        console.log(`fork 就绪：${fork.full_name}（默认分支 ${fork.default_branch}）`)
        return fork
      } catch {
        /* 继续等 */
      }
    }
    throw new Error('fork 创建超时')
  }
}

async function main() {
  const yamlText = await fsp.readFile(localEntry, 'utf8')
  console.log(`条目文件：${localEntry}（${yamlText.length} 字符）`)

  // 先看上游（公开仓库，不需要 fork 就能读）
  let upstream = null
  if (DRY) {
    console.log('GH_DRY=1：不请求上游，只检查本地条目。')
    console.log(yamlText.split('\n').slice(0, 4).join('\n'))
    return
  }
  upstream = await readUpstream(UPSTREAM_OWNER)
  if (upstream && norm(upstream.text) === norm(yamlText)) {
    console.log(`上游 data/plugins/${ENTRY_FILE} 已经和本地一致，不需要 PR。`)
    return
  }
  console.log(upstream ? '上游条目存在但内容不同，准备更新' : '上游还没有这个条目，准备新增')

  const fork = await ensureFork()
  const base = fork.default_branch

  // 工作分支：存在就复用（同版本重复跑），不存在就从默认分支拉
  let branchName = BRANCH
  try {
    const baseRef = await api('GET', `/repos/${ME}/${UPSTREAM_REPO}/git/ref/heads/${base}`)
    await api('POST', `/repos/${ME}/${UPSTREAM_REPO}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: baseRef.object.sha
    })
    console.log(`已创建分支 ${branchName}`)
  } catch (error) {
    if (error.status !== 422) throw error
    console.log(`分支 ${branchName} 已存在，直接在上面更新`)
  }

  // fork 上如果已经有这个文件，PUT 必须带 sha
  let existingSha
  try {
    const exists = await api(
      'GET',
      `/repos/${ME}/${UPSTREAM_REPO}/contents/data/plugins/${ENTRY_FILE}?ref=${branchName}`
    )
    existingSha = exists.sha
  } catch (error) {
    if (error.status !== 404) throw error
  }

  const put = await api('PUT', `/repos/${ME}/${UPSTREAM_REPO}/contents/data/plugins/${ENTRY_FILE}`, {
    message: `Update ${ENTRY_FILE} to v${pkg.version}`,
    content: Buffer.from(yamlText, 'utf8').toString('base64'),
    branch: branchName,
    ...(existingSha ? { sha: existingSha } : {})
  })
  console.log(`已提交条目：${put.commit.sha.slice(0, 8)} → 分支 ${branchName}`)

  try {
    const pr = await api('POST', `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls`, {
      title: `Update ${ENTRY_FILE.replace(/\.yml$/, '')} to v${pkg.version}`,
      head: `${ME}:${branchName}`,
      base: 'main',
      body: [
        `Bumps **${pkg.name}** to \`v${pkg.version}\`.`,
        '',
        '- repo: ' + (yamlText.match(/^url:\s*(\S+)/m)?.[1] ?? ''),
        '- tarball: ' + (yamlText.match(/^tarball:\s*(\S+)/m)?.[1] ?? ''),
        '',
        'This release fixes a real bug: **the speech bubble never appeared on machines',
        'without the TTS engine**, because the bubble was gated behind the voice switch.',
        'Bubbles are now independent of the engine (`voice.bubble`, default on).',
        'It also stopped `assets/` (the avatar) and `docs/` from being dropped from the repo.'
      ].join('\n')
    })
    console.log('')
    console.log(`PR #${pr.number}：${pr.html_url}`)
  } catch (error) {
    if (error.status !== 422) throw error
    // 同一分支已经开过 PR：找出来打印，不重复开
    const open = await api('GET', `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls?state=open&head=${ME}:${branchName}`)
    if (open?.length) console.log(`PR 已存在：#${open[0].number} ${open[0].html_url}`)
    else console.log('PR 创建被拒（422），但也没找到已存在的 PR，可能是分支没有新提交。')
  }
}

main().catch((error) => {
  console.error('开 PR 失败：' + error.message)
  process.exit(1)
})
