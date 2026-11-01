import { renderNoteMarkdown } from './note-markdown.js?v=20261101-markdown';

export function mountNotebook(notebook, notes) {
  if (!notes.length) return;
  const viewport = notebook.querySelector('.notebook-viewport');
  const track = viewport.querySelector('.notebook-track');
  const group = track.querySelector('.notebook-group');
  const toggle = notebook.querySelector('.notebook-toggle');
  const dialog = document.querySelector('#notebook-dialog');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let duplicate;
  let loopWidth = 0;
  let position = 0;
  let visible = false;
  let hovered = false;
  let focused = false;
  let paused = false;
  let interacting = false;
  let pointerActive = false;
  let suspended = false;
  let frame = 0;
  let previousTime = 0;
  let resumeTimer;
  let listeners;
  let noteRenderRequest = 0;

  async function renderNote(note) {
    const request = ++noteRenderRequest;
    const content = dialog.querySelector('#notebook-dialog-content');
    content.textContent = '正在加载便签…';
    content.setAttribute('aria-busy', 'true');
    try { await renderNoteMarkdown(note.content, content); }
    catch (error) {
      if (request !== noteRenderRequest) return;
      console.error('Markdown note failed', error);
      content.innerHTML = '<p>排版加载失败，以下显示原文。<button type="button" class="notebook-toggle">重试排版</button></p><pre class="note-markdown-fallback"></pre>';
      content.querySelector('pre').textContent = note.content;
      content.querySelector('button').addEventListener('click', () => { void renderNote(note); });
    } finally {
      if (request === noteRenderRequest) content.removeAttribute('aria-busy');
    }
  }

  function updatePlayback() {
    const playing = loopWidth > 0 && visible && !suspended && !document.hidden && !reducedMotion.matches
      && !paused && !hovered && !focused && !interacting && !pointerActive && !document.querySelector('dialog[open]');
    if (playing && !frame) {
      previousTime = 0;
      position = viewport.scrollLeft;
      frame = requestAnimationFrame(animate);
    } else if (!playing) {
      cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
      track.style.transform = '';
    }
  }

  function animate(time) {
    const elapsed = previousTime ? Math.min(time - previousTime, 64) : 0;
    previousTime = time;
    position = (position + elapsed * 0.018) % loopWidth;
    viewport.scrollLeft = position;
    // Preserve fractional motion when native scroll offsets round to whole pixels.
    track.style.transform = `translateX(${viewport.scrollLeft - position}px)`;
    frame = requestAnimationFrame(animate);
  }

  function measure() {
    const previousPosition = viewport.scrollLeft;
    duplicate?.remove();
    duplicate = undefined;
    track.style.transform = '';
    const width = group.getBoundingClientRect().width;
    loopWidth = 0;
    if (group.children.length > 1 && width > viewport.clientWidth + 1) {
      duplicate = group.cloneNode(true);
      duplicate.setAttribute('aria-hidden', 'true');
      duplicate.querySelectorAll('button,[tabindex]').forEach(card => { card.tabIndex = -1; });
      track.append(duplicate);
      loopWidth = width + parseFloat(getComputedStyle(track).columnGap);
    }
    position = loopWidth ? previousPosition % loopWidth : 0;
    viewport.scrollLeft = position;
    toggle.hidden = !loopWidth || reducedMotion.matches;
    toggle.textContent = paused ? '播放滚动' : '暂停滚动';
    toggle.setAttribute('aria-pressed', String(paused));
    updatePlayback();
  }

  function pauseForBrowsing() {
    interacting = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { interacting = false; updatePlayback(); }, 4000);
    updatePlayback();
  }

  const visibility = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    updatePlayback();
  });
  const resize = new ResizeObserver(measure);
  const dialogs = new MutationObserver(updatePlayback);

  function connect() {
    listeners = new AbortController();
    const signal = listeners.signal;
    viewport.addEventListener('pointerenter', event => {
      if (event.pointerType === 'mouse') { hovered = true; updatePlayback(); }
    }, { signal });
    viewport.addEventListener('pointerleave', () => { hovered = false; updatePlayback(); }, { signal });
    viewport.addEventListener('focusin', event => { focused = event.target.matches(':focus-visible'); updatePlayback(); }, { signal });
    viewport.addEventListener('focusout', event => { focused = viewport.contains(event.relatedTarget) && event.relatedTarget.matches(':focus-visible'); updatePlayback(); }, { signal });
    viewport.addEventListener('pointerdown', event => {
      // Visual loop copies open the same note without taking keyboard focus.
      if (event.target.closest('.notebook-group[aria-hidden="true"]')) event.preventDefault();
      pointerActive = true;
      pauseForBrowsing();
    }, { signal });
    track.addEventListener('click', event => {
      const button = event.target.closest('[data-note-id]');
      if (!button) return;
      const note = notes.find(item => item.id === button.dataset.noteId);
      dialog.querySelector('#notebook-dialog-title').textContent = note.title;
      void renderNote(note);
      dialog.showModal();
      dialog.querySelector('#notebook-dialog-content').scrollTop = 0;
      document.body.style.overflow = 'hidden';
    }, { signal });
    dialog.querySelector('#close-notebook').addEventListener('click', () => dialog.close(), { signal });
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }, { signal });
    dialog.addEventListener('close', () => { noteRenderRequest++; document.body.style.overflow = ''; }, { signal });
    viewport.addEventListener('wheel', pauseForBrowsing, { passive: true, signal });
    viewport.addEventListener('keydown', pauseForBrowsing, { signal });
    for (const type of ['pointerup', 'pointercancel']) {
      window.addEventListener(type, () => {
        if (pointerActive) { pointerActive = false; pauseForBrowsing(); }
      }, { signal });
    }
    toggle.addEventListener('click', () => {
      paused = !paused;
      toggle.textContent = paused ? '播放滚动' : '暂停滚动';
      toggle.setAttribute('aria-pressed', String(paused));
      updatePlayback();
    }, { signal });
    reducedMotion.addEventListener('change', measure, { signal });
    document.addEventListener('visibilitychange', updatePlayback, { signal });
    document.querySelectorAll('dialog').forEach(dialog => dialogs.observe(dialog, { attributes: true, attributeFilter: ['open'] }));
    visibility.observe(notebook);
    resize.observe(viewport);
    resize.observe(group);
    focused = viewport.contains(document.activeElement) && document.activeElement.matches(':focus-visible');
    hovered = matchMedia('(hover: hover)').matches && viewport.matches(':hover');
    measure();
  }

  window.addEventListener('pagehide', () => {
    suspended = true;
    clearTimeout(resumeTimer);
    listeners.abort();
    visibility.disconnect();
    resize.disconnect();
    dialogs.disconnect();
    updatePlayback();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    suspended = false;
    interacting = false;
    pointerActive = false;
    connect();
  });
  connect();
}
