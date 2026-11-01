export function getExportGroups(selected, count) {
  const groups = [];
  const size = Math.floor(selected.length / count);
  const extra = selected.length % count;
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const photos = selected.slice(offset, offset + size + (index < extra ? 1 : 0));
    offset += photos.length;
    groups.push(photos);
  }
  return groups;
}

export function createExportPages(selected, { count, columns, width, gap, ratio }) {
  const pages = [];
  for (const photos of getExportGroups(selected, count)) {
    const page = { cells: [], height: 0 };
    for (let rowStart = 0; rowStart < photos.length; rowStart += columns) {
      const row = photos.slice(rowStart, rowStart + columns);
      const cellWidth = (width - gap * (row.length - 1)) / row.length;
      const cellHeight = cellWidth / ratio;
      const y = page.height + (page.cells.length ? gap : 0);
      row.forEach((photo, column) => page.cells.push({ photo, x: column * (cellWidth + gap), y, width: cellWidth, height: cellHeight }));
      page.height = y + cellHeight;
    }
    pages.push(page);
  }
  const tallest = Math.max(...pages.map(page => page.height));
  let scale = Math.min(1, 12000 / tallest, Math.sqrt(24000000 / (width * tallest)));
  const actualWidth = Math.max(1, Math.floor(width * scale));
  const maximumHeight = Math.min(12000, Math.floor(24000000 / actualWidth));
  scale = Math.min(scale, actualWidth / width, maximumHeight / tallest);
  for (const page of pages) {
    for (const cell of page.cells) {
      cell.x *= scale;
      cell.y *= scale;
      cell.width *= scale;
      cell.height *= scale;
    }
    page.height = Math.min(maximumHeight, Math.max(1, Math.ceil(page.height * scale)));
  }
  return { pages, width: actualWidth };
}

