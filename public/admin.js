import { openPhotoExport } from '/api/admin/export';

const grid = document.querySelector('#photo-library');
const queue = document.querySelector('#upload-queue');
const uploadButton = document.querySelector('#upload-button');
const status = document.querySelector('#status');
const editDialog = document.querySelector('#edit-dialog');
const deleteDialog = document.querySelector('#delete-dialog');
const uploadDialog = document.querySelector('#upload-dialog');
const seriesDialog = document.querySelector('#series-dialog');
const deleteSeriesDialog = document.querySelector('#delete-series-dialog');
const selectedIds = new Set();
let photos = [];
let seriesList = [];
let seriesNames = new Map();
let editingSeriesId = null;
let deletingSeriesId = null;
let pendingFiles = [];
let activeSeries = 'all';
let selectedPhoto = null;
let pendingDeleteIds = [];
let busy = false;

async function requestJson(path, options = {}) {
  let response;
  try { response = await fetch(path, options); }
  catch { throw new Error('连接中断，请检查网络后重试。'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('服务暂时不可用，请刷新页面后重试。'); }
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showStatus(message, kind = 'success') {
  status.textContent = message;
  status.dataset.kind = kind;
  status.hidden = false;
  if (uploadDialog.open) {
    const progress = document.querySelector('#upload-progress');
    progress.textContent = message;
    progress.dataset.kind = kind;
    progress.hidden = false;
  }
  if (seriesDialog.open) {
    const feedback = document.querySelector('#series-feedback');
    feedback.textContent = message;
    feedback.dataset.kind = kind;
    feedback.hidden = false;
  }
}

function renderSeries() {
  seriesNames = new Map(seriesList.map(series => [series.id, series.name]));
  if (activeSeries !== 'all' && !seriesNames.has(activeSeries)) activeSeries = 'all';
  const tabs = document.querySelector('.series-tabs');
  tabs.replaceChildren();
  [{ id: 'all', name: '全部' }, ...seriesList].forEach(series => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `${series.id}-tab`;
    tab.dataset.series = series.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'library-results');
    tab.append(document.createTextNode(series.name), document.createElement('span'));
    tabs.append(tab);
  });
  for (const id of ['upload-series', 'edit-series', 'batch-series']) {
    const control = document.getElementById(id);
    const previous = control.value;
    control.replaceChildren();
    seriesList.forEach(series => control.add(new Option(id === 'batch-series' ? `移到${series.name}` : series.name, series.id)));
    if (seriesNames.has(previous)) control.value = previous;
  }
}

