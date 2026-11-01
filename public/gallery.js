import { mountPhotoWall } from './photo-wall.js?v=20261101-album';
import { mountNotebook } from './notebook.js?v=20261101-markdown';
import { setProgressiveImage } from './progressive-image.js?v=20261101-progressive';
import { mountPhotoViewer } from './photo-viewer.js?v=20261101-album';

const galleryData = JSON.parse(document.querySelector('#gallery-data').textContent);
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
    showPhotoNames, albumHref: galleryData.publicId ? `/${encodeURIComponent(galleryData.publicId)}/album` : '/album',
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
