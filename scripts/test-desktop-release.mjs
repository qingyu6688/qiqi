import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createUpdateManifest, extractReleaseNotes, prepareDesktopRelease } from './prepare-desktop-release.mjs'
import { validateDesktopRelease, validateReleaseFiles, verifyUpdaterSignature } from './validate-desktop-release.mjs'

function createFixture({ algorithm = 'ED', trustedVersion = 'version:1.1.2', keyId = randomBytes(8) } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const publicKeyText = Buffer.from(`untrusted comment: 发布测试公钥\n${Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]).toString('base64')}\n`).toString('base64')
  const installer = Buffer.concat([Buffer.from('MZ'), randomBytes(1024)])
  const fileSignature = sign(null, algorithm === 'ED' ? createHash('blake2b512').update(installer).digest() : installer, privateKey)
  const trustedComment = `timestamp:1793318400\tfile:柒柒_1.1.2_x64-setup.exe${trustedVersion ? `\t${trustedVersion}` : ''}`
  const globalSignature = sign(null, Buffer.concat([fileSignature, Buffer.from(trustedComment)]), privateKey)
  const signature = Buffer.from([
    'untrusted comment: 发布测试签名',
    Buffer.concat([Buffer.from(algorithm), keyId, fileSignature]).toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n')).toString('base64')
  return {
    manifest: {
      version: '1.1.2',
      notes: '支持桌面端签名更新。',
      pub_date: '2026-10-30T00:00:00Z',
      platforms: {
        'windows-x86_64': {
          url: 'https://github.com/qingyu6688/qiqi/releases/download/v1.1.2/%E6%9F%92%E6%9F%92_1.1.2_x64-setup.exe',
          signature,
        },
      },
    },
    installer,
    installerName: '柒柒_1.1.2_x64-setup.exe',
    signature,
    publicKey: publicKeyText,
    version: '1.1.2',
    repo: 'qingyu6688/qiqi',
  }
}

function replaceSignature(fixture, transform) {
  const lines = Buffer.from(fixture.signature, 'base64').toString('utf8').trimEnd().split('\n')
  transform(lines)
  fixture.signature = Buffer.from(`${lines.join('\n')}\n`).toString('base64')
  fixture.manifest.platforms['windows-x86_64'].signature = fixture.signature
}

function createPrepareFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qiqi-release-test-'))
  t.after(() => {
    assert.equal(resolve(root).startsWith(resolve(tmpdir(), 'qiqi-release-test-')), true)
    rmSync(root, { recursive: true })
  })
  const fixture = createFixture()
  const bundle = join(root, 'src-tauri/target/release/bundle/nsis')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: fixture.version }))
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), `[package]\nname = "qiqi"\nversion = "${fixture.version}"\n\n[dependencies]\n`)
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({
    version: '../package.json',
    identifier: 'local.qiqi.studio',
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: {
      pubkey: fixture.publicKey,
      requireSignedVersion: true,
      endpoints: ['https://github.com/qingyu6688/qiqi/releases/latest/download/latest.json'],
    } },
  }))
  const notes = `## v${fixture.version}（2026-10-30）\n\n### 修复\n- 安装更新时保留本机数据。\n`
  writeFileSync(join(root, 'RELEASE.md'), `${notes}\n## v1.1.1（2026-10-29）\n\n- 旧版内容。\n`)
  writeFileSync(join(bundle, fixture.installerName), fixture.installer)
  writeFileSync(join(bundle, `${fixture.installerName}.sig`), fixture.signature)
  return { root, fixture, bundle, notes }
}

test('有效的签名安装包通过预检，并给出可用于发布核对的摘要', () => {
  const fixture = createFixture()
  const result = validateDesktopRelease(fixture)
  assert.equal(result.version, '1.1.2')
  assert.equal(result.repo, 'qingyu6688/qiqi')
  assert.equal(result.sha256, createHash('sha256').update(fixture.installer).digest('hex'))
  assert.equal(result.size, fixture.installer.length)
})

test('支持 Tauri 的原文签名和 Windows NSIS 平台别名', () => {
  const fixture = createFixture({ algorithm: 'Ed' })
  fixture.manifest.platforms['windows-x86_64-nsis'] = { ...fixture.manifest.platforms['windows-x86_64'] }
  assert.deepEqual(validateDesktopRelease(fixture).platforms, ['windows-x86_64', 'windows-x86_64-nsis'])
})

