import { mountPhotoWall } from './photo-wall.js?v=20261102-series-order';
import { mountNotebook } from './notebook.js?v=20261105-note-linebreaks';
import { setProgressiveImage } from './progressive-image.js?v=20261101-progressive';
import { mountPhotoViewer } from './photo-viewer.js?v=20261101-album';

const galleryData = JSON.parse(document.querySelector('#gallery-data').textContent);
const visitCount = document.querySelector('#today-visit-count');
if (visitCount) {
  const visitUrl = `/api/visits/${encodeURIComponent(galleryData.publicId)}`;
  let visitRequest;
  async function recordVisibleVisit() {
    if (document.hidden) {
      document.addEventListener('visibilitychange', recordVisibleVisit);
      return;
    }
    document.removeEventListener('visibilitychange', recordVisibleVisit);
    visitRequest?.abort();
    visitRequest = new AbortController();
    const { signal } = visitRequest;
    visitCount.textContent = '正在读取…';
    visitCount.classList.remove('is-ready');
    try {
      const sendVisit = () => fetch(visitUrl, { method: 'POST', signal, keepalive: true });
      // First visits from different tabs share the cookie issued by the first request.
      const response = await (navigator.locks ? navigator.locks.request('portfolio-visit', { signal }, sendVisit) : sendVisit());
      if (!response.ok) throw new Error('Unable to read visit count.');
      const { today } = await response.json();
      if (!Number.isSafeInteger(today) || today < 0) throw new Error('Invalid visit count.');
      if (signal.aborted) return;
      visitCount.textContent = today.toLocaleString('zh-CN');
      visitCount.classList.add('is-ready');
    } catch {
      if (!signal.aborted) visitCount.textContent = '暂不可用';
    }
  }
  void recordVisibleVisit();
  window.addEventListener('pageshow', event => {
    if (event.persisted) void recordVisibleVisit();
  });
}
const compactIdentity = document.querySelector('.portfolio-sticky-identity');
if (compactIdentity) {
  const header = document.querySelector('.site-header');
  const portfolioLayout = compactIdentity.closest('.portfolio-with-sidebar');
  const hero = document.querySelector('.profile-hero');
  const desktop = matchMedia('(min-width: 1024px)');
  let observer;

  function observeProfile() {
    observer?.disconnect();
    if (!desktop.matches) {
      compactIdentity.hidden = true;
      return;
    }
    const headerHeight = header.getBoundingClientRect().height;
    portfolioLayout.style.setProperty('--portfolio-header-height', `${headerHeight}px`);
    observer = new IntersectionObserver(([entry], source) => {
      if (source === observer && desktop.matches) {
        compactIdentity.hidden = entry.isIntersecting || entry.boundingClientRect.bottom >= headerHeight;
      }
    }, { rootMargin: `-${headerHeight}px 0px 0px 0px` });
    observer.observe(hero);
  }

  desktop.addEventListener('change', observeProfile);
  new ResizeObserver(observeProfile).observe(header);
}
mountNotebook(document.querySelector('#notebook'), galleryData.notes);
const photos = galleryData.photos;
const showPhotoNames = galleryData.showPhotoNames;

const openPhoto = mountPhotoViewer(galleryData);
const creditsDialog = document.querySelector('#credits-dialog');

for (const image of document.querySelectorAll('.hero img, #lightbox-image')) image.draggable = false;
for (const image of document.querySelectorAll('.hero img[data-full-src]')) {
  setProgressiveImage(image, image.dataset.fullSrc, image.getAttribute('src'), { priority: 1 });
}
for (const type of ['contextmenu', 'dragstart']) {
  document.addEventListener(type, event => {
    if (event.target.closest('.hero img, .wall-photo, #lightbox-image')) event.preventDefault();
  });
}
for (const series of galleryData.series) {
  const seriesPhotos = photos.filter(photo => photo.series === series.id);
  const gallery = document.getElementById(`${series.id}-gallery`);
  document.getElementById(`${series.id}-count`).textContent = `${String(seriesPhotos.length).padStart(2, '0')} 张影像`;
  mountPhotoWall(gallery, seriesPhotos.filter(photo => photo.showOnWall), openPhoto, {
    showPhotoNames, albumHref: `${galleryData.publicId ? `/${encodeURIComponent(galleryData.publicId)}/album` : '/album'}?series=${encodeURIComponent(series.id)}`,
  });
}

document.querySelector('#credits-button').hidden = !photos.some(photo => photo.isSample);
document.querySelector('#credits-button').addEventListener('click', () => creditsDialog.showModal());
document.querySelector('#close-credits').addEventListener('click', () => creditsDialog.close());
creditsDialog.addEventListener('click', event => { if (event.target === creditsDialog) creditsDialog.close(); });
const creditsList = document.querySelector('#credits-list');
for (const photo of photos.filter(photo => photo.isSample)) {
  const item = document.createElement('div');
  item.className = 'credit-item';
  const link = document.createElement('a');
  link.textContent = `${photo.title} / ${photo.photographer}`;
  link.href = photo.source;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const license = document.createElement('a');
  license.textContent = photo.license;
  license.href = photo.licenseUrl;
  license.target = '_blank';
  license.rel = 'noopener noreferrer';
  item.append(link, license);
  creditsList.append(item);
}
