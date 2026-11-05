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
const header = document.querySelector('.site-header');
const navigation = document.querySelector('#portfolio-navigation');
const navigationToggle = document.querySelector('.mobile-navigation-toggle');
const navigationLinks = [...navigation.querySelectorAll('a[href^="#"]')];
const mobileNavigation = matchMedia('(max-width: 1023px)');
navigationToggle.hidden = navigationLinks.length === 0;

function setNavigationOpen(open) {
  navigationToggle.setAttribute('aria-expanded', String(open));
  header.classList.toggle('is-navigation-open', open);
}

function updateNavigationSelection() {
  for (const link of navigationLinks) {
    if (location.hash && link.hash === location.hash) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

navigationToggle.addEventListener('click', () => {
  setNavigationOpen(navigationToggle.getAttribute('aria-expanded') !== 'true');
});
header.addEventListener('click', event => {
  if (!event.target.closest('a[href^="#"]')) return;
  setNavigationOpen(false);
  if (mobileNavigation.matches) navigationToggle.focus({ preventScroll: true });
});
document.addEventListener('click', event => {
  if (!header.contains(event.target)) setNavigationOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navigationToggle.getAttribute('aria-expanded') === 'true') {
    setNavigationOpen(false);
    navigationToggle.focus({ preventScroll: true });
  }
});
mobileNavigation.addEventListener('change', () => setNavigationOpen(false));
window.addEventListener('pagehide', () => setNavigationOpen(false));
window.addEventListener('hashchange', updateNavigationSelection);
updateNavigationSelection();

const compactIdentity = document.querySelector('.portfolio-sticky-identity');
const hero = document.querySelector('.profile-hero');
const desktop = matchMedia('(min-width: 1024px)');
let profileObserver;

function updateHeaderLayout() {
  const headerHeight = header.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--portfolio-header-height', `${headerHeight}px`);
  profileObserver?.disconnect();
  if (!compactIdentity) return;
  if (!desktop.matches) {
    compactIdentity.hidden = true;
    return;
  }
  profileObserver = new IntersectionObserver(([entry], source) => {
    if (source === profileObserver && desktop.matches) {
      compactIdentity.hidden = entry.isIntersecting || entry.boundingClientRect.bottom >= headerHeight;
    }
  }, { rootMargin: `-${headerHeight}px 0px 0px 0px` });
  profileObserver.observe(hero);
}

desktop.addEventListener('change', updateHeaderLayout);
new ResizeObserver(updateHeaderLayout).observe(header);
updateHeaderLayout();
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
