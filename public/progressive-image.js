const bindings = new Map();
const jobs = new Map();
const queue = [];
const failedSources = new Set();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let active = 0;
let activeWall = 0;
let suspended = false;

function pump() {
  if (suspended || document.hidden) return;
  queue.sort((left, right) => right.priority - left.priority);
  while (active < 2) {
    const index = queue.findIndex(job => job.priority > 0 || activeWall === 0);
    if (index < 0) return;
    const job = queue.splice(index, 1)[0];
    if (![...job.users].some(state => bindings.get(state.image) === state && state.visible)) {
      jobs.delete(job.src);
      job.resolve(null);
      continue;
    }
    const wasWall = job.priority === 0;
    active++;
    if (wasWall) activeWall++;
    void (async () => {
      let decoded = null;
      try {
        const image = new Image();
        image.decoding = 'async';
        image.fetchPriority = job.priority > 0 ? 'high' : 'low';
        image.src = job.src;
        await image.decode();
        decoded = image;
      } catch { failedSources.add(job.src); }
      active--;
      if (wasWall) activeWall--;
      jobs.delete(job.src);
      job.resolve(decoded);
      pump();
    })();
  }
}

function originalFor(state) {
  // Reuse decoded images already displayed in this document without retaining an image cache.
  const displayed = [...document.querySelectorAll('img[data-full-loaded]')]
    .find(image => image.dataset.fullLoaded === state.src && image.complete && image.naturalWidth > 0);
  if (displayed) return Promise.resolve(displayed);
  let job = jobs.get(state.src);
  if (!job) {
    job = { src: state.src, priority: state.priority, users: new Set(), resolve: null, promise: null };
    job.promise = new Promise(resolve => { job.resolve = resolve; });
    jobs.set(state.src, job);
    queue.push(job);
  }
  job.priority = Math.max(job.priority, state.priority);
  job.users.add(state);
  // Start after all visible images have had a chance to join the shared queue.
  queueMicrotask(pump);
  return job.promise;
}

async function upgrade(state) {
  if (state.pending || !state.visible || !state.previewSettled || suspended || failedSources.has(state.src)) return;
  state.pending = true;
  let retry = false;
  try {
    const decoded = await originalFor(state);
    if (!decoded) { retry = true; return; }
    if (bindings.get(state.image) !== state || !state.image.isConnected || suspended) return;
    const layer = state.image.cloneNode(false);
    layer.removeAttribute('id');
    layer.removeAttribute('data-full-src');
    layer.removeAttribute('loading');
    layer.alt = '';
    layer.setAttribute('aria-hidden', 'true');
    layer.classList.add('progressive-original');
    layer.style.opacity = '';
    layer.src = decoded.currentSrc || decoded.src;
    await layer.decode();
    if (bindings.get(state.image) !== state) return;
    layer.dataset.fullLoaded = state.src;
    state.layer = layer;
    state.wrapper.append(layer);
    state.animation = layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reducedMotion.matches ? 0 : 320, easing: 'ease-out', fill: 'forwards' });
    await state.animation.finished;
    if (bindings.get(state.image) !== state) return;
    state.image.src = layer.src;
    await state.image.decode();
    if (bindings.get(state.image) !== state) return;
    state.image.style.opacity = '';
    state.image.dataset.fullLoaded = state.src;
    state.layer.remove();
    state.layer = null;
    observer.unobserve(state.wrapper);
  } catch {
    if (bindings.get(state.image) === state) {
      failedSources.add(state.src);
      state.layer?.remove();
      state.layer = null;
      state.image.src = state.thumbnailSrc;
      state.image.style.opacity = '';
    }
  } finally {
    state.pending = false;
    if (retry && bindings.get(state.image) === state && state.visible && !suspended && !document.hidden) void upgrade(state);
  }
}

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const image = entry.target.querySelector('img:not(.progressive-original)');
    const state = bindings.get(image);
    if (!state) continue;
    if (entry.isIntersecting && !state.visible) failedSources.delete(state.src);
    state.visible = entry.isIntersecting;
    if (state.visible) void upgrade(state);
  }
});

export function cancelProgressiveImage(image) {
  const state = bindings.get(image);
  if (!state) return;
  bindings.delete(image);
  observer.unobserve(state.wrapper);
  state.animation?.cancel();
  state.layer?.remove();
  state.events.abort();
}

export function setProgressiveImage(image, src, thumbnailSrc, { priority = 0, immediate = false } = {}) {
  cancelProgressiveImage(image);
  if (priority > 0) failedSources.delete(src);
  image.dataset.fullSrc = src;
  if (image.dataset.fullLoaded === src) { image.style.opacity = ''; return; }
  delete image.dataset.fullLoaded;
  let wrapper = image.parentElement;
  if (!wrapper.classList.contains('progressive-image')) {
    wrapper = document.createElement('span');
    wrapper.className = 'progressive-image';
    image.before(wrapper);
    wrapper.append(image);
  }
  wrapper.querySelectorAll('.progressive-original').forEach(layer => layer.remove());
  if (image.getAttribute('src') !== thumbnailSrc) image.style.opacity = '0';
  image.src = thumbnailSrc;
  if (src === thumbnailSrc) { image.style.opacity = ''; image.dataset.fullLoaded = src; return; }
  const events = new AbortController();
  // A completed failed preview can still fall back to a successfully decoded original.
  const state = { image, wrapper, src, thumbnailSrc, priority, visible: immediate, previewSettled: image.complete, pending: false, layer: null, animation: null, events };
  bindings.set(image, state);
  image.addEventListener('load', () => {
    image.style.opacity = '';
    state.previewSettled = true;
    if (image.dataset.fullLoaded !== src) void upgrade(state);
  }, { signal: events.signal });
  image.addEventListener('error', () => { state.previewSettled = true; void upgrade(state); }, { signal: events.signal });
  if (immediate) void upgrade(state);
  else observer.observe(wrapper);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const state of bindings.values()) if (state.image.dataset.fullLoaded !== state.src) void upgrade(state);
  pump();
});
window.addEventListener('online', () => {
  failedSources.clear();
  for (const state of bindings.values()) if (state.image.dataset.fullLoaded !== state.src) void upgrade(state);
});
window.addEventListener('pagehide', () => { suspended = true; observer.disconnect(); });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  suspended = false;
  for (const state of bindings.values()) {
    if (state.image.dataset.fullLoaded === state.src) continue;
    observer.observe(state.wrapper);
    if (state.visible) void upgrade(state);
  }
  pump();
});