function renderSeriesManager() {
  const list = document.querySelector('#series-list');
  list.replaceChildren();
  seriesList.forEach((series, index) => {
    const row = document.createElement('div');
    row.className = 'series-item';
    row.dataset.id = series.id;
    const info = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = `${String(index + 1).padStart(2, '0')} / ${series.name}`;
    const count = document.createElement('span');
    count.textContent = `${photos.filter(photo => photo.series === series.id).length} 张照片`;
    info.append(name, count);
    if (series.description) {
      const description = document.createElement('p');
      description.textContent = series.description;
      info.append(description);
    }
    const actions = document.createElement('div');
    actions.className = 'series-item-actions';
    for (const [action, label] of [['edit', '编辑'], ['previous', '移前'], ['next', '移后'], ['delete', '删除系列']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action === 'delete' ? 'danger-outline' : 'secondary';
      button.dataset.seriesAction = action;
      button.textContent = label;
      button.disabled = busy || (action === 'previous' && index === 0) || (action === 'next' && index === seriesList.length - 1);
      actions.append(button);
    }
    row.append(info, actions);
    list.append(row);
  });
  const requiresMove = photos.some(photo => photo.series === deletingSeriesId);
  document.querySelector('#confirm-delete-series').disabled = busy || !deletingSeriesId || (requiresMove && !document.querySelector('#delete-series-target').value);
}

function resetSeriesEditor() {
  editingSeriesId = null;
  document.querySelector('#series-form').reset();
  document.querySelector('#series-submit').textContent = '新建系列';
  document.querySelector('#series-cancel-edit').hidden = true;
  document.querySelector('#series-feedback').hidden = true;
}

function visiblePhotos() {
  const query = document.querySelector('#photo-search').value.trim().toLocaleLowerCase();
  return photos.filter(photo => (activeSeries === 'all' || photo.series === activeSeries)
    && `${photo.title} ${photo.alt}`.toLocaleLowerCase().includes(query));
}

function renderSelection() {
  const visible = visiblePhotos();
  const visibleSelected = visible.filter(photo => selectedIds.has(photo.id)).length;
  const all = document.querySelector('#select-all');
  all.checked = visible.length > 0 && visibleSelected === visible.length;
  all.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  all.disabled = busy || !visible.length;
  document.querySelector('#select-all-label').textContent = `全选当前 ${visible.length} 张`;
  document.querySelector('#selected-count').textContent = `已选 ${selectedIds.size} 张${selectedIds.size > visibleSelected ? `（当前列表 ${visibleSelected} 张）` : ''}`;
  for (const id of ['clear-selection', 'batch-move', 'batch-delete', 'batch-series', 'batch-export']) {
    document.getElementById(id).disabled = busy || !selectedIds.size;
  }
  grid.querySelectorAll('.admin-photo').forEach(row => {
    const selected = selectedIds.has(row.dataset.id);
    row.classList.toggle('is-selected', selected);
    row.querySelector('input[type="checkbox"]').checked = selected;
  });
}

function renderPhotos() {
  grid.replaceChildren();
  const displayed = visiblePhotos();
  document.querySelector('#total-count').textContent = `共 ${photos.length} 张照片`;
  document.querySelector('#library-results').setAttribute('aria-labelledby', `${activeSeries}-tab`);
  document.querySelectorAll('[data-series]').forEach(tab => {
    tab.querySelector('span').textContent = tab.dataset.series === 'all' ? photos.length : photos.filter(photo => photo.series === tab.dataset.series).length;
    const selected = tab.dataset.series === activeSeries;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  if (!displayed.length) {
    const row = document.createElement('tr');
    const empty = document.createElement('td');
    empty.colSpan = 6;
    empty.className = 'empty-state';
    empty.textContent = photos.length ? '没有符合筛选条件的照片。' : '照片库为空，点击「上传照片」添加作品。';
    row.append(empty);
    grid.append(row);
  }
  displayed.forEach(photo => {
    const seriesPhotos = photos.filter(item => item.series === photo.series);
    const index = seriesPhotos.findIndex(item => item.id === photo.id);
    const card = document.createElement('tr');
    card.className = 'admin-photo';
    card.dataset.id = photo.id;
    card.innerHTML = '<td class="photo-selection"><input type="checkbox"></td><td class="admin-photo-image"><button type="button" data-action="preview"><img loading="lazy"></button></td><td class="photo-details"><h3 class="photo-title"></h3><p class="photo-alt"></p><span class="photo-badge"></span><span class="wall-hidden-badge"></span></td><td class="photo-series"></td><td class="photo-position"></td><td class="photo-actions"><button type="button" data-action="download">下载原图</button><button type="button" data-action="edit">编辑</button><button type="button" data-action="previous">移前</button><button type="button" data-action="next">移后</button><button type="button" data-action="delete">删除</button></td>';
    const checkbox = card.querySelector('input');
    checkbox.disabled = busy;
    checkbox.setAttribute('aria-label', `选择照片 ${photo.title}`);
    const image = card.querySelector('img');
    image.src = photo.thumbnailSrc;
    image.alt = photo.alt;
    card.querySelector('[data-action="preview"]').setAttribute('aria-label', `完整预览 ${photo.title}`);
    const download = card.querySelector('[data-action="download"]');
    download.hidden = !photo.downloadSrc;
    download.setAttribute('aria-label', `下载原图 ${photo.title}`);
    card.querySelector('.photo-title').textContent = photo.title;
    const description = card.querySelector('.photo-alt');
    description.textContent = photo.alt;
    description.hidden = !photo.alt || photo.alt === photo.title;
    const badge = card.querySelector('.photo-badge');
    badge.hidden = !photo.isSample;
    badge.textContent = '示例照片';
    const wallBadge = card.querySelector('.wall-hidden-badge');
    wallBadge.hidden = photo.showOnWall;
    wallBadge.textContent = '未加入照片墙';
    card.querySelector('.photo-series').textContent = seriesNames.get(photo.series);
    card.querySelector('.photo-position').textContent = index === 0 ? '封面 / 01' : String(index + 1).padStart(2, '0');
    card.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    card.querySelector('[data-action="previous"]').disabled = busy || index === 0;
    card.querySelector('[data-action="next"]').disabled = busy || index === seriesPhotos.length - 1;
    grid.append(card);
  });
  renderSelection();
}

function renderQueue() {
  queue.replaceChildren();
  pendingFiles.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    const image = document.createElement('img');
    image.src = entry.preview;
    image.alt = '';
    const info = document.createElement('div');
    info.className = 'queue-info';
    info.textContent = entry.file.name;
    const size = document.createElement('small');
    size.textContent = `${(entry.file.size / 1024 / 1024).toFixed(1)} MB`;
    info.append(size);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button';
    remove.textContent = '×';
    remove.disabled = busy;
    remove.setAttribute('aria-label', `移除待上传照片 ${entry.file.name}`);
    remove.addEventListener('click', async () => {
      if (busy) return;
      setBusy(true);
      try {
        if (entry.upload) await requestJson('/api/admin/uploads', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.upload.id }) });
        URL.revokeObjectURL(entry.preview);
        pendingFiles.splice(index, 1);
      } catch (error) { showStatus(error.message, 'error'); }
      finally { setBusy(false); }
    });
    item.append(image, info, remove);
    queue.append(item);
  });
  uploadButton.disabled = busy || pendingFiles.length === 0;
  uploadButton.textContent = pendingFiles.length ? `上传 ${pendingFiles.length} 张照片` : '上传照片';
  document.querySelector('#clear-queue').disabled = busy || !pendingFiles.length;
}

