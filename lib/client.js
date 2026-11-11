/**
 * dsh-fastpdf client half —— 接管侧边栏的 PDF 预览，用 pdf.js 但避开内置实现的全部慢点。
 *
 * 参考 dsh-dmzlatexworkshop 的 PDF 面板（那个很快），差异在于它自己一个 pane tab，
 * 这里要挂进 DSH 原生的文档预览 slot。
 *
 * 相比内置 pdf.js 预览（7.1 MB chunk）省掉的：
 *   1. 只加载 build/pdf.mjs（798 KB），不带 4.57 MB base64 CMap、不带 pdf_viewer 全量
 *   2. worker 是独立 pdf.worker.mjs 文件，走 HTTP 缓存，浏览器进程内只编译一次
 *   3. 不做文本层（每页上千 span 全省）
 *   4. 每页渲染完不做 page.cleanup()，回滚不用重新解析
 *   5. 滚到哪渲到哪（IntersectionObserver + 320px 预取），不预渲视口外的页
 *   6. 首帧不做 zoom=1 的全分辨率预渲染
 */

window.__ModuleLoader__ && window.__ModuleLoader__.load({
  id: 'dsh-fastpdf',
  factory: function (require) {
    var exports = {}
    var VERSION = '1.0.0'
    var RPC_PATH = '/dmzpdf/rpc'
    var LOG_PATH = '/dmzpdf/log'
    /** 随包 pdf.js 的资源前缀（宿主 /dmzpdf/vendor 路由）。 */
    var VENDOR = '/dmzpdf/vendor/pdfjs'
    /** 本文档预览在注册表里的身份。 */
    var BODY_ID = 'dsh-fastpdf/pdf'
    var FILE_PREFIX = 'dsh-resource://file/'
    /** 缩放档位（在适宽基础上的倍率）。 */
    var FACTORS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]
    /** 预取距离。 */
    var PRELOAD_MARGIN = '320px 0px'

    var react = null
    try { react = require('react') } catch (error) { react = null }

    /** 全局缓存的 pdf.js 命名空间（跨 tab 复用，只加载一次）。 */
    var pdfLibPromise = null

    function appUrl(path) {
      try {
        var base = (typeof document !== 'undefined' && document.baseURI) || location.href
        return new URL(String(path).replace(/^\/+/, ''), new URL('.', base)).href
      } catch (error) {
        return String(path)
      }
    }

    function errText(error) {
      return String(error && error.message ? error.message : error)
    }

    function report(level, text) {
      try {
        fetch(appUrl(LOG_PATH), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ level: level, text: '[client] ' + text }),
        }).catch(function () {})
      } catch (error) { /* 忽略 */ }
    }

    function rpc(method, args) {
      return fetch(appUrl(RPC_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, args: args || {} }),
      }).then(function (res) {
        if (!res.ok) throw new Error('宿主返回 HTTP ' + res.status)
        return res.json()
      })
    }

    /** 解析 `dsh-resource://file/...`。 */
    function parseAddress(address) {
      if (typeof address !== 'string' || address.indexOf(FILE_PREFIX) !== 0) return undefined
      var end = address.search(/[?#]/)
      var body = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end)
      var parts = body.split('/')
      var scope = parts.shift()
      try {
        if (scope === 'session') {
          var id = parts.shift()
          if (!id || parts.length === 0) return undefined
          return { sessionId: decodeURIComponent(id), path: parts.map(decodeURIComponent).join('/') }
        }
        if (scope === 'absolute') {
          var segments = parts.map(decodeURIComponent)
          var joined = segments.join('/')
          if (/^[A-Za-z]:$/.test(segments[0] || '')) return { absPath: joined }
          return { absPath: '/' + joined }
        }
      } catch (error) { return undefined }
      return undefined
    }

    function nameOf(value) {
      var text = String(value || '')
      var cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return cut >= 0 ? text.slice(cut + 1) : text
    }

    /** 绝对路径：只在点「系统阅读器」时才用，走一次轻量 stat。 */
    function resolveAbsPath(ctx, address, signal) {
      var parsed = parseAddress(address)
      if (parsed === undefined) return Promise.reject(new Error('无法识别的文件地址'))
      if (parsed.absPath !== undefined) return Promise.resolve(parsed.absPath)
      var remote = null
      try { remote = ctx.get('remote') } catch (error) { remote = null }
      var files = remote && remote.workspaceFiles
      if (!files || typeof files.stat !== 'function') return Promise.reject(new Error('workspaceFiles 服务不可用'))
      return files.stat(parsed.sessionId, parsed.path, signal).then(function (result) {
        if (!result || result.ok !== true) throw new Error('无法解析文件路径')
        var abs = result.value && result.value.absolutePath
        if (typeof abs !== 'string' || abs === '') throw new Error('宿主没有返回绝对路径')
        return abs
      })
    }

    /**
     * 加载随包的 pdf.js。
     *
     * 不走动态 import：客户端包会被打包器改写，URL 语义会坏（latex 工作台也踩过）。
     * 改成注入 inline `<script type="module">`，让浏览器原生解析静态 import。
     */
    function loadPdfLib() {
      if (pdfLibPromise) return pdfLibPromise
      var base = appUrl(VENDOR)

      function adopt(lib) {
        try {
          if (lib && lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = base + '/build/pdf.worker.mjs'
        } catch (error) { /* 留给 getDocument 报错 */ }
        return lib
      }

      var cached = null
      try { cached = window.__dshFastPdfLib } catch (error) { cached = null }
      if (cached && typeof cached.getDocument === 'function') {
        pdfLibPromise = Promise.resolve(adopt(cached))
        return pdfLibPromise
      }

      pdfLibPromise = new Promise(function (resolve, reject) {
        var settled = false
        function finish() {
          if (settled) return
          var lib = null
          try { lib = window.__dshFastPdfLib } catch (error) { lib = null }
          if (!lib || typeof lib.getDocument !== 'function') {
            settled = true
            reject(new Error('pdf.js 模块未就绪'))
            return
          }
          settled = true
          report('info', 'pdf.js 已加载')
          resolve(adopt(lib))
        }
        var tag = document.querySelector('script[data-dsh-fastpdf-lib]')
        if (tag) {
          tag.addEventListener('dsh-fastpdf-lib-ready', finish, { once: true })
          setTimeout(finish, 1000)
          return
        }
        var s = document.createElement('script')
        s.type = 'module'
        s.textContent =
          'import * as lib from ' + JSON.stringify(base + '/build/pdf.mjs') + ';\n' +
          'window.__dshFastPdfLib = lib;\n' +
          'document.querySelector("script[data-dsh-fastpdf-lib]").dispatchEvent(new Event("dsh-fastpdf-lib-ready"));'
        s.setAttribute('data-dsh-fastpdf-lib', '1')
        s.onerror = function () {
          if (settled) return
          settled = true
          reject(new Error('pdf.mjs 加载失败（检查 /dmzpdf/vendor 路由）'))
        }
        ;(document.head || document.documentElement).appendChild(s)
        // inline module 的 onload 不可靠，轮询交接变量
        var tick = setInterval(function () {
          if (settled) { clearInterval(tick); return }
          var got = null
          try { got = window.__dshFastPdfLib } catch (error) { got = null }
          if (got && typeof got.getDocument === 'function') { clearInterval(tick); finish() }
        }, 120)
        setTimeout(function () { if (!settled) { clearInterval(tick); finish() } }, 15000)
      }).catch(function (error) {
        pdfLibPromise = null
        report('error', 'pdf.js 加载失败：' + errText(error))
        throw error
      })
      return pdfLibPromise
    }

    // --region 样式

    var CSS = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: '0',
        background: 'var(--dsw-alias-bg-document-preview, #1b1b1d)',
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        fontFamily: 'var(--dsw-font, system-ui, sans-serif)',
        fontSize: '13px',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1))',
        flex: '0 0 auto',
        boxSizing: 'border-box',
      },
      barName: {
        flex: '1 1 auto',
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '12px',
      },
      meta: {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-secondary, rgba(230,230,230,.6))',
        fontSize: '11px',
        fontVariantNumeric: 'tabular-nums',
      },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))',
        background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,.06))',
        color: 'inherit',
        borderRadius: '6px',
        padding: '2px 7px',
        fontSize: '11px',
        lineHeight: '1.6',
        cursor: 'pointer',
        fontFamily: 'inherit',
        flex: '0 0 auto',
      },
      scroll: {
        flex: '1 1 auto',
        minHeight: '0',
        overflow: 'auto',
        padding: '12px 0 24px',
        position: 'relative',
      },
      pages: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '12px',
      },
      status: {
        padding: '24px 20px',
        color: 'var(--dsw-alias-label-secondary, rgba(230,230,230,.7))',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        alignItems: 'flex-start',
      },
      bad: { color: 'var(--dsw-alias-label-danger, #ff7b72)', fontSize: '12px' },
    }

    /** 页面槽位类名（原生 DOM，不走 React）。 */
    var SLOT_CLASS = 'dsh-fastpdf-slot'
    var PH_CLASS = 'dsh-fastpdf-ph'
    var ERR_CLASS = 'dsh-fastpdf-err'

    /** 注入一次样式表。 */
    function ensureStyle() {
      try {
        if (document.querySelector('style[data-dsh-fastpdf-page]')) return
        var style = document.createElement('style')
        style.setAttribute('data-dsh-fastpdf-page', '1')
        style.textContent =
          '.' + SLOT_CLASS + '{position:relative;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.35);display:block;flex:0 0 auto;}' +
          '.' + SLOT_CLASS + ' canvas{display:block;width:100%;height:auto;}' +
          '.' + PH_CLASS + '{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa0a6;font-size:12px;font-family:var(--dsw-font,system-ui,sans-serif);}' +
          '.' + ERR_CLASS + '{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#b3261e;font-size:11px;padding:12px;text-align:center;font-family:var(--dsw-font,system-ui,sans-serif);}'
        ;(document.head || document.documentElement).appendChild(style)
      } catch (error) { /* 忽略 */ }
    }

    // --region 正文组件

    /**
     * PDF 阅读器：pdf.js 画 canvas，滚到哪渲到哪。
     * @param props content.kind === 'bytes' 时 data 就是完整文件字节
     * @returns 阅读器
     */
    function FastPdfBody(props) {
      var h = react.createElement
      var address = props && props.resourceAddress
      var name = nameOf(address)
      var content = props && props.content
      var bytes = content && content.kind === 'bytes' ? content.data : undefined

      var statusHolder = react.useState({ phase: 'idle', pages: 0, scale: 1, error: '' })
      var status = statusHolder[0]
      var setStatus = statusHolder[1]
      var factorHolder = react.useState(1)
      var factor = factorHolder[0]
      var setFactor = factorHolder[1]

      var scrollRef = react.useRef(null)
      var pagesRef = react.useRef(null)
      var panelRef = react.useRef({ doc: null, baseSize: null, factor: 1, slots: [], observer: null, rebuild: null, disposed: false })

      // 文件字节到位后：加载 pdf.js、打开文档、建页面
      react.useEffect(function () {
        if (!bytes) return
        var host = scrollRef.current
        var pagesEl = pagesRef.current
        if (!host || !pagesEl) return
        ensureStyle()
        var panel = panelRef.current
        panel.disposed = false
        panel.slots = []
        setStatus({ phase: 'loading', pages: 0, scale: 1, error: '' })

        /** 适宽比例。 */
        function fitScale() {
          if (!panel.baseSize) return 1
          var avail = host.clientWidth - 28
          if (avail <= 0) avail = 600
          return Math.max(0.2, Math.min(6, avail / panel.baseSize.width))
        }

        /** 渲染一页到 canvas。 */
        function renderPage(slot) {
          if (!slot || slot.getAttribute('data-state')) return
          var doc = panel.doc
          if (!doc) return
          var n = Number(slot.getAttribute('data-page'))
          slot.setAttribute('data-state', 'rendering')
          var scale = fitScale() * panel.factor
          var dpr = Math.min(window.devicePixelRatio || 1, 2)
          doc.getPage(n).then(function (page) {
            if (panel.disposed || slot.getAttribute('data-state') !== 'rendering') return null
            var vp = page.getViewport({ scale: scale })
            var canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.floor(vp.width * dpr))
            canvas.height = Math.max(1, Math.floor(vp.height * dpr))
            canvas.style.width = Math.round(vp.width) + 'px'
            canvas.style.height = 'auto'
            var ctx = canvas.getContext('2d', { alpha: false })
            if (!ctx) throw new Error('canvas 2d 上下文不可用')
            slot.style.width = Math.round(vp.width) + 'px'
            slot.style.height = Math.round(vp.height) + 'px'
            var params = { canvasContext: ctx, viewport: vp, canvas: canvas }
            if (dpr !== 1) params.transform = [dpr, 0, 0, dpr, 0, 0]
            return page.render(params).promise.then(function () {
              var ph = slot.querySelector('.' + PH_CLASS)
              if (ph) ph.remove()
              slot.appendChild(canvas)
              slot.setAttribute('data-state', 'done')
              return null
            })
          }).catch(function (error) {
            slot.setAttribute('data-state', 'error')
            var ph = slot.querySelector('.' + PH_CLASS)
            if (ph) ph.remove()
            if (!slot.querySelector('.' + ERR_CLASS)) {
              var err = document.createElement('div')
              err.className = ERR_CLASS
              err.textContent = '第 ' + n + ' 页渲染失败：' + errText(error)
              slot.appendChild(err)
            }
            report('error', '第 ' + n + ' 页渲染失败：' + errText(error))
          })
        }

        /** 按当前宽度与缩放重建页面骨架。 */
        function rebuild() {
          var doc = panel.doc
          if (!doc || !panel.baseSize) return
          if (panel.observer) { try { panel.observer.disconnect() } catch (error) {} panel.observer = null }
          var previousRatio = 0
          try {
            if (host.scrollHeight > 0) previousRatio = host.scrollTop / host.scrollHeight
          } catch (error) { previousRatio = 0 }

          pagesEl.textContent = ''
          panel.slots = []

          var scale = fitScale() * panel.factor
          var vw = Math.round(panel.baseSize.width * scale)
          var vh = Math.round(panel.baseSize.height * scale)

          var observer = null
          try {
            observer = new IntersectionObserver(function (entries) {
              for (var i = 0; i < entries.length; i++) {
                if (entries[i].isIntersecting) renderPage(entries[i].target)
              }
            }, { root: host, rootMargin: PRELOAD_MARGIN, threshold: 0.01 })
          } catch (error) { observer = null }
          panel.observer = observer

          for (var n = 1; n <= doc.numPages; n++) {
            var slot = document.createElement('div')
            slot.className = SLOT_CLASS
            slot.setAttribute('data-page', String(n))
            slot.style.width = vw + 'px'
            slot.style.height = vh + 'px'
            var ph = document.createElement('div')
            ph.className = PH_CLASS
            ph.textContent = '第 ' + n + ' 页'
            slot.appendChild(ph)
            pagesEl.appendChild(slot)
            panel.slots.push(slot)
            if (observer) observer.observe(slot)
            else renderPage(slot)
          }

          if (previousRatio > 0) {
            setTimeout(function () {
              try { host.scrollTop = Math.round(host.scrollHeight * previousRatio) } catch (error) {}
            }, 30)
          }
          setStatus({ phase: 'ready', pages: doc.numPages, scale: Math.round(scale * 100), error: '' })
        }
        panel.rebuild = rebuild

        loadPdfLib()
          .then(function (lib) {
            var base = appUrl(VENDOR)
            return lib.getDocument({
              data: bytes,
              standardFontDataUrl: base + '/standard_fonts/',
              isEvalSupported: false,
            }).promise
          })
          .then(function (doc) {
            if (panel.disposed) { try { doc.destroy() } catch (error) {} return null }
            panel.doc = doc
            return doc.getPage(1).then(function (page) {
              if (panel.disposed) return null
              var vp = page.getViewport({ scale: 1 })
              panel.baseSize = { width: vp.width, height: vp.height }
              rebuild()
              report('info', 'PDF 就绪：' + doc.numPages + ' 页')
              return null
            })
          })
          .catch(function (error) {
            if (panel.disposed) return
            setStatus({ phase: 'failed', pages: 0, scale: 0, error: errText(error) })
            report('error', 'PDF 打开失败：' + errText(error))
          })

        // 容器宽度变化 → 重排（节流）
        var resizeTimer = null
        var resizeObserver = null
        try {
          resizeObserver = new ResizeObserver(function () {
            if (resizeTimer !== null) clearTimeout(resizeTimer)
            resizeTimer = setTimeout(function () {
              resizeTimer = null
              if (!panel.disposed && panel.doc) rebuild()
            }, 180)
          })
          resizeObserver.observe(host)
        } catch (error) { /* 忽略 */ }

        return function () {
          panel.disposed = true
          panel.rebuild = null
          if (resizeTimer !== null) clearTimeout(resizeTimer)
          if (resizeObserver) { try { resizeObserver.disconnect() } catch (error) {} }
          if (panel.observer) { try { panel.observer.disconnect() } catch (error) {} panel.observer = null }
          if (panel.doc) { try { panel.doc.destroy() } catch (error) {} panel.doc = null }
          panel.baseSize = null
          panel.slots = []
        }
      }, [bytes])

      // 缩放倍率变化：重建
      react.useEffect(function () {
        var panel = panelRef.current
        panel.factor = factor
        if (panel.doc && panel.rebuild) panel.rebuild()
      }, [factor])

      function stepFactor(direction) {
        var index = FACTORS.indexOf(factor)
        if (index < 0) index = FACTORS.indexOf(1)
        var next = Math.min(FACTORS.length - 1, Math.max(0, index + direction))
        setFactor(FACTORS[next])
      }

      function openExternal() {
        var ctx = props.__ctx
        var controller = new AbortController()
        resolveAbsPath(ctx, address, controller.signal)
          .then(function (absPath) { return rpc('external', { absPath: absPath }) })
          .then(function (result) {
            if (!result || result.ok !== true) throw new Error((result && result.error) || '打开失败')
          })
          .catch(function (error) { report('error', '外部打开失败：' + errText(error)) })
      }

      var toolbar = h('div', { style: CSS.bar },
        h('div', { style: CSS.barName, title: name }, name || 'PDF'),
        status.phase === 'ready' ? h('div', { style: CSS.meta }, String(status.pages) + ' 页 · ' + String(status.scale) + '%') : null,
        h('button', { key: 'out', style: CSS.button, onClick: function () { stepFactor(-1) }, title: '缩小' }, '−'),
        h('button', { key: 'in', style: CSS.button, onClick: function () { stepFactor(1) }, title: '放大' }, '+'),
        h('button', { key: 'reset', style: CSS.button, onClick: function () { setFactor(1) }, title: '适应宽度' }, '适宽'),
        h('button', { key: 'ext', style: CSS.button, onClick: openExternal, title: '交给系统默认 PDF 阅读器' }, '系统阅读器')
      )

      var body
      if (status.phase === 'failed') {
        body = h('div', { style: CSS.status },
          h('div', null, '这份 PDF 没能渲染。'),
          h('div', { style: CSS.bad }, status.error),
          h('div', null, h('button', { style: CSS.button, onClick: openExternal }, '用系统阅读器打开'))
        )
      } else if (!bytes) {
        body = h('div', { style: CSS.status }, h('div', null, '正在读取文件…'))
      } else {
        body = h('div', { style: CSS.scroll, ref: scrollRef },
          h('div', { style: CSS.pages, ref: pagesRef })
        )
      }

      return h('div', { style: CSS.root, 'data-fastpdf': status.phase }, toolbar, body)
    }

    // --region 注册

    /**
     * 注册 PDF 文档预览（优先级高于内置 pdf.js 实现）。
     * @param ctx 客户端上下文
     * @param previews documentPreviews 注册表
     * @returns 是否注册成功
     */
    function installPreview(ctx, previews) {
      if (!previews || typeof previews.register !== 'function') return false
      var slots = null
      try { slots = ctx.slots } catch (error) { slots = null }
      if (!slots || typeof slots.register !== 'function') {
        try { slots = ctx.get ? ctx.get('slots') : null } catch (error) { slots = null }
      }
      if (!slots || typeof slots.register !== 'function') {
        report('warn', 'slots 服务不可用，PDF 加速未注册')
        return false
      }

      var definition = {
        id: BODY_ID,
        extensions: ['pdf'],
        binaryExtensions: ['pdf'],
        // 内置 PDF 是 "builtin"（rank 0）；其它取值排在它前面 → 我们接管 .pdf
        priority: 'extension',
        title: function () { return 'PDF（加速）' },
        // 字节由 DSH 通过 workspaceFiles 一次读完直接给正文（不用 renderer 模式的 store 契约）
        loading: 'bytes-complete',
        wrap: false,
      }

      try {
        ctx.effect(function () { return previews.register(definition) })
      } catch (error) {
        report('error', '注册 PDF 预览失败：' + errText(error))
        return false
      }

      var Body = function (props) {
        return react.createElement(FastPdfBody, Object.assign({}, props, { __ctx: ctx }))
      }

      try {
        ctx.effect(function () {
          return slots.inject('sidebar.right.tab.document', function () {
            return slots.register({ name: 'sidebar.right.tab.document', key: BODY_ID }, Body)
          })
        })
      } catch (error) {
        report('error', '注册 PDF 正文 slot 失败：' + errText(error))
        return false
      }
      return true
    }

    exports.apply = function (ctx) {
      if (!react || typeof react.createElement !== 'function') {
        report('error', '模块表未提供 react，PDF 加速未注册')
        return
      }

      var installed = false
      var attempts = 0

      function attempt(scope) {
        if (installed) return true
        attempts++
        var previews = null
        try { previews = scope.documentPreviews } catch (error) { previews = null }
        if (!previews || typeof previews.register !== 'function') {
          try { previews = scope.reflect && scope.reflect.get ? scope.reflect.get('documentPreviews') : null } catch (error) { previews = null }
        }
        if (!previews || typeof previews.register !== 'function') {
          try { previews = scope.get ? scope.get('documentPreviews') : null } catch (error) { previews = null }
        }
        if (!previews || typeof previews.register !== 'function') {
          if (attempts % 8 === 1) report('info', '第 ' + attempts + ' 次尝试：documentPreviews 尚未就绪')
          return false
        }
        try {
          installed = installPreview(scope, previews)
        } catch (error) {
          report('error', '注册流程异常：' + errText(error))
          return false
        }
        if (installed) report('info', 'client v' + VERSION + ' 已接管 PDF 预览（第 ' + attempts + ' 次尝试）')
        return installed
      }

      try {
        ctx.inject(['documentPreviews'], function (scope) { attempt(scope) })
      } catch (error) {
        report('warn', 'ctx.inject 不可用：' + errText(error))
      }

      var tries = 0
      var timer = setInterval(function () {
        tries++
        if (installed || tries > 60) {
          clearInterval(timer)
          if (!installed) report('error', '放弃注册：documentPreviews 始终不可用（已试 ' + attempts + ' 次）')
          return
        }
        attempt(ctx)
      }, 250)
    }

    return exports
  },
})
