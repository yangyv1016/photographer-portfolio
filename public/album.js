import { mountPhotoViewer } from './photo-viewer.js?v=20261101-album';

const albumData = JSON.parse(document.querySelector('#album-data').textContent);
const grid = document.querySelector('#album-grid');
const feedback = document.querySelector('#album-feedback');
const sortHelp = document.querySelector('#album-sort-help');
const openPhotos = mountPhotoViewer(albumData);
let photos = albumData.photos.filter(photo => !albumData.selectedSeriesId || photo.series === albumData.selectedSeriesId)
  .sort((left, right) => left.albumOrder - right.albumOrder);
let savedOrder = photos.slice();
const cards = new Map();
let editing = false;
let saving = false;
let drag;
let scrollFrame = 0;
let sizeFrame = 0;
let widestImage = 0;
let tallestImage = 0;

document.querySelector('#album-count').textContent = String(photos.length);
document.querySelector('#album-empty').hidden = photos.length !== 0;

function announce(message, error = false) {
  feedback.textContent = message;
  feedback.dataset.kind = error ? 'error' : 'success';
  feedback.hidden = false;
}

function updateCellSize() {
  if (sizeFrame || !widestImage || !tallestImage) return;
  sizeFrame = requestAnimationFrame(() => {
    sizeFrame = 0;
    // Keep the drag target steady if another lazy thumbnail finishes loading.
    if (!drag?.started) document.body.style.setProperty('--album-cell-ratio', `${widestImage} / ${tallestImage}`);
  });
}

function updateLabels() {
  photos.forEach((photo, index) => {
    const card = cards.get(photo.id);
    card.querySelector('.album-photo').setAttribute('aria-label', editing ? `选择第 ${index + 1} 张照片` : albumData.showPhotoNames ? `查看照片 ${photo.title}` : `查看照片 ${index + 1}`);
    card.querySelector('img').alt = albumData.showPhotoNames ? photo.alt : `照片 ${index + 1}`;
    card.querySelector('.album-position').textContent = String(index + 1);
    card.querySelector('.album-drag-handle').setAttribute('aria-label', `调整第 ${index + 1} 张照片的位置`);
  });
}

for (const photo of photos) {
  const card = document.createElement('article');
  card.className = 'album-card';
  card.dataset.photoId = photo.id;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'album-photo';
  const image = document.createElement('img');
  image.loading = 'lazy';
  image.decoding = 'async';
  image.draggable = false;
  const unavailable = document.createElement('span');
  unavailable.className = 'album-image-error';
  unavailable.textContent = '预览暂不可用';
  unavailable.hidden = true;
  image.addEventListener('load', () => {
    unavailable.hidden = true;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      widestImage = Math.max(widestImage, image.naturalWidth);
      tallestImage = Math.max(tallestImage, image.naturalHeight);
      updateCellSize();
    }
  });
  image.addEventListener('error', () => { unavailable.hidden = false; });
  image.src = photo.thumbnailSrc;
  button.append(image, unavailable);
  button.addEventListener('click', () => {
    if (!editing) openPhotos(photos, photos.findIndex(item => item.id === photo.id));
  });
  const position = document.createElement('span');
  position.className = 'album-position';
  position.setAttribute('aria-hidden', 'true');
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'album-drag-handle';
  handle.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="7" cy="5" r="1.4"/><circle cx="13" cy="5" r="1.4"/><circle cx="7" cy="10" r="1.4"/><circle cx="13" cy="10" r="1.4"/><circle cx="7" cy="15" r="1.4"/><circle cx="13" cy="15" r="1.4"/></svg>';
  card.append(button, position, handle);
  if (albumData.showPhotoNames) {
    const name = document.createElement('p');
    name.className = 'album-photo-name';
    name.textContent = photo.title;
    card.append(name);
  }
  cards.set(photo.id, card);
  grid.append(card);
}
updateLabels();

for (const type of ['contextmenu', 'dragstart']) {
  grid.addEventListener(type, event => { if (event.target.closest('.album-photo')) event.preventDefault(); });
}