function setBusy(value) {
  busy = value;
  document.body.dataset.photoBusy = String(value);
  document.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = value; });
  renderPhotos();
  renderQueue();
  document.querySelector('#confirm-delete').disabled = value || !pendingDeleteIds.length;
  renderSeriesManager();
  document.querySelector('#open-upload').disabled = value || document.body.dataset.subscriptionExpired === 'true';
}

async function loadPhotos() {
  const data = await requestJson('/api/admin/photos');
  photos = data.photos;
  seriesList = data.series;
  renderSeries();
  renderSeriesManager();
  const currentIds = new Set(photos.map(photo => photo.id));
  for (const id of selectedIds) if (!currentIds.has(id)) selectedIds.delete(id);
  pendingDeleteIds = pendingDeleteIds.filter(id => currentIds.has(id));
  renderPhotos();
}

function renderDeleteConfirmation() {
  document.querySelector('#delete-heading').textContent = `删除 ${pendingDeleteIds.length} 张照片？`;
  document.querySelector('#confirm-delete').textContent = `确认删除 ${pendingDeleteIds.length} 张`;
  document.querySelector('#confirm-delete').disabled = busy || !pendingDeleteIds.length;
  const preview = document.querySelector('#delete-preview');
  preview.replaceChildren();
  const deleting = photos.filter(photo => pendingDeleteIds.includes(photo.id));
  deleting.slice(0, 12).forEach(photo => {
    const item = document.createElement('li');
    const image = document.createElement('img');
    image.src = photo.src;
    image.alt = '';
    const title = document.createElement('span');
    title.textContent = photo.title;
    item.append(image, title);
    preview.append(item);
  });
  if (deleting.length > 12) {
    const remaining = document.createElement('li');
    remaining.textContent = `另有 ${deleting.length - 12} 张照片`;
    preview.append(remaining);
  }
}