test('使用 minisign-verify 上游公开样例验证预哈希兼容性，再拒绝缺少签名版本', () => {
  const publicKey = Buffer.from('untrusted comment: minisign 公共测试样例\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n').toString('base64')
  const signature = Buffer.from([
    'untrusted comment: signature from minisign secret key',
    'RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=',
    'trusted comment: timestamp:1633700835\tfile:test\tprehashed',
    'wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==',
  ].join('\n')).toString('base64')
  assert.throws(() => verifyUpdaterSignature(Buffer.from('test'), signature, publicKey, '1.1.2'), /唯一的受保护版本号/)
})

test('安装包字节被修改时拒绝发布', () => {
  const fixture = createFixture()
  fixture.installer[100] ^= 1
  assert.throws(() => validateDesktopRelease(fixture), /安装包签名校验失败/)
})

test('文件签名被修改时拒绝发布', () => {
  const fixture = createFixture()
  replaceSignature(fixture, (lines) => {
    const bytes = Buffer.from(lines[1], 'base64')
    bytes[30] ^= 1
    lines[1] = bytes.toString('base64')
  })
  assert.throws(() => validateDesktopRelease(fixture), /安装包签名校验失败/)
})

test('修改可信注释或其签名时拒绝发布', () => {
  for (const change of ['comment', 'signature']) {
    const fixture = createFixture()
    replaceSignature(fixture, (lines) => {
      if (change === 'comment') lines[2] = lines[2].replace('version:1.1.2', 'version:1.1.3')
      else {
        const bytes = Buffer.from(lines[3], 'base64')
        bytes[0] ^= 1
        lines[3] = bytes.toString('base64')
      }
    })
    assert.throws(() => validateDesktopRelease(fixture), /可信注释签名校验失败/)
  }
})

test('密钥 ID 不一致或使用了其他公钥时拒绝发布', () => {
  const fixture = createFixture()
  const other = createFixture()
  fixture.publicKey = other.publicKey
  assert.throws(() => validateDesktopRelease(fixture), /密钥 ID/)
  const publicKeyLines = Buffer.from(fixture.publicKey, 'base64').toString('utf8').trimEnd().split('\n')
  const bytes = Buffer.from(publicKeyLines[1], 'base64')
  Buffer.from(Buffer.from(fixture.signature, 'base64').toString('utf8').split('\n')[1], 'base64').copy(bytes, 2, 2, 10)
  publicKeyLines[1] = bytes.toString('base64')
  fixture.publicKey = Buffer.from(publicKeyLines.join('\n')).toString('base64')
  assert.throws(() => validateDesktopRelease(fixture), /安装包签名校验失败/)
})

test('清单版本、签名版本、签名版本缺失和重复均不能绕过校验', () => {
  const fixture = createFixture()
  fixture.manifest.version = '1.1.3'
  assert.throws(() => validateDesktopRelease(fixture), /清单版本/)
  for (const trustedVersion of ['version:1.1.1', '', 'version:1.1.2\tversion:9.9.9']) {
    assert.throws(() => validateDesktopRelease(createFixture({ trustedVersion })), /签名版本|受保护版本号/)
  }
})

test('清单中的签名必须与随包的 .sig 完全一致', () => {
  const fixture = createFixture()
  fixture.manifest.platforms['windows-x86_64'].signature = createFixture().signature
  assert.throws(() => validateDesktopRelease(fixture), /清单签名与 .sig 文件不一致/)
})

test('错误的仓库、版本、文件、协议和附加查询参数均被拒绝', () => {
  const fixture = createFixture()
  const expected = fixture.manifest.platforms['windows-x86_64'].url
  for (const url of [
    expected.replace('qingyu6688/qiqi', 'another/repo'),
    expected.replace('/v1.1.2/', '/v1.1.1/'),
    expected.replace('_x64-setup.exe', '_x64-changed.exe'),
    expected.replace('https:', 'http:'),
    `${expected}?download=1`,
    expected.replace('github.com', 'github.com.attacker.invalid'),
  ]) {
    fixture.manifest.platforms['windows-x86_64'].url = url
    assert.throws(() => validateDesktopRelease(fixture), /下载地址/)
  }
})

test('不会误用上游仓库或其他系统的产物', () => {
  assert.throws(() => validateDesktopRelease({ ...createFixture(), repo: 'CookSleep/gpt_image_playground' }), /上游原项目/)
  const fixture = createFixture()
  fixture.manifest.platforms['linux-x86_64'] = fixture.manifest.platforms['windows-x86_64']
  assert.throws(() => validateDesktopRelease(fixture), /不受支持的平台/)
  delete fixture.manifest.platforms['windows-x86_64']
  assert.throws(() => validateDesktopRelease(fixture), /缺少 windows-x86_64/)
})

