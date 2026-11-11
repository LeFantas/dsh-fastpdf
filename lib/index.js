/**
 * dsh-fastpdf host half —— 用 Windows 自带的 PDF 引擎（WinRT Windows.Data.Pdf，PDFium 内核）
 * 把页渲染成 PNG，侧边栏只显示图片流。
 *
 * 为什么绕这么大一圈：
 *  DSH 内置的侧边栏 PDF 预览是打包进前端的 pdf.js，打开一次就要加载 7.1 MB chunk、
 *  在 renderer 里新建 module Worker、把整份文件字节读进来、首屏还会按 zoom=1 渲一遍
 *  再按 fit-width 重渲一遍。而主窗口又没开 `webPreferences.plugins`，侧边栏里连
 *  Chromium 自带的 PDFium 都用不了（webview 也被主进程强制 plugins:false）。
 *  于是把渲染搬到宿主：常驻一个 Windows PowerShell 5.1 进程，用系统的 PdfDocument
 *  光栅化单页，前端 `<img>` 按需拉取。PDF 解析、字体、CMap 全部交给系统，前端零负担。
 *
 * 协议（见 lib/render-server.ps1）：stdin/stdout 一行一个 JSON。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-fastpdf'
export const inject = ['webServer']

/** RPC 路由。 */
const RPC_PATH = '/dmzpdf/rpc'
/** 页面图片路由（prefix：带查询串）。 */
const PAGE_PATH = '/dmzpdf/page'
/** pdf.js 静态资源路由：客户端从这里加载 pdf.mjs / pdf.worker.mjs。 */
const VENDOR_PATH = '/dmzpdf/vendor'
/** 随包静态资源根（vendor/pdfjs/...）。 */
const VENDOR_DIR = join(dirname(fileURLToPath(new URL('./index.js', import.meta.url))), '..', 'vendor')
/** 客户端诊断上报。 */
const LOG_PATH = '/dmzpdf/log'
/** 请求体上限：几个路径字符串而已。 */
const MAX_BODY = 64 * 1024
/** 单个渲染请求的等待上限。 */
const RENDER_TIMEOUT_MS = 30_000
/** 页面缓存目录与总量上限。 */
const CACHE_DIR = join(tmpdir(), 'dsh-fastpdf', 'pages')
const CACHE_MAX_BYTES = 512 * 1024 * 1024
/** 客户端日志。 */
const LOG_DIR = join(homedir(), '.dsh', 'dsh-fastpdf')
const LOG_FILE = join(LOG_DIR, 'client.log')
const LOG_MAX_BYTES = 256 * 1024

/** 只认 PDF。 */
const PDF_EXTS = new Set(['.pdf'])
/** 渲染宽度上下限（CSS 像素 × dpr 之后的实际像素）。 */
const MIN_WIDTH = 200
const MAX_WIDTH = 3200

/** 常驻渲染进程与其状态。 */
let server = null
/** 请求 id 自增。 */
let nextId = 1
/** 在途请求：id -> { resolve, reject, timer }。 */
const pending = new Map()
/** 输出行缓冲。 */
let stdoutBuffer = ''
/** 串行队列：一个 PowerShell 进程一次只干一件事。 */
let queue = Promise.resolve()
/** 正在渲染的 key -> Promise，避免同一页被并发请求渲多遍。 */
const inflight = new Map()
/** 最近一次错误，便于 /status 排查。 */
let lastError = null

/** 统一取错误消息。 */
function msgOf(error) {
  return String(error && error.message ? error.message : error)
}

function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch { /* 忽略 */ }
}

/** 客户端日志（滚动截断）。 */
function writeClientLog(level, text) {
  try {
    ensureDir(LOG_DIR)
    let size = 0
    try { size = statSync(LOG_FILE).size } catch { size = 0 }
    if (size > LOG_MAX_BYTES) writeFileSync(LOG_FILE, '')
    writeFileSync(LOG_FILE, `[${new Date().toISOString()}] [${level}] ${text}\n`, { flag: 'a' })
  } catch { /* 日志失败不影响功能 */ }
}

/** 渲染脚本路径（相对本文件）。 */
function scriptPath() {
  return new URL('./render-server.ps1', import.meta.url)
}