async function applyBatch(action, ids, series) {
  if (!ids.length || busy) return;
  const total = ids.length;
  let completed = 0;
  if (action === 'delete') ids.forEach(id => selectedIds.add(id));
  setBusy(true);
  try {
    for (let offset = 0; offset < total; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      showStatus(`正在${action === 'delete' ? '删除' : '移动'}照片：${completed} / ${total}`);
      await requestJson('/api/admin/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ids: chunk, ...(action === 'move' ? { series } : {}) }) });
      completed += chunk.length;
      chunk.forEach(id => selectedIds.delete(id));
      if (action === 'delete') pendingDeleteIds = pendingDeleteIds.filter(id => !chunk.includes(id));
      renderSelection();
    }
    if (action === 'delete') deleteDialog.close();
    await loadPhotos();
    showStatus(action === 'delete' ? `已删除 ${completed} 张照片，作品集已更新。`
      : `已将 ${completed} 张照片归入「${seriesNames.get(series)}」。`);
  } catch (error) {
    let message = `已确认完成 ${completed} 张。${error.message}`;
    try { await loadPhotos(); } catch (reloadError) { message += ` ${reloadError.message}`; }
    showStatus(`${message} ${completed < total ? '未完成的照片仍保留选择，请核对后重试。' : '照片已处理，请刷新照片库查看结果。'}`, 'error');
    if (deleteDialog.open) {
      if (!pendingDeleteIds.length) deleteDialog.close();
      else {
        renderDeleteConfirmation();
        const field = document.querySelector('#delete-error');
        field.textContent = message;
        field.hidden = false;
      }
    }
  } finally { setBusy(false); }
}

function addFiles(files) {
  const rejected = [];
  for (const file of files) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || !file.size) {
      rejected.push(file.name);
      continue;
    }
    pendingFiles.push({ file, preview: URL.createObjectURL(file) });
  }
  renderQueue();
  if (rejected.length) showStatus(`未添加 ${rejected.join('、')}。请选择有效的 JPG、PNG、WebP 或 GIF 图片。`, 'error');
}

document.querySelector('#file-input').addEventListener('change', event => {
  addFiles(event.target.files);
  event.target.value = '';
});
const dropZone = document.querySelector('#drop-zone');
dropZone.addEventListener('dragover', event => { event.preventDefault(); if (!busy) dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  if (!busy) addFiles(event.dataTransfer.files);
});
const seriesTabs = document.querySelector('.series-tabs');
seriesTabs.addEventListener('click', event => {
  const tab = event.target.closest('[data-series]');
  if (!tab || busy) return;
  activeSeries = tab.dataset.series;
  renderPhotos();
});
seriesTabs.addEventListener('keydown', event => {
  const tab = event.target.closest('[data-series]');
  if (!tab || busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...seriesTabs.querySelectorAll('[data-series]')];
  const index = tabs.indexOf(tab);
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex].click();
  tabs[nextIndex].focus();
});
document.querySelector('#manage-series').addEventListener('click', () => {
  resetSeriesEditor();
  seriesDialog.showModal();
});

document.querySelector('#upload-new-series').addEventListener('click', () => {
  resetSeriesEditor();
  seriesDialog.showModal();
  document.querySelector('#series-name').focus();
});

document.querySelector('#series-cancel-edit').addEventListener('click', resetSeriesEditor);
document.querySelector('#new-series').addEventListener('click', () => {
  resetSeriesEditor();
  document.querySelector('#series-name').focus();
});

