import { setProgressiveImage, cancelProgressiveImage } from './progressive-image.js?v=20261101-progressive';
import { mountLightboxZoom } from './lightbox-zoom.js?v=20261101-zoom';

export function mountPhotoViewer(galleryData) {
  const lightbox = document.querySelector('#lightbox');
  const image = document.querySelector('#lightbox-image');
  const stage = document.querySelector('#lightbox-stage');
  let activePhotos = [];
  let activeIndex = 0;
  const resetZoom = mountLightboxZoom(
    document.querySelector('#lightbox-viewport'), document.querySelector('#lightbox-image-plane'), image,
    document.querySelector('#reset-photo-zoom'), direction => showPhoto(activeIndex + direction),
  );
  image.draggable = false;
  for (const type of ['contextmenu', 'dragstart']) {
    stage.addEventListener(type, event => { if (event.target.closest('img')) event.preventDefault(); });
  }
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
  });

  function showPhoto(index) {
    activeIndex = (index + activePhotos.length) % activePhotos.length;
    const photo = activePhotos[activeIndex];
    setProgressiveImage(image, photo.src, photo.thumbnailSrc, { priority: 2, immediate: true });
    resetZoom();
    image.alt = galleryData.showPhotoNames ? photo.alt : `照片 ${activeIndex + 1}`;
    const seriesIndex = galleryData.series.findIndex(series => series.id === photo.series);
    document.querySelector('#lightbox-series').textContent = `${String(seriesIndex + 1).padStart(2, '0')} / ${galleryData.series[seriesIndex].name}`;
    document.querySelector('#lightbox-count').textContent = `${String(activeIndex + 1).padStart(2, '0')} / ${String(activePhotos.length).padStart(2, '0')}`;
    document.querySelector('#lightbox-title').textContent = galleryData.showPhotoNames ? photo.title : '';
    const credit = document.querySelector('#lightbox-credit');
    credit.textContent = `${photo.isSample ? '示例摄影' : '摄影'}：${photo.photographer}`;
    if (photo.isSample) credit.href = photo.source;
    else credit.removeAttribute('href');
  }

  document.querySelector('#close-lightbox').addEventListener('click', () => lightbox.close());
  document.querySelector('#previous-photo').addEventListener('click', () => showPhoto(activeIndex - 1));
  document.querySelector('#next-photo').addEventListener('click', () => showPhoto(activeIndex + 1));
  lightbox.addEventListener('close', () => { resetZoom(); cancelProgressiveImage(image); document.body.style.overflow = ''; });
  lightbox.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      showPhoto(activeIndex + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  stage.addEventListener('click', event => { if (event.target === stage) lightbox.close(); });
  return (collection, index) => {
    activePhotos = collection;
    showPhoto(index);
    lightbox.showModal();
    document.body.style.overflow = 'hidden';
  };
}