if (albumData.canArrange) {
  const arrangeButton = document.querySelector('#arrange-album');
  const saveButton = document.querySelector('#save-album-order');
  const cancelButton = document.querySelector('#cancel-album-order');
  const reverseButton = document.querySelector('#reverse-album-order');
  const resetButton = document.querySelector('#reset-album-order');
  const orderTools = document.querySelector('#album-order-tools');
  const selectionLabel = document.querySelector('#album-selection-label');
  const positionForm = document.querySelector('#album-move-to');
  const positionInput = document.querySelector('#album-move-position');
  const moveButtons = [...orderTools.querySelectorAll('[data-album-move]')];
  let selectedPhotoId;

  function updateControls() {
    const dirty = photos.some((photo, index) => photo.id !== savedOrder[index].id);
    const selectedIndex = photos.findIndex(photo => photo.id === selectedPhotoId);
    const blocked = saving || Boolean(drag);
    document.body.classList.toggle('is-arranging', editing);
    arrangeButton.hidden = editing;
    arrangeButton.disabled = photos.length < 2;
    saveButton.hidden = cancelButton.hidden = reverseButton.hidden = resetButton.hidden = orderTools.hidden = !editing;
    saveButton.disabled = saving || !dirty;
    cancelButton.disabled = saving;
    reverseButton.disabled = blocked || photos.length < 2;
    resetButton.disabled = blocked || !dirty;
    saveButton.textContent = saving ? '正在保存…' : '保存顺序';
    sortHelp.hidden = !editing;
    sortHelp.textContent = '点击照片后，可用底部工具前移、后移、置顶、置底或指定位置；也可拖动手柄、使用方向键调整。点击「保存顺序」后生效。';
    selectionLabel.textContent = selectedIndex < 0 ? '点击一张照片，选择要移动的内容' : `已选第 ${selectedIndex + 1} / ${photos.length} 张照片`;
    positionInput.max = String(photos.length);
    positionInput.value = selectedIndex < 0 ? '' : String(selectedIndex + 1);
    positionInput.setCustomValidity('');
    for (const control of positionForm.elements) control.disabled = blocked || selectedIndex < 0;
    for (const button of moveButtons) {
      const towardStart = button.dataset.albumMove === 'first' || button.dataset.albumMove === 'previous';
      button.disabled = blocked || selectedIndex < 0 || (towardStart ? selectedIndex === 0 : selectedIndex === photos.length - 1);
    }
    if (saving) grid.setAttribute('aria-busy', 'true');
    else grid.removeAttribute('aria-busy');
    for (const [id, card] of cards) {
      const selected = editing && id === selectedPhotoId;
      card.classList.toggle('is-selected', selected);
      const button = card.querySelector('.album-photo');
      button.disabled = saving;
      if (editing) button.setAttribute('aria-pressed', String(selected));
      else button.removeAttribute('aria-pressed');
      card.querySelector('.album-drag-handle').disabled = saving;
    }
    updateLabels();
  }

  function movePhoto(id, nextIndex) {
    const previousIndex = photos.findIndex(photo => photo.id === id);
    if (previousIndex === nextIndex) return;
    const [photo] = photos.splice(previousIndex, 1);
    photos.splice(nextIndex, 0, photo);
    const node = drag?.placeholder && drag.photoId === id ? drag.placeholder : cards.get(id);
    const following = photos[nextIndex + 1];
    grid.insertBefore(node, following ? cards.get(following.id) : null);
    updateControls();
  }

  grid.addEventListener('click', event => {
    const button = event.target.closest('.album-photo');
    if (!button || !editing || saving || drag) return;
    selectedPhotoId = button.closest('.album-card').dataset.photoId;
    feedback.hidden = true;
    updateControls();
  });
  orderTools.addEventListener('click', event => {
    const button = event.target.closest('[data-album-move]');
    if (!button || button.disabled) return;
    const index = photos.findIndex(photo => photo.id === selectedPhotoId);
    const positions = { previous: index - 1, next: index + 1, first: 0, last: photos.length - 1 };
    movePhoto(selectedPhotoId, positions[button.dataset.albumMove]);
    cards.get(selectedPhotoId).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    announce('位置已调整，点击「保存顺序」后生效。');
  });
  positionInput.addEventListener('input', () => positionInput.setCustomValidity(''));
  positionForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!editing || saving || drag || !selectedPhotoId) return;
    const position = positionInput.valueAsNumber;
    if (!Number.isInteger(position) || position < 1 || position > photos.length) {
      positionInput.setCustomValidity(`请输入 1 到 ${photos.length} 之间的整数。`);
      positionInput.reportValidity();
      return;
    }
    movePhoto(selectedPhotoId, position - 1);
    cards.get(selectedPhotoId).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    announce('位置已调整，点击「保存顺序」后生效。');
  });
  reverseButton.addEventListener('click', () => {
    photos.reverse();
    for (const photo of photos) grid.append(cards.get(photo.id));
    updateControls();
    announce('顺序已反转，点击「保存顺序」后生效。');
  });
  resetButton.addEventListener('click', () => {
    photos = savedOrder.slice();
    for (const photo of photos) grid.append(cards.get(photo.id));
    updateControls();
    announce('已还原到本次调整前的顺序。');
  });

  function movePlaceholder() {
    const target = document.elementFromPoint(drag.x, drag.y)?.closest('.album-card');
    if (!target || !grid.contains(target)) return;
    movePhoto(drag.photoId, photos.findIndex(photo => photo.id === target.dataset.photoId));
  }

  function followDrag() {
    if (!drag?.started) return;
    const edge = 64;
    const height = document.documentElement.clientHeight;
    const speed = drag.y < edge ? -Math.min(14, (edge - drag.y) / 4)
      : drag.y > height - edge ? Math.min(14, (drag.y - height + edge) / 4) : 0;
    if (speed) window.scrollBy({ top: speed, behavior: 'instant' });
    movePlaceholder();
    scrollFrame = requestAnimationFrame(followDrag);
  }

  function finishDrag(canceled) {
    if (!drag) return;
    const finished = drag;
    drag = undefined;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    if (grid.hasPointerCapture(finished.pointerId)) grid.releasePointerCapture(finished.pointerId);
    if (finished.started) {
      const card = cards.get(finished.photoId);
      finished.placeholder.replaceWith(card);
      card.classList.remove('is-dragging');
      card.style.width = card.style.height = card.style.left = card.style.top = '';
      if (canceled) {
        photos = finished.order;
        for (const photo of photos) grid.append(cards.get(photo.id));
      } else if (photos.some((photo, index) => photo.id !== finished.order[index].id)) {
        announce('位置已调整，点击「保存顺序」后生效。');
      }
      updateCellSize();
    }
    updateControls();
  }

  grid.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.album-drag-handle');
    if (!handle || !editing || saving || drag || event.button !== 0) return;
    const card = handle.closest('.album-card');
    selectedPhotoId = card.dataset.photoId;
    const bounds = card.getBoundingClientRect();
    drag = { pointerId: event.pointerId, photoId: card.dataset.photoId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top,
      bounds, order: photos.slice(), started: false, placeholder: null };
    updateControls();
    event.preventDefault();
    handle.focus({ preventScroll: true });
    grid.setPointerCapture(event.pointerId);
  });
  grid.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.started && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6) {
      const card = cards.get(drag.photoId);
      drag.started = true;
      drag.placeholder = document.createElement('div');
      drag.placeholder.className = 'album-placeholder';
      drag.placeholder.style.height = `${drag.bounds.height}px`;
      card.before(drag.placeholder);
      document.body.append(card);
      card.classList.add('is-dragging');
      card.style.width = `${drag.bounds.width}px`;
      card.style.height = `${drag.bounds.height}px`;
      scrollFrame = requestAnimationFrame(followDrag);
    }
    if (drag.started) {
      const card = cards.get(drag.photoId);
      card.style.left = `${drag.x - drag.offsetX}px`;
      card.style.top = `${drag.y - drag.offsetY}px`;
      movePlaceholder();
    }
  });
  grid.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) finishDrag(false); });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    grid.addEventListener(type, event => { if (drag?.pointerId === event.pointerId) finishDrag(true); });
  }
  grid.addEventListener('keydown', event => {
    const handle = event.target.closest('.album-drag-handle');
    if (!handle || !editing || saving || drag) return;
    const id = handle.closest('.album-card').dataset.photoId;
    const index = photos.findIndex(photo => photo.id === id);
    const movements = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3, Home: -index, End: photos.length - 1 - index };
    if (!(event.key in movements)) return;
    event.preventDefault();
    selectedPhotoId = id;
    const nextIndex = Math.max(0, Math.min(photos.length - 1, index + movements[event.key]));
    if (nextIndex === index) updateControls();
    else movePhoto(id, nextIndex);
    handle.focus();
    announce('位置已调整，点击「保存顺序」后生效。');
  });
  window.addEventListener('resize', () => finishDrag(true));
  window.addEventListener('blur', () => finishDrag(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishDrag(true); });

  arrangeButton.addEventListener('click', () => {
    editing = true;
    selectedPhotoId = undefined;
    feedback.hidden = true;
    updateControls();
  });
  cancelButton.addEventListener('click', () => {
    finishDrag(true);
    photos = savedOrder.slice();
    for (const photo of photos) grid.append(cards.get(photo.id));
    editing = false;
    updateControls();
    announce('已取消本次调整。');
  });
  saveButton.addEventListener('click', async () => {
    finishDrag(false);
    if (saving) return;
    saving = true;
    updateControls();
    try {
      const payload = { ids: photos.map(photo => photo.id) };
      if (albumData.selectedSeriesId) payload.series = albumData.selectedSeriesId;
      let response;
      try { response = await fetch('/api/admin/album-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
      catch { throw new Error('连接失败，请检查网络后重试。'); }
      let result;
      try { result = await response.json(); }
      catch { throw new Error('服务暂时不可用，请稍后重试。'); }
      if (!response.ok) throw new Error(result.error);
      savedOrder = photos.slice();
      editing = false;
      announce('相册顺序已保存。');
    } catch (error) { announce(error.message, true); }
    finally { saving = false; updateControls(); }
  });
  window.addEventListener('beforeunload', event => {
    if (!saving && !photos.some((photo, index) => photo.id !== savedOrder[index].id)) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.addEventListener('keydown', event => {
    if (editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!saveButton.disabled) saveButton.click();
    }
  });
  updateControls();
}