document.querySelector('#series-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const isNew = editingSeriesId === null;
  const body = { ...(isNew ? {} : { id: editingSeriesId }), name: document.querySelector('#series-name').value, description: document.querySelector('#series-description').value };
  setBusy(true);
  try {
    const data = await requestJson('/api/admin/series', { method: isNew ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    seriesList = data.series;
    if (isNew) activeSeries = data.id;
    renderSeries();
    if (isNew) {
      document.querySelector('#upload-series').value = data.id;
      document.querySelector('#batch-series').value = data.id;
    }
    resetSeriesEditor();
    showStatus(isNew ? '系列已创建，可直接上传或批量移入照片。' : '系列信息已保存，作品集已同步更新。');
  } catch (error) { showStatus(error.message, 'error'); }
  finally { setBusy(false); }
});
document.querySelector('#series-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-series-action]');
  if (!button || busy) return;
  const id = button.closest('.series-item').dataset.id;
  const index = seriesList.findIndex(series => series.id === id);
  if (button.dataset.seriesAction === 'delete') {
    deletingSeriesId = id;
    const count = photos.filter(photo => photo.series === id).length;
    const destinations = seriesList.filter(series => series.id !== id);
    document.querySelector('#delete-series-heading').textContent = `删除「${seriesList[index].name}」？`;
    document.querySelector('#delete-series-summary').textContent = count
      ? `这个系列有 ${count} 张照片。${destinations.length ? '请选择接收照片的系列，再删除当前系列。' : '请先新建一个系列接收照片。'}`
      : '删除这个空系列后，首页导航也会同步移除。';
    const target = document.querySelector('#delete-series-target');
    target.replaceChildren(new Option('仅删除空系列，不移动照片', ''));
    destinations.forEach(series => target.add(new Option(series.name, series.id)));
    if (count && destinations.length) target.value = destinations[0].id;
    document.querySelector('#delete-series-destination').hidden = !count && !destinations.length;
    document.querySelector('#delete-series-error').hidden = true;
    renderSeriesManager();
    deleteSeriesDialog.showModal();
    return;
  }
  if (button.dataset.seriesAction === 'edit') {
    editingSeriesId = id;
    document.querySelector('#series-name').value = seriesList[index].name;
    document.querySelector('#series-description').value = seriesList[index].description;
    document.querySelector('#series-submit').textContent = '保存修改';
    document.querySelector('#series-cancel-edit').hidden = false;
    document.querySelector('#series-name').focus();
    return;
  }
  const ordered = [...seriesList];
  const destination = index + (button.dataset.seriesAction === 'previous' ? -1 : 1);
  [ordered[index], ordered[destination]] = [ordered[destination], ordered[index]];
  setBusy(true);
  try {
    const data = await requestJson('/api/admin/series', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ordered.map(series => series.id) }) });
    seriesList = data.series;
    renderSeries();
    showStatus('系列顺序已保存，首页导航和作品展示会同步调整。');
  } catch (error) { showStatus(error.message, 'error'); }
  finally { setBusy(false); }
});
document.querySelector('#delete-series-target').addEventListener('change', renderSeriesManager);
document.querySelector('#confirm-delete-series').addEventListener('click', async () => {
  if (busy || !deletingSeriesId) return;
  const id = deletingSeriesId;
  const moveTo = document.querySelector('#delete-series-target').value;
  setBusy(true);
  try {
    const data = await requestJson('/api/admin/series', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...(moveTo ? { moveTo } : {}) }) });
    deletingSeriesId = null;
    if (editingSeriesId === id) resetSeriesEditor();
    deleteSeriesDialog.close();
    await loadPhotos();
    showStatus(data.moved ? `系列已删除，${data.moved} 张照片已移入「${seriesNames.get(moveTo)}」。` : '系列已删除，首页已同步更新。');
  } catch (error) {
    document.querySelector('#delete-series-error').textContent = error.message;
    document.querySelector('#delete-series-error').hidden = false;
    showStatus(error.message, 'error');
  } finally { setBusy(false); }
});

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); }));
document.querySelector('#photo-search').addEventListener('input', renderPhotos);
grid.addEventListener('change', event => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox || busy) return;
  const id = checkbox.closest('.admin-photo').dataset.id;
  if (checkbox.checked) selectedIds.add(id); else selectedIds.delete(id);
  renderSelection();
});
document.querySelector('#select-all').addEventListener('change', event => {
  visiblePhotos().forEach(photo => { if (event.target.checked) selectedIds.add(photo.id); else selectedIds.delete(photo.id); });
  renderSelection();
});
document.querySelector('#clear-selection').addEventListener('click', () => { selectedIds.clear(); renderSelection(); });