/** Windows PowerShell 5.1 的固定路径：PowerShell 7 加载不了 WinRT 投影。 */
function powershellPath() {
  if (process.env.DSH_FASTPDF_PWSH) return process.env.DSH_FASTPDF_PWSH
  const root = process.env.SystemRoot || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** 清掉过期的页面缓存（启动时调用一次）。 */
function pruneCache() {
  try {
    if (!existsSync(CACHE_DIR)) return
    let total = 0
    const files = []
    for (const name of readdirSync(CACHE_DIR)) {
      const full = join(CACHE_DIR, name)
      try {
        const info = statSync(full)
        total += info.size
        files.push({ full, size: info.size, at: info.mtimeMs })
      } catch { /* 忽略 */ }
    }
    if (total <= CACHE_MAX_BYTES) return
    files.sort((a, b) => a.at - b.at)
    for (const file of files) {
      if (total <= CACHE_MAX_BYTES) break
      try { unlinkSync(file.full); total -= file.size } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
}

/**
 * 校验目标文件：绝对路径、存在、普通文件、.pdf。
 * @param absPath 客户端解析出的绝对路径
 * @returns { ok: true, abs, size, mtimeMs } 或 { ok: false, error }
 */
function checkTarget(absPath) {
  if (typeof absPath !== 'string' || absPath.trim() === '') return { ok: false, error: '缺少文件路径' }
  const abs = absPath.trim()
  if (!/^[a-zA-Z]:[\\/]|^\//.test(abs)) return { ok: false, error: '只接受绝对路径' }
  if (!PDF_EXTS.has(extname(abs).toLowerCase())) return { ok: false, error: '只支持 .pdf 文件' }
  try {
    const info = statSync(abs)
    if (!info.isFile()) return { ok: false, error: '目标不是普通文件' }
    return { ok: true, abs, size: info.size, mtimeMs: Math.round(info.mtimeMs) }
  } catch (error) {
    return { ok: false, error: '文件不存在或无法访问：' + msgOf(error) }
  }
}

/** 结束常驻进程并让所有在途请求失败。 */
function shutdownServer(reason) {
  const child = server
  server = null
  if (child !== null) {
    try { child.kill() } catch { /* 已退出 */ }
  }
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason || '渲染进程已停止'))
    pending.delete(id)
  }
}

/** 处理渲染进程的一行输出。 */
function onLine(line) {
  if (line.trim() === '') return
  let payload
  try { payload = JSON.parse(line) } catch { return }
  if (payload.ready === true && payload.id === undefined) return // 启动握手
  const id = payload.id
  if (id === undefined) return
  const entry = pending.get(id)
  if (entry === undefined) return
  pending.delete(id)
  clearTimeout(entry.timer)
  if (payload.ok === true) entry.resolve(payload)
  else {
    lastError = payload.error || 'unknown render error'
    entry.reject(new Error(lastError))
  }
}

/** 确保常驻渲染进程可用。 */
function ensureServer() {
  if (server !== null && server.exitCode === null) return server
  if (platform() !== 'win32') throw new Error('本地 PDF 渲染依赖 Windows.Data.Pdf，仅支持 Windows')
  const file = fileURLToPath(scriptPath())
  const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  server = child
  stdoutBuffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    let index
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, '')
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      onLine(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text !== '') writeClientLog('stderr', text.slice(0, 800))
  })
  child.on('exit', (code) => {
    if (server === child) {
      server = null
      shutdownServer('渲染进程退出（code=' + String(code) + '）')
    }
  })
  child.on('error', (error) => {
    lastError = msgOf(error)
    if (server === child) {
      server = null
      shutdownServer('渲染进程启动失败：' + lastError)
    }
  })
  return child
}

/**
 * 发一条请求给渲染进程（串行）。
 * @param payload 命令体（不含 id）
 * @returns 渲染进程的响应
 */
function request(payload) {
  const run = () => new Promise((resolve, reject) => {
    let child
    try {
      child = ensureServer()
    } catch (error) {
      reject(error)
      return
    }
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('渲染超时（' + RENDER_TIMEOUT_MS + 'ms）'))
    }, RENDER_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    try {
      child.stdin.write(JSON.stringify({ id, ...payload }) + '\n', 'utf8')
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(error)
    }
  })
  const next = queue.then(run, run)
  // 队列本身不能因为一次失败卡死
  queue = next.then(() => undefined, () => undefined)
  return next
}

