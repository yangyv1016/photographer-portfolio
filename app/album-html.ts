import { photoViewerHtml } from "./photo-viewer-html";

export const albumHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#ffffff"><title><!--album-title--></title><link rel="stylesheet" href="/styles.css?v=20261101-album"><link rel="stylesheet" href="/album.css?v=20261102-album-actions"><script type="module" src="/album.js?v=20261102-album-actions"></script></head>
<body class="album-page"><header class="album-header"><div><p class="album-eyebrow"><!--album-author--></p><h1><!--album-heading--></h1><p class="album-summary"><span id="album-count"></span> 张照片</p></div><a class="album-back" href="<!--portfolio-url-->"><!--album-back-label--> <span aria-hidden="true">↗</span></a></header>
<main class="album-main"><nav class="album-series" aria-label="相册系列"><!--album-navigation--></nav><div class="album-toolbar"><!--album-controls--></div><p class="album-feedback" id="album-feedback" role="status" hidden></p><p class="album-sort-help" id="album-sort-help" hidden></p><div class="album-grid" id="album-grid" aria-label="照片相册"></div><p class="album-empty" id="album-empty" hidden>这个相册还没有照片。</p><!--album-move-controls--></main>
<!--photo-viewer-->
</body></html>`.replace("<!--photo-viewer-->", photoViewerHtml);
