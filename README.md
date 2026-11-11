# dsh-fastpdf

把 DSH 侧边栏的 PDF 预览换成一套轻量 pdf.js 渲染器，解决内置预览「打开一份 PDF 要等好几秒」的问题。

装了这个之后，首屏 **200–400 ms**（本机 i7 + SSD 实测，2 页 A4 论文），滚动翻页基本即时；
内置实现同一份文件通常要等数秒，长文档更明显。

## 它解决什么

DSH 内置的 PDF 预览（`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 里的 `client.pdf.js`）
在打开一份 PDF 时要付这些代价：

| 代价 | 出处 |
|---|---|
| 懒加载 **7.1 MB** chunk（1.29 MB 内联 worker 源码 + 4.57 MB base64 CMap/字体 + 1.19 MB 全量 pdf_viewer） | `lib/client.pdf.js` |
| 每次打开都新建 module Worker，把 1.29 MB worker 源码拼成 Blob 让新线程重编译一遍 | `pdf/runtime.js` `openPdf` |
| 首屏必然双渲染：宽度未知时 `zoom=1` 全分辨率渲一遍，量到宽度后 fit-width 再渲一遍 | `fitWidthZoom` 返回 1 |
| 每页渲染完立刻 `page.cleanup()`，回滚/缩放要重新解析 | `renderPdfPage` |
| 所有页都实例化 React 组件 + 每页一个 IntersectionObserver | `PdfBody` |
| 离屏 canvas → `drawImage` 到可见 canvas，多一次全画布拷贝；文本层每页上千 span | `PdfBody` |

本插件接管 `.pdf` 的文档预览，逐条避开：

| | 内置 | 本插件 |
|---|---|---|
| 加载体积 | 7.1 MB chunk（含 4.57 MB base64 CMap） | 798 KB `pdf.mjs` |
| worker | 每次内联字符串重编译 | 独立 `pdf.worker.mjs`，走 HTTP 缓存，进程内只编译一次 |
| 文本层 | 每页上千 span | 不做 |
| `page.cleanup()` | 每页渲完就清 | 不清 |
| 首帧 | 先按 `zoom=1` 全分辨率渲一遍再重渲 | 直接按适宽渲 |
| 渲染时机 | 所有页都建组件 | IntersectionObserver + 320 px 预取，滚到哪渲到哪 |
| 缩放 | 每次改 scale 全部重渲 | 只重建骨架，进视口才渲 |

## 怎么做到的

关键绕开一个坑：DSH 的 `loading: "renderer"` 模式要求实现方自己维护 `prepareRenderer` / `version`
那套 store 状态机，光注册 slot 不写 store 的话 slot 根本不会挂载。
这里改用 `loading: "bytes-complete"`（DSH 通过 `workspaceFiles.readBytes` 一次读完直接把字节给正文），
正文拿到 `Uint8Array` 后交给 pdf.js。

前端每次打开只做：**读字节 → getDocument → 画视口内的页**，没有第二次全量渲染，也没有 Worker 重建。

## 结构

```
lib/index.js            宿主半：注册 /dmzpdf/rpc（外部阅读器、状态）、
                        /dmzpdf/vendor（serve 随包 pdf.js）、/dmzpdf/log
lib/client.js           客户端半：注册 PDF 文档预览、pdf.js 加载、页面懒渲染、缩放
lib/render-server.ps1   备用方案（宿主用 Windows.Data.Pdf 光栅化成图片流），未启用
vendor/pdfjs/           随包 pdf.js（build/pdf.mjs + pdf.worker.mjs + standard_fonts）
```

路由：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/dmzpdf/vendor/pdfjs/...` | GET | pdf.js 与字体资源 |
| `/dmzpdf/rpc` | POST | `ping` / `status` / `external`（用系统阅读器打开） |
| `/dmzpdf/log` | POST | 客户端诊断上报 → `~/.dsh/dsh-fastpdf/client.log` |

## 安装

插件以 `link:` 方式挂在 profile 里，源码目录即生效目录。

```bash
# 1. 放到 profile 的插件目录
git clone https://github.com/LeFantas/dsh-fastpdf.git \
  ~/.dsh/profiles/desktop/.local-plugins/dsh-fastpdf
```

```jsonc
// 2. 编辑 ~/.dsh/profiles/desktop/package.json（先关闭 DSH），两处都要写
{
  "dependencies": {
    "dsh-fastpdf": "link:./.local-plugins/dsh-fastpdf"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* …原有条目… */ "dsh-fastpdf" ]
    }
  }
}
```

```bash
# 3. 在 profile 目录里建链接并安装
cd ~/.dsh/profiles/desktop
pnpm install
```

4. 启动 DSH。`~/.dsh/dsh-fastpdf/client.log` 出现
   `client v1.0.0 已接管 PDF 预览` 即成功。

> - 只在 `dependencies` 不在 `bundles` = 装了但不加载
> - 改清单前**必须关闭 DSH**，否则 pnpm 会因文件被占用而失败
> - Windows 上如果 pnpm 没建链接，可手动 `mklink /J node_modules\dsh-fastpdf .local-plugins\dsh-fastpdf`

## 回退

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加：

```yaml
- id: dsh-fastpdf
  disabled: true
```

重启即回到内置 pdf.js 预览。插件留在磁盘上不影响任何东西。

## 已知取舍

- **不做文本层**：页面不能选中文字、不能 Ctrl+F。需要时点工具条右侧的「系统阅读器」，
  用本地路径交给默认 PDF 程序（Edge / Acrobat / SumatraPDF），功能完整。
- 单文件上限沿用 DSH 的 `workspaceFiles.maxFileBytes`（默认 32 MB），超过会直接报错。
- 所有页用第 1 页的尺寸做占位，混排尺寸的文档（个别页横排）滚动时会有轻微跳动。

## 调参

| 位置 | 常量 | 作用 |
|---|---|---|
| `lib/client.js` | `FACTORS` | 缩放档位 |
| `lib/client.js` | `PRELOAD_MARGIN` | 预取距离（默认 `320px`） |
| `lib/client.js` | `Math.min(devicePixelRatio, 2)` | 渲染倍率上限 |
| `lib/index.js` | `VENDOR_PATH` | pdf.js 资源路由 |

## 附：备用方案

`lib/render-server.ps1` 是一条更彻底的路线：宿主常驻 `powershell.exe`，用 Windows 自带的
`Windows.Data.Pdf`（PDFium 内核）把页渲染成 PNG，前端只显示 `<img>`。

那条路实测更快（首页 113 ms、次页 43 ms、缓存命中 1 ms），但有两个限制：
页面不能选中文字，且只支持 Windows。目前代码保留、路由未启用，作为后续选项。

## License

MIT