test('非法 Base64、公钥、安装文件和不完整清单被拒绝', () => {
  assert.throws(() => validateDesktopRelease({ ...createFixture(), publicKey: 'not base64' }), /Base64/)
  assert.throws(() => validateDesktopRelease({ ...createFixture(), installer: Buffer.from('text') }), /可执行文件/)
  assert.throws(() => validateDesktopRelease({ ...createFixture(), installerName: 'qiqi.msi' }), /NSIS/)
  assert.throws(() => validateDesktopRelease({ ...createFixture(), installerName: '柒柒_1.1.1_x64-setup.exe' }), /文件名中的版本/)
  for (const field of ['notes', 'pub_date', 'version']) {
    const fixture = createFixture()
    delete fixture.manifest[field]
    assert.throws(() => validateDesktopRelease(fixture))
  }
})

test('文件入口核对项目版本、数据标识、签名开关与实际更新地址', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qiqi-release-test-'))
  t.after(() => {
    assert.equal(resolve(root).startsWith(resolve(tmpdir(), 'qiqi-release-test-')), true)
    rmSync(root, { recursive: true })
  })
  mkdirSync(join(root, 'src-tauri'))
  const fixture = createFixture()
  const configPath = join(root, 'src-tauri/tauri.conf.json')
  const config = {
    version: '../package.json',
    identifier: 'local.qiqi.studio',
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: {
      pubkey: fixture.publicKey,
      requireSignedVersion: true,
      endpoints: ['https://github.com/qingyu6688/qiqi/releases/latest/download/latest.json'],
    } },
  }
  const options = { root, manifest: join(root, 'latest.json'), installer: join(root, fixture.installerName), repo: fixture.repo }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: fixture.version }))
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), `[package]\nname = "qiqi"\nversion = "${fixture.version}"\n\n[dependencies]\n`)
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(options.manifest, JSON.stringify(fixture.manifest))
  writeFileSync(options.installer, fixture.installer)
  writeFileSync(`${options.installer}.sig`, `${fixture.signature}\n`)
  assert.equal(validateReleaseFiles(options).version, '1.1.2')
  for (const mutate of [
    (value) => { value.identifier = 'different.app' },
    (value) => { value.bundle.createUpdaterArtifacts = false },
    (value) => { value.plugins.updater.requireSignedVersion = false },
    (value) => { value.plugins.updater.endpoints = ['https://github.com/another/repo/releases/latest/download/latest.json'] },
    (value) => { value.plugins.updater.pubkey = '' },
  ]) {
    const changed = structuredClone(config)
    mutate(changed)
    writeFileSync(configPath, JSON.stringify(changed))
    assert.throws(() => validateReleaseFiles(options))
  }
  writeFileSync(configPath, JSON.stringify(config))
  const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), cargo.replace('1.1.2', '1.1.1'))
  assert.throws(() => validateReleaseFiles(options), /Cargo.toml/)
})

