import { albumHtml } from "./album-html";
import { getGalleryPhotos } from "../db/gallery";
import { getSeries } from "../db/series";
import type { PortfolioProfile } from "./route";

export async function renderAlbum(
  profile?: Pick<PortfolioProfile, "name" | "siteName" | "publicId" | "showPhotoNames">,
  { selectedSeriesId = "", workspace = false } = {},
) {
  let photos;
  let series;
  try {
    [photos, series] = await Promise.all([getGalleryPhotos(), getSeries()]);
  } catch (error) {
    console.error("Unable to render album", error);
    return new Response("照片暂时无法加载，请稍后刷新重试。", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!selectedSeriesId) selectedSeriesId = series[0]?.id ?? "";
  const selectedSeries = series.find(item => item.id === selectedSeriesId);
  if (selectedSeriesId && !selectedSeries) return new Response("所选系列不存在。", { status: 404 });
  const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const publicId = profile?.publicId ?? "";
  const portfolioUrl = publicId ? `/${encodeURIComponent(publicId)}` : "/";
  const albumUrl = workspace ? "/dashboard/album" : publicId ? `${portfolioUrl}/album` : "/album";
  const heading = workspace ? "相册预览与排序" : selectedSeries?.name ?? "相册";
  const navigation = series.map(item => {
    const count = photos.filter(photo => photo.series === item.id).length;
    const href = `${albumUrl}?series=${encodeURIComponent(item.id)}`;
    return `<a href="${escapeHtml(href)}"${item.id === selectedSeriesId ? ' aria-current="page"' : ""}>${escapeHtml(item.name)}<span>${count}</span></a>`;
  }).join("");
  const controls = workspace ? `<div class="album-arrange-controls" id="album-arrange-controls"><button type="button" id="arrange-album">调整顺序</button><button type="button" id="reverse-album-order" hidden>反转顺序</button><button type="button" id="reset-album-order" hidden>还原调整</button><button type="button" id="save-album-order" hidden>保存顺序</button><button type="button" id="cancel-album-order" hidden>取消</button></div>` : "";
  const moveControls = workspace ? `<section class="album-order-tools" id="album-order-tools" aria-label="照片位置操作" hidden><p id="album-selection-label" class="album-selection-label" aria-live="polite"></p><div class="album-order-moves"><button type="button" data-album-move="first">置顶</button><button type="button" data-album-move="previous">前移</button><button type="button" data-album-move="next">后移</button><button type="button" data-album-move="last">置底</button></div><form id="album-move-to" class="album-move-to"><label for="album-move-position">移至第</label><input id="album-move-position" type="number" min="1" step="1" required aria-label="目标位置"><span>位</span><button type="submit">移动</button></form></section>` : "";
  const data = JSON.stringify({ photos, series, showPhotoNames: profile?.showPhotoNames ?? false, publicId, selectedSeriesId, canArrange: workspace }).replace(/</g, "\\u003c");
  const html = albumHtml.replace("<!--album-title-->", escapeHtml(`${heading} · ${profile?.siteName ?? "旸隅"}`))
    .replace("<!--album-author-->", escapeHtml(`${workspace ? "工作台 / " : ""}${profile?.name ?? "旸隅"}`))
    .replace("<!--album-heading-->", escapeHtml(heading))
    .replace("<!--portfolio-url-->", escapeHtml(workspace ? "/dashboard" : portfolioUrl))
    .replace("<!--album-back-label-->", workspace ? "返回作品管理" : "返回主页")
    .replace("<!--album-navigation-->", navigation)
    .replace("<!--album-controls-->", controls)
    .replace("<!--album-move-controls-->", moveControls)
    .replace("</head>", `<script id="album-data" type="application/json">${data}</script></head>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
}
