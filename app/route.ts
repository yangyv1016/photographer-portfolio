import { portfolioHtml } from "./portfolio-html";
import { getGalleryPhotos } from "../db/gallery";
import { getSeries } from "../db/series";

export const dynamic = "force-dynamic";

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export type PortfolioProfile = {
  publicId?: string; name: string; siteName: string; avatarUrl: string; coverUrl: string; bio: string;
  introduction: string; region: string; showPhotoNames: boolean;
  notes: { id: string; title: string; content: string; createdAt: string; updatedAt: string; isPinned: boolean; sortOrder: number }[];
};

export async function renderPortfolio(profile?: PortfolioProfile) {
  let gallery;
  let status = 200;
  try {
    const [photos, series] = await Promise.all([getGalleryPhotos(), getSeries()]);
    gallery = { photos, series, error: null };
  } catch (error) {
    console.error("Unable to render portfolio", error);
    gallery = { photos: [], series: [], error: "照片暂时无法加载，请稍后刷新重试。" };
    status = 503;
  }
  const navigation = gallery.series.map((series, index) => `<a href="#${escapeHtml(series.id)}"><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(series.name)}</a>`).join("");
  const sections = gallery.series.map((series, index) => {
    const subtitle = series.id === "scene" && series.name === "场照" ? "ON SCENE" : series.id === "editorial" && series.name === "正片" ? "IN CHARACTER" : "PHOTO SERIES";
    return `<section class="collection ${index % 2 ? "editorial" : "scene"}-collection" id="${escapeHtml(series.id)}" aria-labelledby="${escapeHtml(series.id)}-title">
      <div class="collection-heading"><div class="collection-title"><span class="series-number">${String(index + 1).padStart(2, "0")}</span><h2 id="${escapeHtml(series.id)}-title">${escapeHtml(series.name)}<span>${subtitle}</span></h2></div><span class="work-count" id="${escapeHtml(series.id)}-count"></span></div>
      <div class="series-wall photo-wall" id="${escapeHtml(series.id)}-gallery"><div class="wall-controls"><button type="button" class="wall-toggle" aria-label="暂停滚动" aria-pressed="false">暂停</button></div><div class="wall-stage"><div class="wall-lanes"></div><button type="button" class="wall-edge wall-edge-back" data-direction="-1" aria-label="向后快速浏览照片"><span aria-hidden="true">‹</span></button><button type="button" class="wall-edge wall-edge-forward" data-direction="1" aria-label="向前快速浏览照片"><span aria-hidden="true">›</span></button></div></div>
    </section>`;
  }).join("");
  const occupied = new Set(gallery.photos.map(photo => photo.series));
  const covers = [...gallery.series.filter(series => occupied.has(series.id)), ...gallery.series.filter(series => !occupied.has(series.id))].slice(0, 2)
    .map(series => ({ ...series, photo: gallery.photos.find(photo => photo.series === series.id), number: String(gallery.series.findIndex(item => item.id === series.id) + 1).padStart(2, "0") }));
  const [main, side] = covers;
  const seriesHero = `<div class="hero-photos${side ? "" : " single"}">
    <a class="hero-main${main?.photo ? "" : " is-empty"}" href="#${main ? escapeHtml(main.id) : "collections"}">${main?.photo ? `<img src="${escapeHtml(main.photo.thumbnailSrc)}" data-full-src="${escapeHtml(main.photo.src)}" alt="${escapeHtml(main.photo.alt)}" fetchpriority="high" width="1400" height="940">` : ""}<span class="hero-caption"><span>${main ? `${main.number} / ${escapeHtml(main.name)}` : "摄影作品"}</span><span>IN THE MOMENT</span></span></a>
    ${side ? `<div class="hero-side"><span class="vertical-label" aria-hidden="true">A DIFFERENT KIND OF REALITY</span><a${side.photo ? "" : ' class="is-empty"'} href="#${escapeHtml(side.id)}">${side.photo ? `<img src="${escapeHtml(side.photo.thumbnailSrc)}" data-full-src="${escapeHtml(side.photo.src)}" alt="${escapeHtml(side.photo.alt)}" width="640" height="860">` : ""}<span class="side-caption">${side.number} / ${escapeHtml(side.name)}</span></a><span class="edition-label">旸隅 · 影像档案</span></div>` : ""}
    <span class="photo-sticker" aria-hidden="true">COSPLAY<br>PHOTO<br>JOURNAL</span>
  </div>`;
  const profileContent = profile ? `<div class="profile-identity">${profile.avatarUrl ? `<img class="profile-cover-avatar" src="${escapeHtml(profile.avatarUrl)}" alt="${escapeHtml(profile.name)}的头像">` : ''}<div class="profile-heading"><h1 id="site-title">${escapeHtml(profile.name)}</h1>${profile.bio ? `<p class="profile-signature">${escapeHtml(profile.bio)}</p>` : ''}${profile.region ? `<p class="profile-region"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><span>${escapeHtml(profile.region)}</span></p>` : ''}</div></div>${profile.introduction ? `<p class="profile-introduction">${escapeHtml(profile.introduction)}</p>` : ''}` : '';
  const hero = profile
    ? (profile.coverUrl ? `<div class="profile-cover"><img src="${escapeHtml(profile.coverUrl)}?preview=1" data-full-src="${escapeHtml(profile.coverUrl)}" alt="${escapeHtml(profile.name)}的主页封面" width="1920" height="1080" fetchpriority="high"><div class="profile-cover-content">${profileContent}</div></div>` : `<div class="profile-details">${profileContent}</div>`)
    : `<div class="hero-heading"><div><p class="eyebrow">摄影作品集 / PHOTO JOURNAL</p><h1 id="site-title">旸隅<span class="title-dot">.</span></h1></div></div>${seriesHero}<div class="hero-foot"><span>现场的瞬间，角色的另一面。</span><a href="#collections">浏览作品 <span aria-hidden="true">＋</span></a></div>`;
  const notes = profile?.notes ?? [];
  const data = JSON.stringify({ ...gallery, publicId: profile?.publicId ?? "", showPhotoNames: profile?.showPhotoNames ?? false, notes }).replace(/</g, "\\u003c");
  const notebook = notes.length ? `<section class="notebook collection" id="notebook" aria-labelledby="notebook-title"><div class="collection-heading"><div class="collection-title"><h2 id="notebook-title">便签本<span>NOTES</span></h2></div><button type="button" class="notebook-toggle" aria-pressed="false" hidden>暂停滚动</button></div><div class="notebook-viewport" tabindex="0" role="region" aria-label="便签，可横向浏览"><div class="notebook-track"><div class="notebook-group">${notes.map((note, index) => `<button type="button" class="notebook-card${note.isPinned ? ' is-pinned' : ''}" data-note-id="${escapeHtml(note.id)}"><span class="notebook-card-meta"><span class="notebook-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>${note.isPinned ? '<span class="notebook-pin">置顶</span>' : ''}</span><span class="notebook-card-title">${escapeHtml(note.title)}</span><span class="notebook-open">打开查看具体内容 <span aria-hidden="true">＋</span></span></button>`).join("")}</div></div></div></section>` : "";
  const html = portfolioHtml.replaceAll("旸隅", escapeHtml(profile?.siteName ?? "旸隅"))
    .replace('<section class="hero"', `<section class="hero${profile ? ' profile-hero' : ''}"`)
    .replace("<!--portfolio-hero-->", hero)
    .replace("<p>场照 / 正片</p>", `<p>${gallery.series.map(series => escapeHtml(series.name)).join(" / ")}</p>`)
    .replace("<!--series-nav-->", navigation)
    .replace("<!--header-action-->", profile ? '<a class="directory-entry" href="/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>浏览摄影师</a>' : '<span class="header-note">COSPLAY PHOTOGRAPHY</span>')
    .replace("<!--notebook-nav-->", notes.length ? '<a href="#notebook">便签本</a>' : "")
    .replace("<!--series-collections-->", gallery.error ? `<p class="gallery-empty portfolio-error">${escapeHtml(gallery.error)} <a href="/">重新加载</a></p>` : sections)
    .replace("<!--portfolio-notes-->", notebook)
    .replace("</head>", `<script id="gallery-data" type="application/json">${data}</script></head>`);
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET() { return renderPortfolio(); }