test('本机 Tauri CLI 签出的临时文件可以通过同一公钥与签名版本校验', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qiqi-release-test-'))
  t.after(() => {
    assert.equal(resolve(root).startsWith(resolve(tmpdir(), 'qiqi-release-test-')), true)
    rmSync(root, { recursive: true })
  })
  const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url))
  const keyPath = join(root, 'temporary.key')
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' }
  delete env.TAURI_SIGNING_PRIVATE_KEY
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH
  const fixture = createFixture()
  const installerPath = join(root, fixture.installerName)
  writeFileSync(installerPath, fixture.installer)
  // 测试私钥仅存在于临时目录，标准输出不得把私钥带进 CI 日志。
  try {
    execFileSync(process.execPath, [cli, 'signer', 'generate', '--ci', '--password', '', '--write-keys', keyPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    execFileSync(process.execPath, [cli, 'signer', 'sign', '--private-key-path', keyPath, '--app-version', fixture.version, installerPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    throw new Error(`Tauri 临时签名命令失败：${error.stderr?.toString() ?? '无法启动本地 CLI'}`)
  }
  fixture.publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()
  fixture.signature = readFileSync(`${installerPath}.sig`, 'utf8').trim()
  fixture.manifest.platforms['windows-x86_64'].signature = fixture.signature
  assert.equal(validateDesktopRelease(fixture).version, fixture.version)
})

test('发布说明只提取当前版本，兼容 BOM 与 Windows 换行', () => {
  const notes = '\uFEFF# 发布记录\r\n\r\n## v1.1.3（2026-11-01）\r\n\r\n- 后续内容。\r\n\r\n## v1.1.2（2026-10-30）\r\n\r\n### 修复\r\n- 当前内容。\r\n\r\n## v1.1.1（2026-10-29）\r\n\r\n- 旧版内容。'
  assert.equal(extractReleaseNotes(notes, '1.1.2'), '## v1.1.2（2026-10-30）\n\n### 修复\n- 当前内容。\n')
})

test('缺失、重复、空白或没有日期的发布段均拒绝', () => {
  const section = '## v1.1.2（2026-10-30）\n\n- 当前内容。\n'
  for (const notes of ['', section + section, '## v1.1.2（2026-10-30）\n\n### 修复\n', '## v1.1.2（今天）\n\n- 当前内容。']) {
    assert.throws(() => extractReleaseNotes(notes, '1.1.2'))
  }
})

test('更新清单固定使用 ASCII 安装包名并兼容 Windows NSIS 平台名', () => {
  const fixture = createFixture()
  const manifest = createUpdateManifest({ version: fixture.version, notes: '更新内容。\n', signature: `${fixture.signature}\n`, now: new Date('2026-10-30T08:00:00+08:00') })
  assert.equal(manifest.pub_date, '2026-10-30T00:00:00.000Z')
  assert.equal(manifest.platforms['windows-x86_64'].url, 'https://github.com/qingyu6688/qiqi/releases/download/v1.1.2/qiqi_1.1.2_x64-setup.exe')
  assert.equal(manifest.platforms['windows-x86_64'].signature, fixture.signature)
  assert.deepEqual(manifest.platforms['windows-x86_64'], manifest.platforms['windows-x86_64-nsis'])
  assert.equal(manifest.notes, '更新内容。')
})

test('准备发布只输出五项白名单，重命名不会修改已签名的安装包', (t) => {
  const { root, fixture, bundle, notes } = createPrepareFixture(t)
  writeFileSync(join(bundle, 'private.key'), '禁止打包的测试文件')
  writeFileSync(join(root, '.env'), '禁止打包的测试配置')
  const prepared = prepareDesktopRelease({ root, tag: 'v1.1.2', now: new Date('2026-10-30T00:00:00Z') })
  const expectedFiles = ['qiqi_1.1.2_x64-setup.exe', 'qiqi_1.1.2_x64-setup.exe.sig', 'latest.json', 'release-notes.md', 'SHA256SUMS']
  assert.deepEqual(readdirSync(prepared.directory).sort(), [...expectedFiles].sort())
  assert.deepEqual(prepared.files, expectedFiles)
  assert.deepEqual(readFileSync(join(prepared.directory, prepared.installer)), fixture.installer)
  assert.equal(readFileSync(join(prepared.directory, 'release-notes.md'), 'utf8'), notes)
  for (const line of readFileSync(join(prepared.directory, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [hash, name] = line.split('  ')
    assert.equal(hash, createHash('sha256').update(readFileSync(join(prepared.directory, name))).digest('hex'))
  }
  assert.equal(validateReleaseFiles({ root, repo: fixture.repo, manifest: join(prepared.directory, 'latest.json'), installer: join(prepared.directory, prepared.installer) }).version, '1.1.2')
  assert.equal(prepareDesktopRelease({ root }).version, '1.1.2')
})

test('错误标签和被修改的输入包在写入发布目录前就会失败', (t) => {
  const { root, fixture, bundle } = createPrepareFixture(t)
  assert.throws(() => prepareDesktopRelease({ root, tag: 'v1.1.1' }), /发布标签/)
  assert.equal(existsSync(join(root, 'release-artifacts')), false)
  fixture.installer[500] ^= 1
  writeFileSync(join(bundle, fixture.installerName), fixture.installer)
  assert.throws(() => prepareDesktopRelease({ root }), /安装包签名校验失败/)
  assert.equal(existsSync(join(root, 'release-artifacts')), false)
})

test('发布目录混入其他文件时保留原文件并拒绝继续生成', (t) => {
  const { root } = createPrepareFixture(t)
  const out = join(root, 'release-artifacts')
  mkdirSync(out)
  writeFileSync(join(out, 'existing.txt'), '原有文件')
  assert.throws(() => prepareDesktopRelease({ root }), /白名单以外/)
  assert.deepEqual(readdirSync(out), ['existing.txt'])
  assert.equal(readFileSync(join(out, 'existing.txt'), 'utf8'), '原有文件')
  assert.equal(prepareDesktopRelease({ root, out: 'separate-output' }).directory, join(root, 'separate-output'))
})
