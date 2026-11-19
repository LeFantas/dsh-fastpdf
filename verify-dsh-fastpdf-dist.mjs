/**
 * dsh-fastpdf 分发包校验（只读，不改任何东西）
 *
 *   node verify-dsh-fastpdf-dist.mjs [tgz路径]
 *
 * 校验项：
 *   1. tgz 能被本脚本里的纯 JS tar 解析器解开（不依赖系统 tar）
 *   2. 必需文件齐全、没有多余顶层条目、内容与源目录逐字节一致
 *   3. package.json 有 name / version / main / dsh.bundle.patch / dsh.client
 *   4. lib/*.js 语法通过，宿主入口能被 import
 *   5. cordis.patch.yml 恰好 insert 一条 dsh-fastpdf
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { gunzipSync } from 'node:zlib'

const here = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname)
const tgz = process.argv[2] ? resolve(process.argv[2]) : join(here, 'dist', 'dsh-fastpdf-1.0.0.tgz')

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
const ALLOWED_TOP = ['package.json', 'cordis.patch.yml', 'README.md', 'lib', 'vendor']
const SOURCE_ONLY = ['dist-dsh-fastpdf.mjs', 'verify-dsh-fastpdf-dist.mjs'] // 构建脚本不应出现在分发包里

const problems = []
const ok = (msg) => console.log('  ok   ' + msg)
const bad = (msg) => {
  problems.push(msg)
  console.log('  FAIL ' + msg)
}

/** 纯 JS 解 tar（ustar + PAX path，只看普通文件；目录条目忽略）。 */
function untar(buf) {
  const out = new Map() // rel（去掉 package/ 前缀）-> Buffer
  let off = 0
  let pendingPath = null
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break
    const str = (start, len) => {
      const s = h.subarray(start, start + len)
      const z = s.indexOf(0)
      return s.subarray(0, z < 0 ? s.length : z).toString('utf8')
    }
    const num = (start, len) => parseInt(str(start, len).trim() || '0', 8)
    const name = str(0, 100)
    const size = num(124, 12)
    const typeflag = String.fromCharCode(h[156]) || '0'
    const prefix = str(345, 155)
    const full = prefix ? prefix + '/' + name : name
    const dataStart = off + 512
    const data = buf.subarray(dataStart, dataStart + size)
    if (typeflag === 'x') {
      const m = /=([^\n]*)\n/.exec(data.toString('utf8'))
      if (m) pendingPath = m[1]
    } else if (typeflag === '0' || typeflag === '\0') {
      const rel = (pendingPath ?? full).replace(/^package\//, '')
      pendingPath = null
      out.set(rel, Buffer.from(data))
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return out
}

const t0 = Date.now()
console.log('校验 ' + tgz)
const raw = readFileSync(tgz)
const tarBuf = gunzipSync(raw)
console.log('sha256 ' + createHash('sha256').update(raw).digest('hex'))
console.log('大小   ' + (raw.length / 1024).toFixed(1) + ' KB（解压后 ' + (tarBuf.length / 1024).toFixed(0) + ' KB）')

let entries
try {
  entries = untar(tarBuf)
  ok('tgz 解析成功，含 ' + entries.size + ' 个文件')
} catch (e) {
  bad('tgz 解析失败: ' + e.message)
  entries = new Map()
}

// 2. 清单
const names = [...entries.keys()].sort()
for (const req of REQUIRED) {
  if (entries.has(req)) ok('包含 ' + req)
  else bad('缺少 ' + req)
}
const top = new Set(names.map((p) => p.split('/')[0]))
for (const t of top) if (!ALLOWED_TOP.includes(t) && !SOURCE_ONLY.includes(t)) bad('多余顶层条目 ' + t)
for (const s of SOURCE_ONLY) if (entries.has(s)) bad('分发包里不该有构建脚本 ' + s)
ok('顶层条目：' + [...top].join(', '))

// 3. package.json 元数据
const pkgBuf = entries.get('package.json')
if (!pkgBuf) {
  bad('无法读取 package.json')
} else {
  const pkg = JSON.parse(pkgBuf.toString('utf8'))
  if (pkg.name === 'dsh-fastpdf') ok('name ' + pkg.name)
  else bad('name 异常 ' + pkg.name)
  if (pkg.version) ok('version ' + pkg.version)
  else bad('缺 version')
  if (pkg.main && entries.has(pkg.main.replace(/^\.\//, ''))) ok('main ' + pkg.main)
  else bad('main 指向的文件不在包里: ' + pkg.main)
  const patchRel = pkg.dsh?.bundle?.patch
  if (patchRel && entries.has(patchRel.replace(/^\.\//, ''))) ok('bundle patch ' + patchRel)
  else bad('缺 dsh.bundle.patch 或文件不在包里')
  if (pkg.dsh?.client?.platform) ok('client platform ' + pkg.dsh.client.platform + '，inject ' + (pkg.dsh.client.inject ?? []).length + ' 项')
  else bad('缺 dsh.client')
  if (pkg.files) ok('files 白名单 ' + JSON.stringify(pkg.files))
  else bad('缺 files 白名单')
}

// 4. 语法 + 宿主入口加载
const work = mkdtempSync(join(here, '.verify-'))
try {
  for (const [rel, data] of entries) {
    const p = join(work, rel.split('/').join(sep))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, data)
  }
  for (const js of ['lib/index.js', 'lib/client.js']) {
    if (!entries.has(js)) continue
    try {
      new vm.SourceTextModule(entries.get(js).toString('utf8'), { identifier: js })
      ok('语法 ' + js)
    } catch (e) {
      bad('语法错误 ' + js + ': ' + String(e.message).slice(0, 200))
    }
  }
  try {
    const mod = await import(pathToFileURL(join(work, 'lib', 'index.js')).href)
    ok(`宿主入口可 import（name=${mod.name}, inject=${JSON.stringify(mod.inject)}）`)
  } catch (e) {
    bad('宿主入口 import 失败: ' + e.message)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

// 5. cordis patch
const patchBuf = entries.get('cordis.patch.yml')
if (!patchBuf) {
  bad('缺 cordis.patch.yml')
} else {
  const patch = patchBuf.toString('utf8')
  if (/id:\s*dsh-fastpdf/.test(patch)) ok('patch 含 dsh-fastpdf 行')
  else bad('patch 里没有 dsh-fastpdf')
  const inserts = (patch.match(/- insert:/g) ?? []).length
  if (inserts === 1) ok('patch 只有 1 个 insert')
  else bad('patch insert 数量 ' + inserts)
}

// 6. 内容与源目录逐字节一致
let diffs = 0
for (const rel of names) {
  const src = join(here, rel.split('/').join(sep))
  if (!statSync(src, { throwIfNoEntry: false })) {
    bad('源目录缺少 ' + rel)
    diffs++
    continue
  }
  if (!readFileSync(src).equals(entries.get(rel))) {
    bad('内容与源不一致 ' + rel)
    diffs++
  }
}
if (!diffs) ok('所有文件与源目录逐字节一致')

console.log('')
console.log(`耗时 ${Date.now() - t0} ms`)
if (problems.length) {
  console.log(`结论：${problems.length} 项失败`)
  process.exit(1)
}
console.log('结论：全部通过，包可直接分发。')