export function openPhotoExport(photos) {
  if (!photos.length) return;
  document.querySelector('#photo-export-dialog')?.close();
  const controller = new AbortController();
  const thumbnails = new Map();
  let ordered = photos.map(photo => ({ ...photo, included: true }));
  let ready = false;
  let exporting = false;
  let pageIndex = 0;
  let pages = [];
  let outputWidth = 2400;
  let selectedPhotoId;
  let drag;
  let scrollFrame = 0;
  const cards = new Map();
  const groupViews = new Map();
  const dialog = document.createElement('dialog');
  dialog.id = 'photo-export-dialog';
  dialog.className = 'photo-export-dialog';
  dialog.setAttribute('aria-labelledby', 'photo-export-heading');
  dialog.innerHTML = `<header class="export-header"><div><span class="export-eyebrow">旸隅 / CONTACT SHEET</span><h2 id="photo-export-heading">把影像，放在一起。</h2></div><button type="button" class="export-close" aria-label="关闭拼图导出">×</button></header>
    <div class="export-layout"><div class="export-settings"><form class="export-options">
      <label class="export-count-option">导出张数<input name="pageCount" type="number" min="1" max="${photos.length}" step="1" value="1" required><span class="export-count-hint">将已选照片均分为几张拼图</span></label>
      <details class="export-display-options" open><summary>排版与格式</summary><div class="export-option-grid">
      <label>每行照片<select name="columns"><option value="2">两列拼图</option><option value="3">三列拼图</option><option value="4">四列拼图</option><option value="1">单列长图</option></select></label>
      <label>画面比例<select name="ratio"><option value="auto">自动 · 跟随照片</option><option value="1.5">横向 3:2</option><option value="0.6666666667">竖向 2:3</option><option value="1">方形 1:1</option></select></label>
      <label>照片适配<select name="fit"><option value="contain">完整保留画面</option><option value="cover">铺满格子 · 居中裁切</option></select></label>
      <label>照片间距<select name="gap"><option value="0">无间距</option><option value="8">8 像素</option><option value="24">24 像素</option><option value="48">48 像素</option></select></label>
      <label>文件格式<select name="format"><option value="image/jpeg">JPG</option><option value="image/png">PNG</option></select></label>
      <label>底色<select name="background"><option value="#ffffff">白色</option><option value="#111111">黑色</option></select></label>
      <details class="export-advanced"><summary>高级设置</summary><label>最大宽度<select name="width"><option value="1600">1600 px</option><option value="2400" selected>2400 px</option><option value="3600">3600 px</option></select></label><p>尺寸过大时会自动降低分辨率，保持你选择的导出张数。</p><span class="export-dimensions"></span></details>
      </div></details>
    </form></div>
    <div class="export-preview-panel"><div class="export-view-tabs" role="tablist" aria-label="拼图编辑视图"><button type="button" role="tab" id="export-arrange-tab" aria-controls="export-arrange-panel" aria-selected="true">照片编排</button><button type="button" role="tab" id="export-preview-tab" aria-controls="export-result-panel" aria-selected="false" tabindex="-1">成品预览</button></div>
      <section class="export-arrange-panel" id="export-arrange-panel" role="tabpanel" aria-labelledby="export-arrange-tab"><p class="export-arrange-help">每组对应一张拼图；拖动或用按钮调整顺序后重新均分，仅影响本次导出。</p><div class="export-selection-tools"><p id="export-selection-label" aria-live="polite">点击照片，选择要移动的内容</p><div class="export-order-moves"><button type="button" data-export-move="first">置顶</button><button type="button" data-export-move="previous">前移</button><button type="button" data-export-move="next">后移</button><button type="button" data-export-move="last">置底</button></div><form class="export-move-to" id="export-move-to"><label for="export-move-position">移至第</label><input id="export-move-position" type="number" min="1" max="${photos.length}" step="1" required aria-label="编排目标位置"><span>位</span><button type="submit">移动</button></form></div><div class="export-photo-grid" id="export-photo-grid" aria-label="本次导出的照片编排"></div></section>
      <section id="export-result-panel" role="tabpanel" aria-labelledby="export-preview-tab" hidden><div class="export-preview-bar"><span>成品预览</span><span class="export-page-summary"></span></div><div class="export-canvas-wrap"><canvas class="export-canvas" aria-label="即将导出的照片拼图预览"></canvas></div><div class="export-pagination"><button type="button" data-page="previous">← 上一张拼图</button><span></span><button type="button" data-page="next">下一张拼图 →</button></div></section>
      <div class="export-actions"><p class="export-message" role="status" aria-live="polite">正在读取照片…</p><button type="button" class="export-download" disabled>导出全部拼图 · ZIP</button><p class="export-note">按选择的张数生成全部拼图，一次打包 ZIP 下载；成品预览可逐张检查。默认不裁切、不添加文字。</p></div></div></div>`;
  document.body.append(dialog);
  const form = dialog.querySelector('.export-options');
  const grid = dialog.querySelector('#export-photo-grid');
  const arrangePanel = dialog.querySelector('#export-arrange-panel');
  dialog.querySelector('.export-display-options').open = !window.matchMedia('(max-width:760px)').matches;
  const canvas = dialog.querySelector('canvas');
  const message = dialog.querySelector('.export-message');
  const download = dialog.querySelector('.export-download');
  const previous = dialog.querySelector('[data-page="previous"]');
  const next = dialog.querySelector('[data-page="next"]');
  const pageLabel = dialog.querySelector('.export-pagination span');
  const widthField = form.elements.namedItem('width');
  const columnsField = form.elements.namedItem('columns');
  const pageCountField = form.elements.namedItem('pageCount');
  const selectionLabel = dialog.querySelector('#export-selection-label');
  const positionForm = dialog.querySelector('#export-move-to');
  const positionInput = dialog.querySelector('#export-move-position');
  const moveButtons = [...dialog.querySelectorAll('[data-export-move]')];

  for (const photo of ordered) {
    const card = document.createElement('article');
    card.className = 'export-photo-card';
    card.dataset.photoId = photo.id;
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'export-photo-preview';
    const image = document.createElement('img');
    image.src = photo.thumbnailSrc;
    image.alt = photo.title;
    image.loading = 'lazy';
    image.draggable = false;
    preview.append(image);
    preview.addEventListener('click', () => {
      if (!ready || exporting || drag) return;
      selectedPhotoId = photo.id;
      updateArrangement();
    });
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'export-photo-include';
    check.checked = true;
    check.setAttribute('aria-label', `保留照片 ${photo.title}`);
    check.addEventListener('change', () => {
      photo.included = check.checked;
      const includedCount = ordered.filter(item => item.included).length;
      if (pageCountField.valueAsNumber > includedCount) pageCountField.value = String(Math.max(1, includedCount));
      pageIndex = 0;
      updateArrangement();
      updatePreview();
      check.focus({ preventScroll: true });
    });
    const position = document.createElement('span');
    position.className = 'export-photo-position';
    position.setAttribute('aria-hidden', 'true');
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'export-photo-drag-handle';
    handle.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="7" cy="5" r="1.4"/><circle cx="13" cy="5" r="1.4"/><circle cx="7" cy="10" r="1.4"/><circle cx="13" cy="10" r="1.4"/><circle cx="7" cy="15" r="1.4"/><circle cx="13" cy="15" r="1.4"/></svg>';
    card.append(preview, check, position, handle);
    cards.set(photo.id, card);
  }

  function updateGroups() {
    const selected = ordered.filter(photo => photo.included);
    const excluded = ordered.filter(photo => !photo.included);
    const count = pageCountField.valueAsNumber;
    const validCount = Number.isInteger(count) && count >= 1 && count <= selected.length;
    const groups = [];
    if (selected.length) {
      if (!ready) groups.push({ key: 'loading', kind: 'loading', title: '正在准备照片', photos: selected });
      else if (!validCount) groups.push({ key: 'pending', kind: 'pending', title: '待分组 · 请设置有效的导出张数', photos: selected });
      else getExportGroups(selected, count).forEach((photos, index) => {
        groups.push({ key: `page-${index}`, kind: 'page', title: `第 ${index + 1} 张拼图`, photos, pageIndex: index });
      });
    }
    if (excluded.length) groups.push({ key: 'excluded', kind: 'excluded', title: '未加入导出', photos: excluded });
    const activeKeys = new Set();
    for (const group of groups) {
      activeKeys.add(group.key);
      let view = groupViews.get(group.key);
      if (!view) {
        const section = document.createElement('section');
        section.className = 'export-page-group';
        section.dataset.groupKind = group.kind;
        if (group.kind === 'page') section.dataset.pageIndex = String(group.pageIndex);
        const heading = document.createElement('header');
        heading.className = 'export-page-heading';
        const title = document.createElement('h3');
        title.className = 'export-page-title';
        const total = document.createElement('span');
        total.className = 'export-page-count';
        const photoGrid = document.createElement('div');
        photoGrid.className = 'export-page-grid';
        heading.append(title, total);
        section.append(heading, photoGrid);
        view = { section, title, total, photoGrid };
        groupViews.set(group.key, view);
        grid.append(section);
      }
      view.title.textContent = group.title;
      view.total.textContent = `${group.photos.length} 张照片`;
      let position = view.photoGrid.firstElementChild;
      for (const photo of group.photos) {
        const node = drag?.started && drag.photoId === photo.id ? drag.placeholder : cards.get(photo.id);
        if (node !== position) view.photoGrid.insertBefore(node, position);
        position = node.nextElementSibling;
      }
    }
    for (const [key, view] of groupViews) {
      if (activeKeys.has(key)) continue;
      view.section.remove();
      groupViews.delete(key);
    }
    let position = grid.firstElementChild;
    for (const group of groups) {
      const section = groupViews.get(group.key).section;
      if (section !== position) grid.insertBefore(section, position);
      position = section.nextElementSibling;
    }
  }

  function getArrangementPhotos(id) {
    const photo = ordered.find(item => item.id === id);
    return ordered.filter(item => item.included === photo.included);
  }

  function updateArrangement() {
    dialog.style.setProperty('--export-columns', columnsField.value);
    const visible = selectedPhotoId ? getArrangementPhotos(selectedPhotoId) : [];
    const selectedIndex = visible.findIndex(photo => photo.id === selectedPhotoId);
    const blocked = !ready || exporting || Boolean(drag);
    selectionLabel.textContent = selectedIndex < 0 ? '点击照片，选择要移动的内容' : `${visible[selectedIndex].included ? '导出照片' : '未加入导出区'} · 已选第 ${selectedIndex + 1} / ${visible.length} 张`;
    positionInput.value = selectedIndex < 0 ? '' : String(selectedIndex + 1);
    positionInput.max = String(visible.length);
    positionInput.setCustomValidity('');
    for (const control of positionForm.elements) control.disabled = blocked || selectedIndex < 0;
    for (const button of moveButtons) {
      const towardStart = button.dataset.exportMove === 'first' || button.dataset.exportMove === 'previous';
      button.disabled = blocked || selectedIndex < 0 || (towardStart ? selectedIndex === 0 : selectedIndex === visible.length - 1);
    }
    let includedPosition = 0;
    let excludedPosition = 0;
    ordered.forEach(photo => {
      const position = photo.included ? ++includedPosition : ++excludedPosition;
      const label = photo.included ? `第 ${position} 张导出照片` : `未加入导出区第 ${position} 张照片`;
      const card = cards.get(photo.id);
      card.classList.toggle('is-selected', photo.id === selectedPhotoId);
      card.classList.toggle('is-excluded', !photo.included);
      const preview = card.querySelector('.export-photo-preview');
      preview.disabled = !ready || exporting;
      preview.setAttribute('aria-label', `选择${label} ${photo.title}`);
      preview.setAttribute('aria-pressed', String(photo.id === selectedPhotoId));
      card.querySelector('.export-photo-position').textContent = String(position);
      card.querySelector('.export-photo-include').disabled = blocked;
      const handle = card.querySelector('.export-photo-drag-handle');
      handle.disabled = !ready || exporting;
      handle.setAttribute('aria-label', `调整${label}的位置`);
    });
    updateGroups();
  }

  function updatePreview() {
    if (!ready || exporting) return;
    const selected = ordered.filter(photo => photo.included);
    const maximumWidth = Number(widthField.value);
    const columns = Number(columnsField.value);
    const gap = Number(form.elements.namedItem('gap').value);
    pageCountField.max = String(Math.max(1, selected.length));
    const count = pageCountField.valueAsNumber;
    const validCount = Number.isInteger(count) && count >= 1 && count <= selected.length;
    const countError = selected.length && !validCount ? `导出张数请输入 1 到 ${selected.length} 之间的整数。` : '';
    pageCountField.setCustomValidity(countError);
    updateGroups();
    pages = [];
    outputWidth = maximumWidth;
    if (selected.length && validCount) {
      const ratios = selected.map(photo => { const bitmap = thumbnails.get(photo.id); return bitmap.width / bitmap.height; }).sort((a, b) => a - b);
      const ratio = form.elements.namedItem('ratio').value === 'auto' ? ratios[Math.floor(ratios.length / 2)] : Number(form.elements.namedItem('ratio').value);
      const layout = createExportPages(selected, { count, columns, width: maximumWidth, gap, ratio });
      pages = layout.pages;
      outputWidth = layout.width;
    }
    pageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
    const previewScale = pages.length ? Math.min(800 / outputWidth, 1600 / pages[pageIndex].height) : 1;
    canvas.width = pages.length ? Math.max(1, Math.round(outputWidth * previewScale)) : 800;
    canvas.height = pages.length ? Math.max(1, Math.round(pages[pageIndex].height * previewScale)) : 400;
    const context = canvas.getContext('2d');
    context.fillStyle = form.elements.namedItem('background').value;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (pages.length) {
      context.save();
      context.scale(previewScale, previewScale);
      for (const cell of pages[pageIndex].cells) drawPhoto(context, thumbnails.get(cell.photo.id), cell);
      context.restore();
    }
    previous.disabled = pageIndex === 0;
    next.disabled = pageIndex >= pages.length - 1;
    pageLabel.textContent = pages.length ? `第 ${pageIndex + 1} 张 / 共 ${pages.length} 张` : '0 / 0';
    dialog.querySelector('.export-dimensions').textContent = pages.length ? `当前尺寸：${outputWidth} × ${pages[pageIndex].height} px${outputWidth < maximumWidth ? '（已自动适配）' : ''}` : '';
    dialog.querySelector('.export-page-summary').textContent = pages.length ? `本张含 ${pages[pageIndex].cells.length} 张照片` : '';
    download.disabled = !pages.length;
    download.textContent = `导出全部 ${pages.length} 张 · ZIP`;
    message.textContent = countError || (selected.length ? `已选 ${selected.length} 张照片，分为 ${pages.length} 张拼图${pages.length ? `，当前第 ${pageIndex + 1} 张含 ${pages[pageIndex].cells.length} 张照片` : ''}。` : '请至少勾选一张照片。');
    message.dataset.kind = countError ? 'error' : 'info';
  }

  function drawPhoto(context, bitmap, cell) {
    const scale = form.elements.namedItem('fit').value === 'cover'
      ? Math.max(cell.width / bitmap.width, cell.height / bitmap.height)
      : Math.min(cell.width / bitmap.width, cell.height / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.save();
    context.beginPath();
    context.rect(cell.x, cell.y, cell.width, cell.height);
    context.clip();
    context.drawImage(bitmap, cell.x + (cell.width - width) / 2, cell.y + (cell.height - height) / 2, width, height);
    context.restore();
  }

  function movePhoto(id, nextIndex) {
    const visible = getArrangementPhotos(id);
    const previousIndex = visible.findIndex(photo => photo.id === id);
    if (previousIndex === nextIndex) return;
    const [photo] = visible.splice(previousIndex, 1);
    visible.splice(nextIndex, 0, photo);
    // Reorder this visible category in its existing slots; preserve the other category.
    let index = 0;
    ordered = ordered.map(item => item.included === photo.included ? visible[index++] : item);
    updateArrangement();
    if (!drag) updatePreview();
  }

  function movePlaceholder() {
    const target = document.elementFromPoint(drag.x, drag.y);
    if (target?.closest('.export-photo-placeholder')) return;
    const card = target?.closest('.export-photo-card');
    let photoId;
    if (card && grid.contains(card)) {
      photoId = card.dataset.photoId;
    } else {
      const group = target?.closest('.export-page-group');
      if (!group || !grid.contains(group)) return;
      const photoGrid = group.querySelector('.export-page-grid');
      const node = target.closest('.export-page-heading') ? photoGrid.firstElementChild : photoGrid.lastElementChild;
      photoId = node.dataset.photoId;
    }
    const nextIndex = getArrangementPhotos(drag.photoId).findIndex(photo => photo.id === photoId);
    // Inclusion is controlled by the checkbox; a drag never adds or removes a photo.
    if (nextIndex < 0) return;
    movePhoto(drag.photoId, nextIndex);
  }

  function followDrag() {
    if (!drag?.started) return;
    const bounds = arrangePanel.getBoundingClientRect();
    const edge = 64;
    const speed = drag.y < bounds.top + edge ? -Math.min(14, (bounds.top + edge - drag.y) / 4)
      : drag.y > bounds.bottom - edge ? Math.min(14, (drag.y - bounds.bottom + edge) / 4) : 0;
    if (speed) arrangePanel.scrollBy({ top: speed, behavior: 'instant' });
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
        ordered = finished.order;
      }
      updatePreview();
    }
    updateArrangement();
  }

  for (const button of moveButtons) {
    button.addEventListener('click', () => {
      const visible = getArrangementPhotos(selectedPhotoId);
      const index = visible.findIndex(photo => photo.id === selectedPhotoId);
      const positions = { previous: index - 1, next: index + 1, first: 0, last: visible.length - 1 };
      movePhoto(selectedPhotoId, positions[button.dataset.exportMove]);
      cards.get(selectedPhotoId).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
  positionInput.addEventListener('input', () => positionInput.setCustomValidity(''));
  positionForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!ready || exporting || drag || !selectedPhotoId) return;
    const position = positionInput.valueAsNumber;
    const visible = getArrangementPhotos(selectedPhotoId);
    if (!Number.isInteger(position) || position < 1 || position > visible.length) {
      positionInput.setCustomValidity(`请输入 1 到 ${visible.length} 之间的整数。`);
      positionInput.reportValidity();
      return;
    }
    movePhoto(selectedPhotoId, position - 1);
    updateArrangement();
    cards.get(selectedPhotoId).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  grid.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.export-photo-drag-handle');
    if (!handle || !ready || exporting || drag || event.button !== 0) return;
    const card = handle.closest('.export-photo-card');
    selectedPhotoId = card.dataset.photoId;
    const bounds = card.getBoundingClientRect();
    drag = { pointerId: event.pointerId, photoId: card.dataset.photoId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top,
      bounds, order: ordered.slice(), started: false, placeholder: null };
    updateArrangement();
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
      drag.placeholder.className = 'export-photo-placeholder';
      drag.placeholder.dataset.photoId = drag.photoId;
      drag.placeholder.style.height = `${drag.bounds.height}px`;
      card.before(drag.placeholder);
      dialog.append(card);
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
    const handle = event.target.closest('.export-photo-drag-handle');
    if (!handle || !ready || exporting || drag) return;
    const id = handle.closest('.export-photo-card').dataset.photoId;
    const visible = getArrangementPhotos(id);
    const index = visible.findIndex(photo => photo.id === id);
    const columns = Number(columnsField.value);
    const movements = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns, Home: -index, End: visible.length - 1 - index };
    if (!(event.key in movements)) return;
    event.preventDefault();
    selectedPhotoId = id;
    const nextIndex = Math.max(0, Math.min(visible.length - 1, index + movements[event.key]));
    if (nextIndex === index) updateArrangement();
    else movePhoto(id, nextIndex);
    handle.focus();
  });
  window.addEventListener('resize', () => finishDrag(true), { signal: controller.signal });
  window.addEventListener('blur', () => finishDrag(true), { signal: controller.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishDrag(true); }, { signal: controller.signal });

  const tabs = [...dialog.querySelectorAll('.export-view-tabs [role="tab"]')];
  function selectView(index) {
    finishDrag(true);
    tabs.forEach((tab, tabIndex) => {
      const active = index === tabIndex;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      dialog.querySelector(`#${tab.getAttribute('aria-controls')}`).hidden = !active;
    });
  }
  tabs.forEach((tab, index) => tab.addEventListener('click', () => selectView(index)));
  dialog.querySelector('.export-view-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - tabs.indexOf(event.target);
    selectView(index);
    tabs[index].focus();
  });

  dialog.querySelector('.export-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    finishDrag(true);
    controller.abort();
    thumbnails.forEach(bitmap => bitmap.close());
    canvas.width = canvas.height = 1;
    dialog.remove();
  }, { once: true });
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('change', event => {
    if (event.target === columnsField) { finishDrag(true); updateArrangement(); }
    pageIndex = 0;
    updatePreview();
  });
  pageCountField.addEventListener('input', () => { pageIndex = 0; updatePreview(); });
  previous.addEventListener('click', () => { pageIndex--; updatePreview(); });
  next.addEventListener('click', () => { pageIndex++; updatePreview(); });
  download.addEventListener('click', async () => {
    finishDrag(false);
    if (exporting || !pages.length) return;
    exporting = true;
    message.dataset.kind = 'info';
    message.textContent = `正在准备导出全部 ${pages.length} 张拼图…`;
    dialog.querySelectorAll('input, select, button:not(.export-close)').forEach(control => { control.disabled = true; });
    const output = document.createElement('canvas');
    try {
      const { createZipArchive } = await import('/photo-export-zip.js?v=20261102-export-zip');
      controller.signal.throwIfAborted();
      const format = form.elements.namedItem('format').value;
      const extension = format === 'image/png' ? 'png' : 'jpg';
      const entries = [];
      const numberWidth = Math.max(2, String(pages.length).length);
      for (let exportIndex = 0; exportIndex < pages.length; exportIndex++) {
        controller.signal.throwIfAborted();
        const page = pages[exportIndex];
        output.width = outputWidth;
        output.height = page.height;
        const context = output.getContext('2d');
        if (!context) throw new Error('浏览器无法建立导出画布，请尝试降低导出宽度。');
        context.fillStyle = form.elements.namedItem('background').value;
        context.fillRect(0, 0, output.width, output.height);
        for (let index = 0; index < page.cells.length; index++) {
          const cell = page.cells[index];
          message.textContent = `正在生成第 ${exportIndex + 1} / ${pages.length} 张拼图，照片 ${index + 1} / ${page.cells.length}：${cell.photo.title}`;
          const response = await fetch(cell.photo.exportSrc || cell.photo.src, { signal: controller.signal });
          if (!response.ok) throw new Error(`无法读取「${cell.photo.title}」，请检查照片后重试。`);
          const thumbnail = thumbnails.get(cell.photo.id);
          const sourceRatio = thumbnail.width / thumbnail.height;
          const fit = form.elements.namedItem('fit').value;
          const targetWidth = fit === 'cover' ? Math.max(cell.width, cell.height * sourceRatio) : Math.min(cell.width, cell.height * sourceRatio);
          const bitmap = await createImageBitmap(await response.blob(), { resizeWidth: Math.max(1, Math.ceil(targetWidth)), resizeQuality: 'high' });
          try { controller.signal.throwIfAborted(); drawPhoto(context, bitmap, cell); }
          finally { bitmap.close(); }
        }
        const blob = await new Promise(resolve => output.toBlob(resolve, format, 0.96));
        if (!blob) throw new Error('生成图片失败，请降低导出宽度后重试。');
        controller.signal.throwIfAborted();
        entries.push({ name: `拼图-${String(exportIndex + 1).padStart(numberWidth, '0')}.${extension}`, blob });
        output.width = output.height = 1;
      }
      message.textContent = `正在将 ${pages.length} 张拼图打包为 ZIP…`;
      const blob = await createZipArchive(entries, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `旸隅-照片墙-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      message.textContent = `已生成包含 ${pages.length} 张 ${extension.toUpperCase()} 拼图的 ZIP。`;
    } catch (error) {
      if (!controller.signal.aborted) { message.textContent = error.message; message.dataset.kind = 'error'; }
    } finally {
      output.width = output.height = 1;
      exporting = false;
      form.querySelectorAll('input, select').forEach(control => { control.disabled = false; });
      if (dialog.open) {
        updateArrangement();
        tabs.forEach(tab => { tab.disabled = false; });
        previous.disabled = pageIndex === 0;
        next.disabled = pageIndex >= pages.length - 1;
        download.disabled = !pages.length;
      }
    }
  });
  updateArrangement();
  previous.disabled = next.disabled = true;
  dialog.showModal();
  (async () => {
    form.querySelectorAll('input, select').forEach(control => { control.disabled = true; });
    try {
      for (let index = 0; index < ordered.length; index++) {
        const photo = ordered[index];
        message.textContent = `正在准备预览 ${index + 1} / ${ordered.length}…`;
        const response = await fetch(photo.thumbnailSrc, { signal: controller.signal });
        if (!response.ok) throw new Error(`无法读取「${photo.title}」，请关闭后重试。`);
        const bitmap = await createImageBitmap(await response.blob(), { resizeWidth: 480, resizeQuality: 'high' });
        if (controller.signal.aborted) { bitmap.close(); return; }
        thumbnails.set(photo.id, bitmap);
      }
      ready = true;
      dialog.style.setProperty('--export-cell-ratio', `${Math.max(...[...thumbnails.values()].map(bitmap => bitmap.width))} / ${Math.max(...[...thumbnails.values()].map(bitmap => bitmap.height))}`);
      form.querySelectorAll('input, select').forEach(control => { control.disabled = false; });
      updateArrangement();
      updatePreview();
    } catch (error) {
      if (!controller.signal.aborted) { message.textContent = error.message; message.dataset.kind = 'error'; }
    }
  })();
}