/** 取文档信息（页数 + 前若干页尺寸）。 */
async function documentInfo(absPath) {
  const target = checkTarget(absPath)
  if (!target.ok) throw new Error(target.error)
  const info = await request({ cmd: 'info', path: target.abs })
  return {
    absPath: target.abs,
    pages: Number(info.pages) || 0,
    sizes: Array.isArray(info.sizes) ? info.sizes : [],
    mtimeMs: target.mtimeMs,
    bytes: target.size,
  }
}

/** 缓存文件名。 */
function cacheKeyOf(absPath, mtimeMs, page, width) {
  return createHash('sha1')
    .update(`${absPath}|${mtimeMs}|${page}|${width}`)
    .digest('hex')
}

/**
 * 取一页的 PNG。命中缓存直接读盘。
 * @param absPath 绝对路径
 * @param page 0 基页号
 * @param width 目标像素宽
 * @returns { buffer, key }
 */
async function pagePng(absPath, page, width) {
  const target = checkTarget(absPath)
  if (!target.ok) throw new Error(target.error)
  const index = Math.max(0, Math.trunc(Number(page) || 0))
  let px = Math.trunc(Number(width) || 0)
  if (!Number.isFinite(px) || px <= 0) px = 1000
  px = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px))

  const key = cacheKeyOf(target.abs, target.mtimeMs, index, px)
  const file = join(CACHE_DIR, key + '.png')
  if (existsSync(file)) {
    try { return { buffer: readFileSync(file), key } } catch { /* 读不到就重渲 */ }
  }
  const existing = inflight.get(key)
  if (existing !== undefined) return existing

  const task = (async () => {
    ensureDir(CACHE_DIR)
    await request({ cmd: 'render', path: target.abs, page: index, width: px, out: file })
    return { buffer: readFileSync(file), key }
  })()
  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}

/** 用系统默认程序打开文件（纯 node，不依赖 Electron）。 */
function openWithSystemApp(absPath) {
  const target = checkTarget(absPath)
  if (!target.ok) return { ok: false, error: target.error }
  const spawnOptions = { detached: true, stdio: 'ignore', windowsHide: false }
  try {
    if (platform() === 'win32') {
      // explorer 是 Windows 上"用默认关联程序打开"最稳的入口，不经过 shell 拼接
      spawn('explorer.exe', [target.abs], spawnOptions).unref()
    } else if (platform() === 'darwin') {
      spawn('open', [target.abs], spawnOptions).unref()
    } else {
      spawn('xdg-open', [target.abs], spawnOptions).unref()
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: msgOf(error) }
  }
}

/** 读 JSON 请求体。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 回 JSON。 */
function replyJson(res, status, payload) {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 回图片。 */
function replyPng(res, buffer, key) {
  if (res.headersSent) return
  res.writeHead(200, {
    'content-type': 'image/png',
    // key 里已经含路径 + mtime + 页号 + 宽度，文件改了就换 key
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': buffer.length,
    'x-page-key': key,
  })
  res.end(buffer)
}

/** 扩展名 → MIME。缺省 octet-stream，避免把 .mjs 猜成别的。 */
const VENDOR_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.bcmap': 'binary/octet-stream',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 提供随包附带的 pdf.js 静态资源。
 * @param req 原始请求
 * @param res 响应
 */
function serveVendor(req, res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    const rel = decodeURIComponent(url.pathname.slice(VENDOR_PATH.length)).replace(/^\/+/, '')
    if (rel === '') {
      replyJson(res, 404, { ok: false, error: 'vendor: empty path' })
      return
    }
    const full = normalize(join(VENDOR_DIR, rel))
    // 目录穿越防护：拼出来的路径必须仍在 vendor 目录里
    if (full !== VENDOR_DIR && !full.startsWith(VENDOR_DIR + sep)) {
      replyJson(res, 403, { ok: false, error: 'vendor: out of root' })
      return
    }
    const info = statSync(full)
    if (!info.isFile()) {
      replyJson(res, 404, { ok: false, error: 'vendor: not a file' })
      return
    }
    const body = readFileSync(full)
    if (res.headersSent) return
    res.writeHead(200, {
      'content-type': VENDOR_MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      // 文件名带版本语义（跟随 DSH 升级替换），长缓存 + 强校验
      'cache-control': 'public, max-age=86400',
      'content-length': body.length,
    })
    res.end(body)
  } catch (error) {
    replyJson(res, 404, { ok: false, error: 'vendor: ' + msgOf(error) })
  }
}

