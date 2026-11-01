import { setProgressiveImage, cancelProgressiveImage } from './progressive-image.js?v=20261101-progressive';

export function mountPhotoWall(wall, photos, openPhoto, { showPhotoNames = false, albumHref = '' } = {}) {
  const viewport = wall.querySelector('.wall-lanes');
  const toggle = wall.querySelector('.wall-toggle');
  const edges = [...wall.querySelectorAll('.wall-edge')];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const mountedImages = new WeakSet();
  if (albumHref) {
    const album = document.createElement('a');
    album.className = 'wall-all';
    album.href = albumHref;
    album.target = '_blank';
    album.rel = 'noopener noreferrer';
    album.setAttribute('aria-label', '在新标签页查看此系列相册');
    album.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1.4"/><rect x="14" y="4" width="6" height="6" rx="1.4"/><rect x="4" y="14" width="6" height="6" rx="1.4"/><rect x="14" y="14" width="6" height="6" rx="1.4"/></svg><span>相册</span>';
    wall.querySelector('.wall-controls').append(album);
  }
  let paused = reducedMotion.matches;
  let hovered = false;
  let keyboardFocused = false;
  let navigationDirection = 0;
  let interactingUntil = 0;
  let visible = false;
  let lanes = [];
  let previousTime = 0;
  let frame = 0;

  function renderWall() {
    viewport.replaceChildren();
    lanes = [];
    toggle.disabled = !photos.length;
    edges.forEach(edge => { edge.hidden = !photos.length; });
    if (!photos.length) {
      const empty = document.createElement('p');
      empty.className = 'wall-empty';
      empty.textContent = albumHref ? '照片墙暂无照片，可在「相册」中查看该系列。' : '这个系列的照片还在整理中。';
      viewport.append(empty);
      return;
    }
    const rows = photos.length > 1 ? 2 : 1;
    for (let row = 0; row < rows; row++) {
      const lane = document.createElement('div');
      lane.className = 'wall-lane';
      lane.setAttribute('aria-label', `照片墙第 ${row + 1} 行，可横向滚动`);
      const track = document.createElement('div');
      track.className = 'wall-track';
      const group = document.createElement('div');
      group.className = 'wall-group';
      photos.forEach((photo, index) => {
        if (index % rows !== row) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wall-photo';
        button.draggable = false;
        button.dataset.index = String(index);
        button.setAttribute('aria-label', showPhotoNames ? `放大查看${photo.title}` : `放大查看照片 ${index + 1}`);
        const image = document.createElement('img');
        image.src = photo.thumbnailSrc;
        image.alt = showPhotoNames ? photo.alt : `照片 ${index + 1}`;
        image.loading = 'lazy';
        image.draggable = false;
        button.append(image);
        if (showPhotoNames) {
          const caption = document.createElement('span');
          caption.textContent = photo.title;
          button.append(caption);
        }
        group.append(button);
      });
      track.append(group);
      lane.append(track);
      viewport.append(lane);
      const originals = [...group.children];
      const state = { lane, group, track, position: 0, width: 0, viewportWidth: 0 };
      let duplicate;
      let ratioTimer;
      function fillLane() {
        let width = group.getBoundingClientRect().width;
        while (width > 0 && width <= lane.clientWidth) {
          originals.forEach(original => {
            const copy = original.cloneNode(true);
            copy.tabIndex = -1;
            copy.setAttribute('aria-hidden', 'true');
            group.append(copy);
          });
          width = group.getBoundingClientRect().width;
        }
        const replacement = group.cloneNode(true);
        replacement.setAttribute('aria-hidden', 'true');
        replacement.querySelectorAll('button').forEach(button => { button.tabIndex = -1; });
        if (duplicate) {
          duplicate.querySelectorAll('img:not(.progressive-original)').forEach(cancelProgressiveImage);
          duplicate.replaceWith(replacement);
        }
        else track.append(replacement);
        duplicate = replacement;
        track.querySelectorAll('img:not(.progressive-original)').forEach(image => {
          const photo = photos[Number(image.closest('[data-index]').dataset.index)];
          if (!mountedImages.has(image)) {
            setProgressiveImage(image, photo.src, photo.thumbnailSrc);
            mountedImages.add(image);
          }
        });
        state.width = width;
        state.viewportWidth = lane.clientWidth;
      }
      group.querySelectorAll('img').forEach(image => {
        const updateRatio = () => {
          const index = image.closest('[data-index]').dataset.index;
          track.querySelectorAll(`[data-index="${index}"]`).forEach(button => button.style.setProperty('--ratio', image.naturalWidth / image.naturalHeight));
          clearTimeout(ratioTimer);
          ratioTimer = setTimeout(fillLane, 100);
        };
        image.addEventListener('load', updateRatio);
        if (image.complete && image.naturalHeight > 0) updateRatio();
      });
      fillLane();
      state.fill = fillLane;
      track.addEventListener('click', event => {
        const button = event.target.closest('[data-index]');
        if (button) openPhoto(photos, Number(button.dataset.index));
      });
      lanes.push(state);
      lane.addEventListener('scroll', () => {
        if (!navigationDirection && (performance.now() < interactingUntil || hovered || paused || keyboardFocused)) {
          state.position = lane.scrollLeft;
          track.style.transform = '';
        }
      }, { passive: true });
      lane.addEventListener('pointerdown', () => { interactingUntil = performance.now() + 6000; });
      lane.addEventListener('wheel', () => { interactingUntil = performance.now() + 6000; }, { passive: true });
    }
  }

  function animate(time) {
    const elapsed = previousTime ? Math.min(time - previousTime, 64) : 0;
    previousTime = time;
    keyboardFocused = viewport.contains(document.activeElement) && document.activeElement.matches(':focus-visible');
    const browsing = navigationDirection !== 0 || (!paused && !hovered && !keyboardFocused && time >= interactingUntil);
    if (visible && browsing && !document.hidden && !document.querySelector('dialog[open]')) {
      for (const state of lanes) {
        const width = state.width;
        if (width <= state.viewportWidth) continue;
        const speed = navigationDirection ? navigationDirection * 0.12 : 0.012;
        state.position = ((state.position + elapsed * speed) % width + width) % width;
        state.lane.scrollLeft = state.position;
        // Native scroll offsets can round to whole pixels; retain the fractional motion.
        state.track.style.transform = `translateX(${state.lane.scrollLeft - state.position}px)`;
      }
    }
    frame = visible ? requestAnimationFrame(animate) : 0;
  }

  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible && !frame) { previousTime = 0; frame = requestAnimationFrame(animate); }
  });
  observer.observe(wall);
  viewport.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') hovered = true; });
  viewport.addEventListener('pointerleave', () => { hovered = false; });
  for (const edge of edges) {
    const direction = Number(edge.dataset.direction);
    edge.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') navigationDirection = direction; });
    edge.addEventListener('pointerleave', () => { navigationDirection = 0; });
    edge.addEventListener('pointercancel', () => { navigationDirection = 0; });
    edge.addEventListener('click', () => {
      interactingUntil = performance.now() + 1500;
      for (const state of lanes) {
        const width = state.width;
        if (!width) continue;
        state.position = ((state.lane.scrollLeft + direction * state.viewportWidth * 0.6) % width + width) % width;
        state.lane.scrollLeft = state.position;
        state.track.style.transform = '';
      }
    });
  }
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => lanes.forEach(state => state.fill()), 150); });
  function updateToggle() {
    toggle.innerHTML = paused
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10-6.5Z"/></svg><span>播放</span>'
      : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span>暂停</span>';
    toggle.setAttribute('aria-label', paused ? '播放滚动' : '暂停滚动');
    toggle.setAttribute('aria-pressed', String(paused));
  }
  updateToggle();
  toggle.addEventListener('click', () => {
    paused = !paused;
    updateToggle();
  });
  reducedMotion.addEventListener('change', event => {
    paused = event.matches;
    updateToggle();
  });
  renderWall();
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frame);
    frame = 0;
    observer.disconnect();
    hovered = false;
    navigationDirection = 0;
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    previousTime = 0;
    observer.observe(wall);
  });
}