document.querySelector('#batch-export').addEventListener('click', () => {
  if (!busy) openPhotoExport(photos.filter(photo => selectedIds.has(photo.id)));
});
document.querySelector('#batch-move').addEventListener('click', () => applyBatch('move', photos.filter(photo => selectedIds.has(photo.id)).map(photo => photo.id), document.querySelector('#batch-series').value));
document.querySelector('#batch-delete').addEventListener('click', () => {
  pendingDeleteIds = photos.filter(photo => selectedIds.has(photo.id)).map(photo => photo.id);
  renderDeleteConfirmation();
  document.querySelector('#delete-error').hidden = true;
  deleteDialog.showModal();
});
document.querySelector('#open-upload').addEventListener('click', () => {
  document.querySelector('#upload-progress').hidden = true;
  if (activeSeries !== 'all') document.querySelector('#upload-series').value = activeSeries;
  uploadDialog.showModal();
});
document.querySelector('#clear-queue').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    while (pendingFiles.length) {
      const entry = pendingFiles[0];
      if (entry.upload) await requestJson('/api/admin/uploads', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.upload.id }) });
      URL.revokeObjectURL(entry.preview);
      pendingFiles.shift();
    }
  } catch (error) { showStatus(error.message, 'error'); }
  finally { setBusy(false); }
});