/** 宿主鉴权：沿用 DSH 自己的判据。 */
function rejectionOf(ctx, req) {  try {
    const connection = ctx.get('connection')
    if (connection && typeof connection.requestRejection === 'function') {
      return connection.requestRejection(req)
    }
  } catch { /* 服务缺失按放行处理 */ }
  return undefined
}

/** 业务分发。 */
async function dispatch(ctx, method, args) {
  if (method === 'ping') return { ok: true, data: { pong: Date.now(), server: server !== null && server.exitCode === null } }
  if (method === 'info') return { ok: true, data: await documentInfo(args && args.absPath) }
  if (method === 'external') return openWithSystemApp(args && args.absPath)
  if (method === 'close') {
    const target = checkTarget(args && args.absPath)
    if (!target.ok) return { ok: false, error: target.error }
    try {
      await request({ cmd: 'close', path: target.abs })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: msgOf(error) }
    }
  }
  if (method === 'status') {
    return {
      ok: true,
      data: {
        server: server !== null && server.exitCode === null,
        inflight: inflight.size,
        pending: pending.size,
        lastError,
      },
    }
  }
  return { ok: false, error: '未知方法：' + String(method) }
}

export function apply(ctx) {
  const install = () => {
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('[dsh-fastpdf] webServer 不可用，本地 PDF 渲染未挂载')
      return () => {}
    }
    const disposers = []
    pruneCache()

    // pdf.js 静态资源（客户端加载 pdf.mjs / pdf.worker.mjs 用）
    try {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: VENDOR_PATH,
        methods: ['GET'],
        handler: async (req, res) => { serveVendor(req, res) },
      }))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-fastpdf] vendor 路由注册失败：' + msgOf(error))
    }

    // 页面图片：prefix 因为带查询串
    try {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: PAGE_PATH,
        methods: ['GET'],
        handler: async (req, res) => {
          const rejection = rejectionOf(ctx, req)
          if (rejection !== undefined) {
            replyJson(res, rejection === 401 || rejection === 403 ? rejection : 503, { ok: false, error: '宿主鉴权拒绝' })
            return
          }
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const absPath = url.searchParams.get('path') || ''
            const page = url.searchParams.get('n') || '0'
            const width = url.searchParams.get('w') || '1000'
            const result = await pagePng(absPath, page, width)
            replyPng(res, result.buffer, result.key)
          } catch (error) {
            lastError = msgOf(error)
            replyJson(res, 404, { ok: false, error: lastError })
          }
        },
      }))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-fastpdf] 页面路由注册失败：' + msgOf(error))
    }

    try {
      disposers.push(webServer.register({
        kind: 'exact',
        path: LOG_PATH,
        methods: ['POST'],
        handler: async (req, res) => {
          try {
            const body = await readJson(req)
            writeClientLog(typeof body.level === 'string' ? body.level : 'info', String(body.text ?? ''))
          } catch { /* 忽略 */ }
          replyJson(res, 200, { ok: true })
        },
      }))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-fastpdf] 日志路由注册失败：' + msgOf(error))
    }

    try {
      disposers.push(webServer.register({
        kind: 'exact',
        path: RPC_PATH,
        methods: ['POST'],
        handler: async (req, res) => {
          const rejection = rejectionOf(ctx, req)
          if (rejection !== undefined) {
            replyJson(res, rejection === 401 || rejection === 403 ? rejection : 503, { ok: false, error: '宿主鉴权拒绝' })
            return
          }
          try {
            const body = await readJson(req)
            const result = await dispatch(ctx, body.method, body.args || {})
            replyJson(res, 200, result)
          } catch (error) {
            lastError = msgOf(error)
            replyJson(res, 500, { ok: false, error: lastError })
          }
        },
      }))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-fastpdf] RPC 路由注册失败：' + msgOf(error))
    }

    // 图片流方案（render-server.ps1 + /dmzpdf/page）已不是主路径，这里不做预热：
    // 只有真正请求 /dmzpdf/page 时才会拉起那个常驻渲染子进程。

    ctx.logger?.info?.(`[dsh-fastpdf] 已挂载 ${RPC_PATH} / ${PAGE_PATH} / ${LOG_PATH}`)
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 已释放 */ }
      }
      shutdownServer('插件已卸载')
    }
  }
  ctx.effect(install, 'fastpdf: rpc')
}
