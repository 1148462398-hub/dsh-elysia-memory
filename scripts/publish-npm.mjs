/**
 * scripts/publish-npm.mjs
 *
 * 把打好的 tgz 发到 npm registry —— 不依赖本机有没有 npm/pnpm。
 *
 *   $env:NPM_TOKEN = 'npm_xxx'          # 二选一：token
 *   $env:NPM_USER / NPM_PASS            #       或账号密码（会先换 token）
 *   node scripts/publish-npm.mjs
 *
 * 可选：
 *   NPM_DRY=1        只组装请求体、算 integrity，不发请求
 *   NPM_REGISTRY     默认 https://registry.npmjs.org
 *   NPM_OTP          账号开了 2FA 时的一次性验证码
 *   NPM_TAG          默认 latest
 *
 * ★ 为什么需要这个脚本：市场（dshmarket）对「从 Release tgz 安装」的插件，
 *   更新检查只会去 **npm** 找这个包的 latest。包不在 npm 上，那条路就永远
 *   返回「没有更新」。所以「市场里能不能自动更新」的唯一开关，是这个包在不在 npm。
 *
 * 认证只用 Authorization: Bearer，token 绝不写进任何文件。
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')

const REGISTRY = (process.env.NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')
const TOKEN = process.env.NPM_TOKEN || ''
const USER = process.env.NPM_USER || ''
const PASS = process.env.NPM_PASS || ''
const OTP = process.env.NPM_OTP || ''
const TAG = process.env.NPM_TAG || 'latest'
const DRY = process.env.NPM_DRY === '1'

const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'))
const TGZ = path.join(ROOT, '.release', `${pkg.name}-${pkg.version}.tgz`)
const FILE_NAME = path.basename(TGZ)
const REG_URL = `${REGISTRY}/${encodeURIComponent(pkg.name)}`

if (!DRY && !TOKEN && !(USER && PASS)) {
  console.error('缺少 NPM_TOKEN（或 NPM_USER + NPM_PASS）。npm 不允许匿名发布，必须先有凭据。')
  process.exit(2)
}

function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex')
}
function sha512(buf) {
  return 'sha512-' + createHash('sha512').update(buf).digest('base64')
}

function authHeaders(extra = {}) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'dsh-elysia-memory-publisher',
    ...extra
  }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  if (OTP) headers['npm-otp'] = OTP
  return headers
}

async function api(method, url, body, extra) {
  const res = await fetch(url, {
    method,
    headers: authHeaders(extra),
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text.slice(0, 500) }
  }
  if (!res.ok) {
    const detail = json?.error || json?.reason || json?.message || text.slice(0, 300)
    const error = new Error(`${method} ${url} -> ${res.status} ${detail}`)
    error.status = res.status
    throw error
  }
  return json
}

/** 账号密码换 token（npm 的 login 流程；2FA 时不带 OTP 会 401） */
async function tokenFromLogin() {
  if (TOKEN) return TOKEN
  const body = { name: USER, password: PASS }
  const got = await api('PUT', `${REGISTRY}/-/user/org.couchdb.user:${encodeURIComponent(USER)}`, body)
  return got.token
}

async function getPackument() {
  try {
    const res = await fetch(REG_URL, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-elysia-memory-publisher' }
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`packument ${res.status}`)
    return await res.json()
  } catch (error) {
    if (String(error.message).includes('404')) return null
    return null
  }
}

async function main() {
  console.log(`发布 ${pkg.name}@${pkg.version} → ${REGISTRY}`)

  let buf
  try {
    buf = await fsp.readFile(TGZ)
  } catch {
    throw new Error(`找不到 ${TGZ}；先跑 node scripts/release.mjs（它会在推送前打好包）`)
  }
  console.log(`包：${FILE_NAME}（${(buf.length / 1024).toFixed(0)} KB）`)

  const shasum = sha1(buf)
  const integrity = sha512(buf)
  console.log(`sha1 ${shasum}`)
  console.log(`integrity ${integrity.slice(0, 28)}…`)

  const manifest = {
    ...pkg,
    _id: `${pkg.name}@${pkg.version}`,
    dist: {
      shasum,
      integrity,
      tarball: `${REGISTRY}/${pkg.name}/-/${FILE_NAME}`
    }
  }

  const existing = await getPackument()
  const versions = existing?.versions && typeof existing.versions === 'object' ? { ...existing.versions } : {}
  if (versions[pkg.version]) {
    throw new Error(`npm 上已经有 ${pkg.name}@${pkg.version} 了。npm 不允许覆盖已发布版本——请先改 package.json 的版本号再发。`)
  }
  versions[pkg.version] = manifest

  const body = {
    _id: pkg.name,
    name: pkg.name,
    description: pkg.description,
    'dist-tags': { ...(existing?.['dist-tags'] ?? {}), [TAG]: pkg.version },
    versions,
    readme: await fsp.readFile(path.join(ROOT, 'README.md'), 'utf8'),
    _attachments: {
      [FILE_NAME]: {
        content_type: 'application/octet-stream',
        data: buf.toString('base64'),
        length: buf.length
      }
    }
  }

  const sizeMb = (JSON.stringify(body).length / 1024 / 1024).toFixed(1)
  console.log(`请求体约 ${sizeMb} MB（含 base64 附件；npm 上限 30 MB 左右）`)
  if (existing) console.log(`npm 上已有 ${Object.keys(existing.versions ?? {}).length} 个版本，本次追加一个`)

  if (DRY) {
    console.log('')
    console.log('NPM_DRY=1：只组装请求体，没有发请求。')
    console.log(`将要 PUT ${REG_URL}`)
    console.log(`dist-tags.${TAG} = ${pkg.version}`)
    return
  }

  if (!TOKEN) {
    const t = await tokenFromLogin()
    if (!t) throw new Error('账号密码登录没拿到 token')
    process.env.NPM_TOKEN = t
  }

  const result = await api('PUT', REG_URL, body)
  console.log('')
  console.log(`发布成功：${pkg.name}@${pkg.version}（${result?.ok === false ? '服务端返回 ok=false，请检查' : 'ok'}）`)
  console.log(`页面：https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`)
  console.log('')
  console.log('⚠️ 别忘了：npm 上有了这个包之后，市场目录要等下一次 probe-npm 跑过')
  console.log('   才会填上 npm 映射；在那之前，从 Release tgz 安装的用户仍然看不到更新。')
}

main().catch((error) => {
  const hint =
    error.status === 401 || error.status === 403
      ? '\n（401/403：token 无效、过期，或者这个账号对这个包没有发布权限；开了 2FA 的话要传 NPM_OTP）'
      : ''
  console.error('发布失败：' + error.message + hint)
  process.exit(1)
})
