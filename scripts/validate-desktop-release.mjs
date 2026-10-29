import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const WINDOWS_PLATFORMS = new Set(['windows-x86_64', 'windows-x86_64-nsis'])

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function decodeBase64(value, label) {
  requireValue(typeof value === 'string' && value.length > 0, `${label}不能为空`)
  requireValue(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), `${label}不是有效的 Base64`)
  const decoded = Buffer.from(value, 'base64')
  requireValue(decoded.toString('base64') === value, `${label}不是规范的 Base64`)
  return decoded
}

function normalizeVersion(value) {
  requireValue(typeof value === 'string', '版本号必须是字符串')
  const version = value.replace(/^v/, '')
  requireValue(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version), '版本号格式无效')
  return version
}

export function verifyUpdaterSignature(installer, signatureText, publicKeyText, version) {
  const publicKeyLines = decodeBase64(publicKeyText.trim(), '更新公钥').toString('utf8').trimEnd().split(/\r?\n/)
  requireValue(publicKeyLines.length === 2 && publicKeyLines[0].startsWith('untrusted comment: '), '更新公钥格式无效')
  const publicKeyBytes = decodeBase64(publicKeyLines[1], '公钥正文')
  requireValue(publicKeyBytes.length === 42 && ['Ed', 'ED'].includes(publicKeyBytes.subarray(0, 2).toString()), '更新公钥算法或长度无效')

  const signatureLines = decodeBase64(signatureText.trim(), '更新签名').toString('utf8').trimEnd().split(/\r?\n/)
  requireValue(signatureLines.length === 4 && signatureLines[0].startsWith('untrusted comment: ') && signatureLines[2].startsWith('trusted comment: '), '更新签名格式无效')
  const signatureBytes = decodeBase64(signatureLines[1], '签名正文')
  const globalSignature = decodeBase64(signatureLines[3], '可信注释签名')
  requireValue(signatureBytes.length === 74 && globalSignature.length === 64, '更新签名长度无效')
  const algorithm = signatureBytes.subarray(0, 2).toString()
  requireValue(['Ed', 'ED'].includes(algorithm), '更新签名算法无效')
  requireValue(publicKeyBytes.subarray(2, 10).equals(signatureBytes.subarray(2, 10)), '签名密钥 ID 与更新公钥不一致')

  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes.subarray(10)]),
    format: 'der',
    type: 'spki',
  })
  const fileSignature = signatureBytes.subarray(10)
  const message = algorithm === 'ED' ? createHash('blake2b512').update(installer).digest() : installer
  requireValue(verify(null, message, key, fileSignature), '安装包签名校验失败，文件或公钥不匹配')
  const trustedComment = signatureLines[2].slice('trusted comment: '.length)
  requireValue(verify(null, Buffer.concat([fileSignature, Buffer.from(trustedComment)]), key, globalSignature), '可信注释签名校验失败')

  // 只有全局签名通过后，版本号才可以作为发布依据。
  const signedVersions = trustedComment.split('\t').filter((field) => field.startsWith('version:'))
  requireValue(signedVersions.length === 1, '签名必须包含唯一的受保护版本号，请使用 --app-version 签名')
  requireValue(normalizeVersion(signedVersions[0].slice('version:'.length)) === normalizeVersion(version), '签名版本与发布版本不一致')
  return { keyId: publicKeyBytes.subarray(2, 10).toString('hex'), trustedComment }
}

