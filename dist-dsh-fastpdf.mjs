#!/usr/bin/env node
/**
 * dsh-fastpdf 分发打包脚本
 *
 * 把插件目录打成标准 npm tarball（tgz，内含 package/ 前缀），只含运行时需要的文件：
 *   lib/  vendor/  cordis.patch.yml  README.md  package.json
 *
 * 用法（在本目录下）：
 *   node dist-dsh-fastpdf.mjs            # 生成 dist/dsh-fastpdf-<version>.tgz
 *   node dist-dsh-fastpdf.mjs --check    # 只打印清单与大小，不写盘
 *   node dist-dsh-fastpdf.mjs --out out  # 自定义输出目录（默认 dist）
 *
 * 产物用法：
 *   解压后把 package/ 目录作为 plugin_manager install_bundle 的 target；
 *   或者 npm install ./dsh-fastpdf-<version>.tgz / pnpm add ./dsh-fastpdf-<version>.tgz
 *
 * 本机有 pnpm 时，用 `pnpm pack --dry-run` 拿文件清单（等于 npm pack 的语义）；
 * 否则按 package.json 的 "files" 字段自己扫。两种方式的文件集保持一致。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const outIdx = args.indexOf('--out')
const outDir = resolve(here, outIdx >= 0 ? args[outIdx + 1] : 'dist')

/** 运行时必需的文件（缺一个就报错，避免打出坏包）。 */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'lib/index.js',
  'lib/client.js',
  'lib/render-server.ps1',
  'vendor/pdfjs/build/pdf.mjs',
  'vendor/pdfjs/build/pdf.worker.mjs',
]

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

// ---------- 1. 文件清单 ----------

/**
 * pnpm pack --dry-run --json 的机器可读输出。
 * 这里只把它当交叉校验：本脚本自己打 tar（全程 node、不依赖外部命令、可复现）；
 * pnpm/npm 不可用（例如沙箱禁止 spawn）时返回 null，不影响打包。
 */
function fromPackDryRun() {
  /** @type {(string | string[])[]} */
  const candidates = []
  if (process.platform === 'win32') {
    const list = spawnSync('where.exe', ['pnpm'], { encoding: 'utf8' })
    const found = (list.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => /pnpm\.(cmd|exe|bat)$/i.test(s))
    // .cmd 需经 cmd.exe 运行；先试 where 找到的路径，再试 PATH 里的 pnpm.cmd
    const cmd = process.env.ComSpec || 'cmd.exe'
    if (found) candidates.push([cmd, ['/d', '/c', found]])
    candidates.push([cmd, ['/d', '/c', 'pnpm.cmd']])
  } else {
    candidates.push(['pnpm'])
  }
  for (const [bin, prefix] of candidates) {
    const argv = [...(Array.isArray(prefix) ? prefix : []), 'pack', '--dry-run', '--json', '--pack-destination', `"${outDir}"`]
    const r = spawnSync(bin, argv, { cwd: here, encoding: 'utf8' })
    if (!r || r.status !== 0 || !r.stdout) continue
    let doc
    try {
      doc = JSON.parse(r.stdout.slice(Math.max(0, r.stdout.indexOf('{'))))
    } catch {
      continue
    }
    const entry = Array.isArray(doc) ? doc[0] : doc
    if (entry?.files?.length) return entry.files.map((f) => f.path.replace(/\\/g, '/'))
  }
  return null
}

/** 兜底：按 package.json 的 "files" 字段扫。 */
function fromFilesField() {
  const roots = pkg.files ?? ['lib', 'vendor', 'cordis.patch.yml', 'README.md', 'package.json']
  const out = ['package.json']
  const walk = (abs, rel) => {
    const st = statSync(abs)
    if (st.isDirectory()) for (const name of readdirSync(abs).sort()) walk(join(abs, name), rel + '/' + name)
    else if (st.isFile()) out.push(rel)
  }
  for (const r of roots) {
    if (r === 'package.json') continue
    walk(join(here, r), r.split(sep).join('/'))
  }
  return out
}