document.querySelector('#upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingFiles.length || busy) return;
  const series = document.querySelector('#upload-series').value;
  const total = pendingFiles.length;
  let uploaded = 0;
  setBusy(true);
  try {
    while (pendingFiles.length) {
      const entry = pendingFiles[0];
      showStatus(`正在上传 ${uploaded + 1} / ${total}：${entry.file.name}`);
      const title = entry.file.name.replace(/\.[^.]+$/, '').trim().slice(0, 120);
      if (entry.upload && entry.upload.series !== series) {
        await requestJson('/api/admin/uploads', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.upload.id }) });
        entry.upload = null;
      }
      if (!entry.upload) {
        entry.upload = await requestJson('/api/admin/uploads', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ series, title: title || '未命名作品', contentType: entry.file.type, size: entry.file.size }),
        });
        entry.upload.parts = [];
        entry.upload.series = series;
      }
      const { id, partSize, parts } = entry.upload;
      for (let offset = parts.length * partSize; offset < entry.file.size; offset += partSize) {
        const partNumber = Math.floor(offset / partSize) + 1;
        for (let attempt = 0; ; attempt++) {
          try {
            showStatus(`正在上传 ${uploaded + 1} / ${total}：${entry.file.name} · ${Math.floor(offset / entry.file.size * 100)}%${attempt ? ' · 重试当前分块' : ''}`);
            const part = await requestJson(`/api/admin/uploads?id=${encodeURIComponent(id)}&part=${partNumber}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: entry.file.slice(offset, offset + partSize) });
            parts.push(part);
            break;
          } catch (error) {
            if (attempt >= 2 || (error.status && error.status < 500)) throw error;
          }
        }
      }
      showStatus(`正在保存 ${uploaded + 1} / ${total}：${entry.file.name}`);
      await requestJson('/api/admin/uploads', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, parts }) });
      URL.revokeObjectURL(entry.preview);
      pendingFiles.shift();
      uploaded++;
      renderQueue();
    }
    activeSeries = series;
    document.querySelector('#photo-search').value = '';
    uploadDialog.close();
    await loadPhotos();
    showStatus(`已上传 ${uploaded} 张照片，作品集已更新。`);
  } catch (error) {
    showStatus(`已上传 ${uploaded} 张。${error.message} 尚未完成的照片保留在待上传列表中。`, 'error');
    try { await loadPhotos(); } catch (reloadError) { showStatus(`${error.message} ${reloadError.message}`, 'error'); }
  } finally { setBusy(false); }
});

grid.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button || busy) return;
  const id = button.closest('.admin-photo').dataset.id;
  const photo = photos.find(item => item.id === id);
  selectedPhoto = photo;
  if (button.dataset.action === 'download') {
    const link = document.createElement('a');
    link.href = photo.downloadSrc;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
    return;
  }
  if (button.dataset.action === 'preview') {
    document.querySelector('#preview-image').src = photo.src;
    document.querySelector('#preview-image').alt = photo.alt;
    document.querySelector('#preview-heading').textContent = photo.title;
    document.querySelector('#preview-dialog').showModal();
    return;
  }
  if (button.dataset.action === 'edit') {
    document.querySelector('#edit-image').src = photo.src;
    document.querySelector('#edit-image').alt = photo.alt;
    document.querySelector('#edit-title').value = photo.title;
    document.querySelector('#edit-series').value = photo.series;
    document.querySelector('#edit-alt').value = photo.alt;
    document.querySelector('#edit-show-on-wall').checked = photo.showOnWall;
    document.querySelector('#edit-error').hidden = true;
    editDialog.showModal();
    return;
  }
  if (button.dataset.action === 'delete') {
    pendingDeleteIds = [photo.id];
    renderDeleteConfirmation();
    document.querySelector('#delete-error').hidden = true;
    deleteDialog.showModal();
    return;
  }
  const seriesPhotos = photos.filter(item => item.series === photo.series);
  const index = seriesPhotos.findIndex(item => item.id === id);
  const destination = index + (button.dataset.action === 'previous' ? -1 : 1);
  [seriesPhotos[index], seriesPhotos[destination]] = [seriesPhotos[destination], seriesPhotos[index]];
  setBusy(true);
  try {
    await requestJson('/api/admin/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ series: photo.series, ids: seriesPhotos.map(item => item.id) }) });
    await loadPhotos();
    showStatus('展示顺序已保存，系列封面也会同步更新。');
  } catch (error) { showStatus(error.message, 'error'); }
  finally { setBusy(false); }
});

document.querySelector('#edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const body = { id: selectedPhoto.id, title: document.querySelector('#edit-title').value, series: document.querySelector('#edit-series').value, alt: document.querySelector('#edit-alt').value, showOnWall: document.querySelector('#edit-show-on-wall').checked };
  setBusy(true);
  try {
    await requestJson('/api/admin/photos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    activeSeries = body.series;
    editDialog.close();
    await loadPhotos();
    showStatus('照片信息已保存。');
  } catch (error) {
    const message = document.querySelector('#edit-error');
    message.textContent = error.message;
    message.hidden = false;
    showStatus(error.message, 'error');
  } finally { setBusy(false); }
});

document.querySelector('#confirm-delete').addEventListener('click', () => applyBatch('delete', [...pendingDeleteIds]));

document.querySelector('#reload').addEventListener('click', async () => {
  setBusy(true);
  try {
    await requestJson('/api/admin/initialize', { method: 'POST' });
    await loadPhotos();
    showStatus('照片库已刷新。');
  } catch (error) { showStatus(error.message, 'error'); }
  finally { setBusy(false); }
});

(async () => {
  setBusy(true);
  try { await requestJson('/api/admin/initialize', { method: 'POST' }); await loadPhotos(); }
  catch (error) { showStatus(error.message, 'error'); }
  finally { setBusy(false); }
})();