export function validateDesktopRelease({ manifest, installer, installerName, signature, publicKey, version, repo }) {
  requireValue(typeof repo === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repo), '发布仓库必须使用 owner/repo 格式')
  requireValue(!/^CookSleep\/gpt_image_playground$/i.test(repo), '不能向上游原项目发布柒柒安装包')
  requireValue(manifest && typeof manifest === 'object' && !Array.isArray(manifest), '更新清单必须是 JSON 对象')
  const releaseVersion = normalizeVersion(version)
  requireValue(normalizeVersion(manifest.version) === releaseVersion, '更新清单版本与项目版本不一致')
  requireValue(typeof manifest.pub_date === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(manifest.pub_date) && Number.isFinite(Date.parse(manifest.pub_date)), '更新清单必须包含有效的发布时间')
  requireValue(typeof manifest.notes === 'string' && manifest.notes.trim().length > 0, '更新清单缺少发布说明')
  requireValue(installerName === basename(installerName) && /_x64-setup\.exe$/.test(installerName), '安装包必须是 Windows x64 NSIS 安装包')
  requireValue(installerName.endsWith(`_${releaseVersion}_x64-setup.exe`), '安装包文件名中的版本与项目版本不一致')
  requireValue(Buffer.isBuffer(installer) && installer.length > 64 && installer.subarray(0, 2).toString() === 'MZ', '安装包不是有效的 Windows 可执行文件')
  requireValue(typeof signature === 'string' && signature.trim().length > 0, '安装包缺少对应的 .sig 签名')

  const platforms = manifest.platforms
  requireValue(platforms && typeof platforms === 'object' && !Array.isArray(platforms) && Object.hasOwn(platforms, 'windows-x86_64'), '更新清单缺少 windows-x86_64 平台')
  for (const [platform, artifact] of Object.entries(platforms)) {
    requireValue(WINDOWS_PLATFORMS.has(platform), `更新清单包含不受支持的平台：${platform}`)
    requireValue(artifact && typeof artifact === 'object', `${platform} 更新包信息无效`)
    requireValue(artifact.signature === signature.trim(), `${platform} 清单签名与 .sig 文件不一致`)
    let url
    try {
      url = new URL(artifact.url)
    } catch {
      throw new Error(`${platform} 安装包下载地址无效`)
    }
    requireValue(url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash, '安装包必须使用 GitHub HTTPS Release 下载地址')
    const expectedPath = `/${repo}/releases/download/v${releaseVersion}/${installerName}`
    requireValue(decodeURIComponent(url.pathname) === expectedPath, '安装包下载地址的仓库、版本或文件名不一致')
  }

  const verified = verifyUpdaterSignature(installer, signature, publicKey, releaseVersion)
  return {
    version: releaseVersion,
    repo,
    installer: installerName,
    sha256: createHash('sha256').update(installer).digest('hex'),
    size: installer.length,
    keyId: verified.keyId,
    platforms: Object.keys(platforms),
  }
}

export function readReleaseProject(options) {
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  const root = options.root ?? ROOT
  const config = readJson(options.config ?? resolve(root, 'src-tauri/tauri.conf.json'))
  const packageJson = readJson(resolve(root, 'package.json'))
  const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8')
  const packageSection = cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0]
  const cargoVersion = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  requireValue(cargoVersion === packageJson.version, 'Cargo.toml 与 package.json 版本不一致')
  requireValue(config.version === '../package.json' || config.version === packageJson.version, 'Tauri 配置版本与 package.json 不一致')
  requireValue(config.identifier === 'local.qiqi.studio', '应用标识必须保持 local.qiqi.studio，防止丢失已有数据入口')
  requireValue(config.bundle?.createUpdaterArtifacts === true, 'Tauri 配置尚未开启 createUpdaterArtifacts')
  const updater = config.plugins?.updater
  requireValue(updater?.requireSignedVersion === true, '必须开启 requireSignedVersion 版本签名校验')
  requireValue(typeof updater.pubkey === 'string' && updater.pubkey.trim().length > 0, 'Tauri 配置缺少更新公钥')
  const endpoint = `https://github.com/${options.repo}/releases/latest/download/latest.json`
  requireValue(Array.isArray(updater.endpoints) && updater.endpoints.length === 1 && updater.endpoints[0] === endpoint, 'Tauri 更新地址与发布仓库不一致')
  return { version: packageJson.version, publicKey: updater.pubkey }
}

export function validateReleaseFiles(options) {
  const project = readReleaseProject(options)
  return validateDesktopRelease({
    manifest: JSON.parse(readFileSync(options.manifest, 'utf8').replace(/^\uFEFF/, '')),
    installer: readFileSync(options.installer),
    installerName: basename(options.installer),
    signature: readFileSync(options.signature ?? `${options.installer}.sig`, 'utf8'),
    publicKey: project.publicKey,
    version: project.version,
    repo: options.repo,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      manifest: { type: 'string' },
      installer: { type: 'string' },
      signature: { type: 'string' },
      config: { type: 'string' },
      repo: { type: 'string' },
      help: { type: 'boolean' },
    } })
    if (values.help) {
      process.stdout.write('用法：node scripts/validate-desktop-release.mjs --manifest <latest.json> --installer <setup.exe> --repo <owner/repo> [--signature <setup.exe.sig>] [--config <tauri.conf.json>]\n')
    } else {
      requireValue(values.manifest && values.installer && values.repo, '必须提供 --manifest、--installer 和 --repo')
      const result = validateReleaseFiles(values)
      process.stdout.write(`桌面发布预检通过\n${JSON.stringify(result, null, 2)}\n`)
    }
  } catch (error) {
    process.stderr.write(`桌面发布预检失败：${error instanceof Error ? error.message : '未知错误'}\n`)
    process.exitCode = 1
  }
}
