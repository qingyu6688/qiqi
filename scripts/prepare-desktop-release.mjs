import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readReleaseProject, validateDesktopRelease, validateReleaseFiles } from './validate-desktop-release.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_REPO = 'qingyu6688/qiqi'

export function extractReleaseNotes(markdown, version) {
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  const headings = lines.flatMap((line, index) => line.startsWith(`## v${version}（`) ? [index] : [])
  if (headings.length !== 1) throw new Error(`RELEASE.md 必须包含唯一的 v${version} 发布记录`)
  const start = headings[0]
  if (!/^## v[^（]+（\d{4}-\d{2}-\d{2}）$/.test(lines[start])) throw new Error('发布记录标题必须包含 YYYY-MM-DD 格式的日期')
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line))
  const section = lines.slice(start, next === -1 ? undefined : next).join('\n').trim()
  if (!/^\s*- .+/m.test(section)) throw new Error(`v${version} 发布记录缺少具体更新内容`)
  return `${section}\n`
}

export function createUpdateManifest({ version, notes, signature, repo = DEFAULT_REPO, now = new Date() }) {
  const installerName = `qiqi_${version}_x64-setup.exe`
  const artifact = {
    signature: signature.trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${installerName}`,
  }
  return {
    version,
    notes: notes.trim(),
    pub_date: now.toISOString(),
    platforms: {
      'windows-x86_64': { ...artifact },
      'windows-x86_64-nsis': { ...artifact },
    },
  }
}

export function prepareDesktopRelease(options = {}) {
  const root = options.root ?? ROOT
  const repo = options.repo ?? DEFAULT_REPO
  const out = resolve(root, options.out ?? 'release-artifacts')
  const project = readReleaseProject({ root, repo })
  if (options.tag !== undefined && options.tag !== `v${project.version}`) throw new Error(`发布标签必须是 v${project.version}`)
  const notes = extractReleaseNotes(readFileSync(join(root, 'RELEASE.md'), 'utf8'), project.version)
  const sourceName = `柒柒_${project.version}_x64-setup.exe`
  const sourcePath = join(root, 'src-tauri/target/release/bundle/nsis', sourceName)
  if (!existsSync(sourcePath) || !existsSync(`${sourcePath}.sig`)) throw new Error('缺少已签名的桌面安装包，请先完成 Tauri NSIS 构建')
  const installer = readFileSync(sourcePath)
  const signature = readFileSync(`${sourcePath}.sig`, 'utf8').trim()
  const installerName = `qiqi_${project.version}_x64-setup.exe`
  const manifest = createUpdateManifest({ version: project.version, notes, signature, repo, now: options.now })
  validateDesktopRelease({ ...project, manifest, installer, installerName, signature, repo })

  // 只打包这组文件，避免把本地配置、数据库或签名私钥带进发布目录。
  const files = new Map([
    [installerName, installer],
    [`${installerName}.sig`, `${signature}\n`],
    ['latest.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['release-notes.md', notes],
  ])
  files.set('SHA256SUMS', [...files].map(([name, content]) => `${createHash('sha256').update(content).digest('hex')}  ${name}`).join('\n') + '\n')
  if (existsSync(out)) {
    const unexpected = readdirSync(out, { withFileTypes: true }).filter((entry) => !files.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())
    if (unexpected.length) throw new Error('发布目录包含白名单以外的文件，请指定新的空目录；不会自动删除已有内容')
  }
  mkdirSync(out, { recursive: true })
  for (const [name, content] of files) writeFileSync(join(out, name), content)
  const verified = validateReleaseFiles({ root, repo, manifest: join(out, 'latest.json'), installer: join(out, installerName) })
  return { ...verified, directory: out, files: [...files.keys()] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      repo: { type: 'string' },
      out: { type: 'string' },
      tag: { type: 'string' },
      help: { type: 'boolean' },
    } })
    if (values.help) {
      process.stdout.write('用法：node scripts/prepare-desktop-release.mjs [--repo qingyu6688/qiqi] [--out release-artifacts] [--tag v版本号]\n')
    } else {
      const result = prepareDesktopRelease(values)
      process.stdout.write(`桌面发布文件已生成并通过签名预检\n${JSON.stringify(result, null, 2)}\n`)
    }
  } catch (error) {
    process.stderr.write(`准备桌面发布失败：${error instanceof Error ? error.message : '未知错误'}\n`)
    process.exitCode = 1
  }
}