const dry = fromPackDryRun()
const rels = dry ?? fromFilesField()
const source = dry ? 'pnpm/npm pack --dry-run' : 'package.json files 字段'
const listing = rels.map((rel) => {
  const abs = join(here, rel.split('/').join(sep))
  const mode = statSync(abs).mode
  return { rel, abs, data: readFileSync(abs), mode: mode & 0o777 }
})

const have = new Set(listing.map((f) => f.rel))
for (const req of REQUIRED) if (!have.has(req)) throw new Error('required file not collected: ' + req)

// ---------- 2. 打 tar（ustar + PAX 长路径） ----------
const FIXED_MTIME = Math.floor(Date.UTC(1985, 9, 26, 8, 15, 0) / 1000) // npm pack 用的固定时间戳

function octal(value, width) {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii')
}
function tarHeader(name, size, mode, typeflag) {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  octal(mode, 8).copy(h, 100)
  octal(0, 8).copy(h, 108) // uid
  octal(0, 8).copy(h, 116) // gid
  octal(typeflag === '0' ? size : 0, 12).copy(h, 124)
  octal(FIXED_MTIME, 12).copy(h, 136)
  h.write('        ', 148, 8, 'ascii')
  h.write(typeflag, 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  h.write('root', 265, 32, 'ascii')
  h.write('root', 297, 32, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}
function pad512(buf) {
  const rem = buf.length % 512
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem)])
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  return Buffer.from(len + body, 'utf8')
}

const parts = [tarHeader('package/', 0, 0o755, '5')]
for (const f of listing) {
  const full = 'package/' + f.rel
  const tooLong = Buffer.byteLength(full) > 100
  if (tooLong) {
    const body = paxRecord('path', full)
    parts.push(tarHeader('package/PaxHeader/' + 'local-file', body.length, 0o644, 'x'))
    parts.push(pad512(body))
  }
  const name = tooLong ? 'package/PaxHeader/' + f.rel.slice(-60) : full
  parts.push(tarHeader(name, f.data.length, f.mode, '0'))
  parts.push(pad512(f.data))
}
parts.push(Buffer.alloc(1024)) // 两个全零块 = 归档结束

const gzBuf = gzipSync(Buffer.concat(parts), { level: 9 })

// ---------- 3. 报告 ----------
const tgzName = `${pkg.name}-${pkg.version}.tgz`
const target = join(outDir, tgzName)
const sha = createHash('sha256').update(gzBuf).digest('hex')
const totalRaw = listing.reduce((s, f) => s + f.data.length, 0)

console.log(`${pkg.name}@${pkg.version}   清单来源：${source}`)
console.log(`文件 ${listing.length} 个，原始 ${(totalRaw / 1024).toFixed(0)} KB，tgz ${(gzBuf.length / 1024).toFixed(1)} KB`)
console.log(`sha256 ${sha}`)
const byDir = {}
for (const f of listing) {
  const top = f.rel.includes('/') ? f.rel.split('/')[0] + '/' : f.rel
  byDir[top] = (byDir[top] ?? 0) + f.data.length
}
for (const [k, v] of Object.entries(byDir).sort()) console.log(`  ${k.padEnd(22)} ${(v / 1024).toFixed(0)} KB`)
console.log('最大的文件：')
for (const f of [...listing].sort((a, b) => b.data.length - a.data.length).slice(0, 8)) {
  console.log(`  ${(f.data.length / 1024).toFixed(0).padStart(6)} KB  ${f.rel}`)
}

if (checkOnly) {
  console.log('\n[--check] 未写盘。')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(target, gzBuf)
writeFileSync(target.replace(/\.tgz$/, '.sha256'), `${sha}  ${tgzName}\n`)
for (const name of readdirSync(outDir)) {
  if (/\.tgz$/.test(name) && name !== tgzName) rmSync(join(outDir, name), { force: true })
}
console.log(`\n已写出 ${relative(process.cwd(), target) || target}`)
