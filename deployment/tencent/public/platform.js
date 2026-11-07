/* eslint-disable @next/next/no-location-assign-relative-destination -- Standalone Node client; no Next.js client router is mounted. */
import { renderNoteMarkdown } from '/note-markdown.js?v=20261101-markdown';

const app = document.querySelector('#platform-app');
const body = document.querySelector('#platform-body');
const feedback = document.querySelector('#platform-feedback');
let noteListBusy = false;
let noteListRequest = 0;
let noteImageExportRetry = 0;

const escapeHtml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function bytes(value) {
  if (value < 1024) return `${value} B`;
  const unit = Math.min(Math.floor(Math.log(value)/Math.log(1024)),4);
  return `${(value/1024**unit).toFixed(unit > 1 ? 2 : 0)} ${['B','KiB','MiB','GiB','TiB'][unit]}`;
}
const date = value => value === null || value === undefined ? '长期有效' : new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
function notify(message, error = false) {
  feedback.textContent = message;
  feedback.className = `form-message${error ? ' error' : ''}`;
  feedback.hidden = false;
  const openDialog=document.querySelector('dialog[open]');
  if(openDialog){
    let dialogFeedback=openDialog.querySelector('.dialog-feedback');
    if(!dialogFeedback){dialogFeedback=document.createElement('p');dialogFeedback.setAttribute('role','status');openDialog.querySelector('.dialog-heading').after(dialogFeedback);}
    dialogFeedback.className=`dialog-feedback form-message${error ? ' error' : ''}`;
    dialogFeedback.textContent=message;
  }
}
async function api(path, method = 'GET', data) {
  const binary = data instanceof Blob;
  const options = { method, headers: data === undefined ? {} : { 'Content-Type': binary ? data.type : 'application/json' } };
  if (data !== undefined) options.body = binary ? data : JSON.stringify(data);
  let response;
  try { response = await fetch(path,options); }
  catch { throw new Error('连接失败，请检查网络后重试。'); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('服务暂时不可用，请稍后重试。'); }
  if (!response.ok) {
    if (response.status === 401) location.assign('/login');
    throw new Error(result.error);
  }
  return result;
}
function dialog(content) {
  const element = document.createElement('dialog');
  element.className = 'modern-dialog';
  element.innerHTML = content;
  document.body.append(element);
  element.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>element.close()));
  element.addEventListener('close',()=>element.remove(),{once:true});
  element.showModal();
  return element;
}
const dialogHeading = title => `<div class="dialog-heading"><h2>${title}</h2><button type="button" class="dialog-close" data-close aria-label="关闭">×</button></div>`;

async function overview() {
  const data = await api('/api/platform/overview');
  const system = data.system;
  const resource = (label,used,total,note) => `<div class="resource-row"><div class="resource-label"><span>${label}</span><span>${bytes(used)} / ${bytes(total)}</span></div><div class="meter"><span style="width:${Math.round(used/total*100)}%"></span></div><p class="resource-note">${note}</p></div>`;
  body.innerHTML = `<div class="stat-grid">
    <article class="stat-card"><span class="stat-label">摄影师账户</span><strong>${data.accountCount}</strong><small>${data.activeAccountCount} 个已启用</small></article>
    <article class="stat-card"><span class="stat-label">已存照片</span><strong>${data.photoCount}</strong><small>含回收站账户保留的照片</small></article>
    <article class="stat-card"><span class="stat-label">照片与资料图片</span><strong>${bytes(data.storageBytes)}</strong><small>${data.storageComplete ? '已核对图片文件大小' : '历史照片容量核对中'}</small></article>
    <article class="stat-card"><span class="stat-label">待完成上传</span><strong>${bytes(data.pendingBytes)}</strong><small>已为上传任务预留容量</small></article>
    </div><div class="resource-grid"><section class="panel"><div class="panel-heading"><h2>服务器资源</h2><button class="button ghost" id="refresh-overview">刷新</button></div>
    ${resource('系统内存',system.usedMemoryBytes,system.totalMemoryBytes,'Linux 使用可用内存计算，排除可回收缓存。')}
    ${resource('服务器磁盘',system.usedDiskBytes,system.totalDiskBytes,data.storageBackend === 'local' ? '本地模式：服务器磁盘含系统、数据库、备份和照片原件。' : 'COS 模式：服务器磁盘含系统、数据库和本地备份；照片原件存储在 COS。')}
    <div class="resource-row"><div class="resource-label"><span>网站进程内存</span><span>${bytes(system.appMemoryBytes)}</span></div><p class="resource-note">服务器已运行 ${Math.floor(system.uptimeSeconds/3600)} 小时。</p></div></section>
    <section class="panel"><div class="panel-heading"><h2>网络流量</h2><span class="badge">服务器自启动累计</span></div><div class="traffic-values"><div><small>接收</small><strong>${system.network ? bytes(system.network.receivedBytes) : '当前系统不提供'}</strong></div><div><small>发送</small><strong>${system.network ? bytes(system.network.sentBytes) : '当前系统不提供'}</strong></div></div><div class="info-note">${escapeHtml(data.cloudTraffic.explanation)}</div></section></div>`;
  document.querySelector('#refresh-overview').addEventListener('click',()=>overview().catch(error=>notify(error.message,true)));
}

function drawVisitsChart(container, days, width) {
  const height = 238;
  const top = 14;
  const bottom = height - 34;
  const left = 60;
  const right = width - 24;
  const maximum = Math.max(...days.map(day => day.visitors));
  const step = Math.max(1, Math.ceil(maximum / 4));
  const y = value => Math.round(bottom - (value / (step * 4)) * (bottom - top));
  const points = days.map((day, index) => ({
    ...day,
    x: Math.round(days.length === 1 ? (left + right) / 2 : left + (index / (days.length - 1)) * (right - left)),
    y: y(day.visitors)
  }));
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = index * step;
    const lineY = y(value);
    return `<line class="visits-gridline" x1="${left}" y1="${lineY}" x2="${right}" y2="${lineY}"/><text x="${left - 10}" y="${lineY + 4}" text-anchor="end">${value.toLocaleString('zh-CN')}</text>`;
  }).join('');
  const tickCount = Math.min(points.length, width < 420 ? 3 : width < 680 ? 4 : 6);
  const ticks = Array.from({ length: tickCount }, (_, index) => {
    const point = points[tickCount === 1 ? 0 : Math.round(index * (points.length - 1) / (tickCount - 1))];
    const label = point.date.slice(5).replace('-', '/');
    return `<text x="${point.x}" y="${bottom + 23}" text-anchor="middle">${escapeHtml(label)}</text>`;
  }).join('');
  const coordinates = points.map(point => `${point.x},${point.y}`).join(' ');
  const first = points[0];
  const last = points.at(-1);
  const line = points.length > 1 ? `
    <polygon class="visits-area" points="${first.x},${bottom} ${coordinates} ${last.x},${bottom}"/>
    <polyline class="visits-line" points="${coordinates}"/>` : '';
  const markers = (points.length <= 14 ? points : [last]).map(point => `
    <circle class="visits-point" cx="${point.x}" cy="${point.y}" r="3.5"><title>${escapeHtml(point.date)} · ${point.visitors.toLocaleString('zh-CN')} 人</title></circle>`).join('');
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="visits-svg-title visits-svg-description" data-point-count="${points.length}">
    <title id="visits-svg-title">每日访问人数曲线</title>
    <desc id="visits-svg-description">${escapeHtml(first.date)} 至 ${escapeHtml(last.date)}。最高单日 ${maximum.toLocaleString('zh-CN')} 人。各日人数见每日明细。</desc>
    ${grid}${line}${markers}${ticks}
  </svg>`;
}

async function visits() {
  const admin = app.hasAttribute('data-visits-admin');
  body.innerHTML = `<section class="panel visits-panel" aria-labelledby="visits-title">
    <div class="panel-heading visits-heading">
      <div><h2 id="visits-title">每日访问人数</h2><p id="visits-method">按北京时间统计，读取服务器保存的每日汇总。</p></div>
      <div class="visits-filters">
        ${admin ? '<label>统计范围<select id="visits-scope" disabled><option value="">全站</option></select></label>' : ''}
        <label>时间范围<select id="visits-range"><option value="7">最近 7 天</option><option value="30" selected>最近 30 天</option><option value="90">最近 90 天</option></select></label>
        <button type="button" class="button secondary" id="visits-refresh">刷新</button>
      </div>
    </div>
    <div class="visits-summary">
      <article class="stat-card"><span class="stat-label">今日访问人数</span><strong id="visits-today">—</strong><small id="visits-today-date">北京时间</small></article>
      <article class="stat-card"><span class="stat-label">每日人数合计</span><strong id="visits-total">—</strong><small>所选时段的每日人数相加</small></article>
    </div>
    <p id="visits-status" class="visits-status" role="status"></p>
    <div id="visits-chart" class="visits-chart" hidden></div>
    <details id="visits-details" class="visits-details" hidden>
      <summary>每日明细</summary>
      <div class="visits-table-wrap" tabindex="0" role="region" aria-label="每日访问人数明细">
        <table class="platform-table"><thead><tr><th scope="col">日期（北京时间）</th><th scope="col">访问人数</th></tr></thead><tbody></tbody></table>
      </div>
    </details>
  </section>`;
  const scope = body.querySelector('#visits-scope');
  const range = body.querySelector('#visits-range');
  const refresh = body.querySelector('#visits-refresh');
  const today = body.querySelector('#visits-today');
  const todayDate = body.querySelector('#visits-today-date');
  const method = body.querySelector('#visits-method');
  const total = body.querySelector('#visits-total');
  const status = body.querySelector('#visits-status');
  const chart = body.querySelector('#visits-chart');
  const details = body.querySelector('#visits-details');
  const rows = details.querySelector('tbody');
  let series = [];
  let chartWidth = 0;
  let requestNumber = 0;

  function renderChart() {
    const width = chart.clientWidth;
    if (!series.length || !width || width === chartWidth) return;
    chartWidth = width;
    drawVisitsChart(chart, series, width);
  }
  new ResizeObserver(renderChart).observe(chart);

  async function load() {
    const current = ++requestNumber;
    const query = new URLSearchParams({ days: range.value });
    const accountId = scope?.value;
    if (accountId) query.set('accountId', accountId);
    refresh.disabled = true;
    today.textContent = total.textContent = '—';
    todayDate.textContent = '北京时间';
    chart.hidden = details.hidden = true;
    status.classList.remove('error');
    status.textContent = '正在加载访问统计…';
    try {
      const data = await api(`/api/profile/visits?${query}`);
      if (current !== requestNumber) return;
      if (scope) {
        scope.replaceChildren(new Option('全站', ''));
        for (const account of data.accounts) {
          scope.add(new Option(`${account.displayName} / ${account.publicId}`, String(account.id)));
        }
        scope.value = accountId;
        scope.disabled = false;
      }
      today.textContent = data.today.toLocaleString('zh-CN');
      todayDate.textContent = `${data.days.at(-1).date} · 北京时间`;
      method.textContent = `按北京时间统计，今天按${data.todayDeduplication === 'ip' ? '独立 IP' : '浏览器'}去重，读取服务器保存的每日汇总。`;
      total.textContent = data.total.toLocaleString('zh-CN');
      series = data.days.filter(day => day.date >= data.availableFrom);
      chartWidth = 0;
      chart.hidden = details.hidden = !series.length;
      const messages = [];
      messages.push(`${data.ipDedupFrom} 起按独立 IP 每日去重，此前历史数据保留浏览器统计口径。`);
      if (scope && !accountId) messages.push('全站汇总会合并同一访客当天对多个主页的访问。');
      if (series.length < data.days.length) messages.push(`统计自 ${data.availableFrom} 开始，曲线展示已采集的日期。`);
      if (!data.total) messages.push('所选时段暂无访问记录。');
      status.textContent = messages.join(' ');
      rows.innerHTML = series.slice().reverse().map(day => `<tr><td><time datetime="${escapeHtml(day.date)}">${escapeHtml(day.date)}</time></td><td>${day.visitors.toLocaleString('zh-CN')}</td></tr>`).join('');
      renderChart();
    } catch (error) {
      if (current !== requestNumber) return;
      status.classList.add('error');
      status.textContent = `${error.message} 请点击刷新重试。`;
    } finally {
      if (current === requestNumber) refresh.disabled = false;
    }
  }

  scope?.addEventListener('change', load);
  range.addEventListener('change', load);
  refresh.addEventListener('click', load);
  await load();
}

async function accounts() {
  const data = await api('/api/platform/accounts');
  body.innerHTML = `<section class="panel"><div class="panel-heading"><div><h2>摄影师账户</h2><p>${data.accounts.length} 个账户。点击「账户配置」设置套餐、订阅到期时间和基础容量。</p></div><a class="button primary" href="/admin/invitations">邀请摄影师</a></div><div class="table-wrap"><table class="platform-table"><thead><tr><th>摄影师 / ID</th><th>状态</th><th>作品</th><th>已用 / 总容量</th><th>加入时间</th><th>操作</th></tr></thead><tbody>${data.accounts.map(account=>`<tr><td><strong>${escapeHtml(account.displayName)}</strong><small>/${escapeHtml(account.publicId)} · ${escapeHtml(account.loginId)}</small></td><td><span class="badge ${account.deletedAt ? 'deleted' : account.active ? 'active' : 'disabled'}">${account.deletedAt ? '回收站' : account.active ? '正常' : '停用'}</span>${account.role === 'admin' ? ' <span class="badge admin">管理员</span>' : ''}${!account.subscription.permanent ? `<small>${account.subscription.expired ? '订阅已到期' : escapeHtml(account.subscription.planName)} · ${date(account.subscription.expiresAt)}</small>` : ''}</td><td>${account.photoCount} 张<small>${account.seriesCount} 个系列</small></td><td><strong>${bytes(account.storageBytes)} / ${bytes(account.totalQuotaBytes)}</strong><small>基础 ${bytes(account.quotaBytes)} · 累计扩容 ${bytes(account.storageAddonBytes)}${account.storageAddonBytes && account.subscription.expired ? '（暂停使用）' : ''}</small><div class="meter account-storage-meter"><span style="width:${Math.min(100,Math.round((account.storageBytes+account.pendingBytes)/account.totalQuotaBytes*100))}%"></span></div><small>剩余 ${bytes(account.availableBytes)}${account.pendingBytes ? ` · 待上传 ${bytes(account.pendingBytes)}` : ''}${account.storageComplete ? '' : ' · 容量核对中'}</small></td><td>${date(account.createdAt)}</td><td class="actions"><button type="button" class="button secondary small" data-configure="${account.id}">账户配置</button><a class="button ghost small" href="/${escapeHtml(account.publicId)}">主页 ↗</a>${account.role !== 'admin' ? account.deletedAt ? `<button type="button" class="button ghost small" data-account="${account.id}" data-action="restore">恢复</button>` : `<button type="button" class="button ghost small" data-account="${account.id}" data-action="${account.active ? 'disable' : 'enable'}">${account.active ? '停用' : '启用'}</button><button type="button" class="button ghost small" data-account="${account.id}" data-action="trash">回收站</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section>`;
  body.querySelectorAll('[data-configure]').forEach(button=>button.addEventListener('click',()=>{
    const account = data.accounts.find(item=>item.id === Number(button.dataset.configure));
    const admin = account.role === 'admin';
    let expiresAt = admin ? null : account.subscriptionExpiresAt;
    const shiftedExpiry = expiresAt === null ? null : new Date(expiresAt + 8*3600000);
    const editableExpiry = expiresAt !== null && shiftedExpiry.getUTCFullYear() >= 1 && shiftedExpiry.getUTCFullYear() <= 9999;
    let displayedExpiry = editableExpiry ? shiftedExpiry.toISOString().slice(0,16) : '';
    const element = dialog(`${dialogHeading('账户配置')}<p class="field-note">${escapeHtml(account.displayName)} · 已用 ${bytes(account.storageBytes)} · 待上传 ${bytes(account.pendingBytes)}</p><form><label>订阅套餐<select name="subscriptionPlan" ${admin ? 'disabled' : ''}><option value="">长期有效</option>${data.plans.map(plan=>`<option value="${plan.id}" ${!admin && account.subscriptionPlan === plan.id ? 'selected' : ''}>${escapeHtml(plan.name)}</option>`).join('')}</select></label>${admin ? '<p class="field-note">平台管理员免订阅，可调整基础容量。</p>' : '<p class="field-note">切换套餐会预填基础容量，并从现在起计算套餐有效期。可继续修改基础容量和到期时间。</p>'}<label>订阅到期时间（北京时间）<input type="datetime-local" name="subscriptionExpiresAt" value="${displayedExpiry}" ${editableExpiry ? 'required' : 'disabled'}></label><p id="account-expiry-range-note" class="field-note" ${expiresAt === null || editableExpiry ? 'hidden' : ''}>${expiresAt !== null && !editableExpiry ? `当前到期时间：${new Date(expiresAt).toISOString()}（UTC），时间戳 ${expiresAt}。此日期超出控件编辑范围，保存会保留原值；可切换套餐重新设置。` : ''}</p><label>基础容量（GiB）<input type="number" name="quota" min="${1/1024**3}" max="${(Number.MAX_SAFE_INTEGER-account.storageAddonBytes)/1024**3}" step="any" value="${account.quotaBytes/1024**3}" required></label><p class="field-note">基础容量必须大于 0，已领取的扩容另计。照片、头像、封面和待完成上传共同计入总容量。调低后若超额，已有照片保留，上传暂停。</p><p class="info-note" id="account-config-preview" aria-live="polite"></p><p class="field-note">保存会直接设置套餐、到期时间和基础容量。已领取的扩容继续保留。</p><div class="form-actions"><button type="button" class="button secondary" data-close>取消</button><button type="submit" class="button primary">保存账户配置</button></div></form>`);
    const planSelect = element.querySelector('[name=subscriptionPlan]');
    const expiryInput = element.querySelector('[name=subscriptionExpiresAt]');
    const quotaInput = element.querySelector('[name=quota]');
    const preview = element.querySelector('#account-config-preview');
    const updatePreview = () => {
      if (quotaInput.validity.rangeOverflow) {
        preview.textContent = '基础容量与累计扩容的总和超出支持范围，请调低基础容量。';
        return;
      }
      const expiry = expiryInput.value === displayedExpiry ? expiresAt : Date.parse(`${expiryInput.value}+08:00`);
      const expiryText = !planSelect.value ? '长期有效' : expiryInput.disabled ? `${new Date(expiry).toISOString()}（UTC）` : Number.isNaN(expiry) ? '请填写有效到期时间' : new Date(expiry).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const totalQuota = quotaInput.validity.valid ? bytes(Math.round(quotaInput.valueAsNumber * 1024**3) + account.storageAddonBytes) : '请填写基础容量';
      preview.textContent = `保存后：${planSelect.value ? `${planSelect.selectedOptions[0].textContent} · ${expiryText}${expiryInput.disabled ? '' : '（北京时间）'}` : '长期有效'} · 基础 ${quotaInput.value} GiB · 累计扩容 ${bytes(account.storageAddonBytes)} · 总容量 ${totalQuota}`;
    };
    planSelect.addEventListener('change',()=>{
      const plan = data.plans.find(item=>item.id === planSelect.value);
      expiresAt = plan ? Date.now() + plan.days*86400000 : null;
      displayedExpiry = expiresAt === null ? '' : new Date(expiresAt + 8*3600000).toISOString().slice(0,16);
      expiryInput.value = displayedExpiry;
      expiryInput.disabled = expiresAt === null;
      expiryInput.required = expiresAt !== null;
      element.querySelector('#account-expiry-range-note').hidden = true;
      if (plan) quotaInput.value = plan.quotaBytes/1024**3;
      updatePreview();
    });
    expiryInput.addEventListener('input',updatePreview);
    quotaInput.addEventListener('input',updatePreview);
    updatePreview();
    element.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault(); const submit=element.querySelector('[type=submit]');submit.disabled=true;
      try {
        const subscriptionPlan = planSelect.value || null;
        const subscriptionExpiresAt = subscriptionPlan === null ? null : expiryInput.value === displayedExpiry ? expiresAt : Date.parse(`${expiryInput.value}+08:00`);
        await api('/api/platform/accounts','PATCH',{id:account.id,action:'configure',quotaBytes:Math.round(Number(quotaInput.value)*1024**3),subscriptionPlan,subscriptionExpiresAt});
        element.close();await accounts();notify('账户配置已保存。');
      } catch(error){notify(error.message,true);} finally{submit.disabled=false;}
    });
  }));
  body.querySelectorAll('[data-account]').forEach(button=>button.addEventListener('click',()=>{
    const account = data.accounts.find(item=>item.id === Number(button.dataset.account));
    const action=button.dataset.action;
    const element=dialog(`${dialogHeading(button.textContent+'账户')}<p class="muted">${escapeHtml(account.displayName)}${action === 'trash' ? '将从目录隐藏并退出登录，照片保留，可在这里恢复。' : action === 'disable' ? '将暂时无法登录，主页也会隐藏。' : '将恢复登录和个人主页。'}</p><div class="form-actions"><button type="button" class="button secondary" data-close>取消</button><button type="button" class="button primary" id="confirm-account">确认${escapeHtml(button.textContent)}</button></div>`);
    element.querySelector('#confirm-account').addEventListener('click',async event=>{
      const confirm=event.currentTarget;confirm.disabled=true;
      try{await api('/api/platform/accounts','PATCH',{id:account.id,action});element.close();await accounts();notify('账户状态已更新。');}
      catch(error){notify(error.message,true);confirm.disabled=false;}
    });
  }));
}

async function subscription(data = null) {
  const subscriptionDate = value => new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'});
  data ??= await api('/api/profile/subscription');
  const current = data.subscription;
  const admin = app.dataset.accountRole === 'admin';
  const used = data.usage.storageBytes + data.usage.pendingBytes;
  body.innerHTML = `<section class="panel subscription-current"><div class="panel-heading"><div><h2>当前订阅</h2><p>${admin ? '平台管理员免订阅。' : current.permanent ? '当前账户长期有效。' : current.expired ? '订阅已到期，照片保留，续订后恢复公开展示和上传。' : `当前为${escapeHtml(current.planName)}，到期后公开展示和上传将暂停。`}</p></div><span class="badge ${current.expired ? 'disabled' : 'active'}">${admin ? '管理员' : current.permanent ? '长期有效' : current.expired ? '已到期' : '订阅中'}</span></div><div class="subscription-summary"><div><small>订阅到期时间</small><strong>${current.expiresAt === null || admin ? '长期有效' : subscriptionDate(current.expiresAt)}</strong>${!current.permanent && !current.expired ? `<span>剩余 ${current.daysRemaining} 天</span>` : ''}</div><div><small>已用 / 总容量</small><strong>${bytes(data.usage.storageBytes)} / ${bytes(current.totalQuotaBytes)}</strong><span>基础 ${bytes(current.quotaBytes)} · 累计扩容 ${bytes(current.storageAddonBytes)}${current.storageAddonBytes && current.expired ? '（暂停使用）' : ''}</span><span>${data.usage.pendingBytes ? `待上传 ${bytes(data.usage.pendingBytes)} · ` : ''}剩余 ${bytes(data.usage.availableBytes)}</span></div></div><div class="meter subscription-storage-meter"><span style="width:${Math.min(100,used/current.totalQuotaBytes*100)}%"></span></div>${used > current.totalQuotaBytes ? '<p class="subscription-capacity-warning">当前文件和待上传任务已超过容量额度，已有照片保留；请清理文件、取消未完成上传或兑换更大容量的套餐后继续上传。</p>' : ''}</section>
    <section class="subscription-plan-grid" aria-label="订阅套餐">${data.plans.map(plan=>`<article class="panel subscription-plan${current.planId === plan.id ? ' is-current' : ''}"><div class="subscription-plan-heading"><h2>${escapeHtml(plan.name)}</h2>${current.planId === plan.id ? '<span class="badge active">当前套餐</span>' : ''}</div><p class="subscription-price">¥${plan.priceCents/100}<small> / ${plan.days} 天</small></p><p class="subscription-plan-quota"><strong>${plan.quotaBytes/1024**3} GiB</strong> 基础容量</p><p class="field-note">基础容量随套餐切换，已领取的扩容继续保留。</p></article>`).join('')}</section>
    ${admin ? '<section class="panel"><h2>管理员免订阅</h2><p class="muted">在「兑换码」中可以为摄影师生成订阅码和扩容码。</p><a class="button secondary" href="/admin/invitations">管理兑换码</a></section>' : `<section class="panel subscription-redeem"><div class="panel-heading"><div><h2>兑换订阅或扩容</h2><p>在这里输入订阅码或扩容码，每个码仅可使用一次。</p></div></div><form id="subscription-redeem-form"><label for="subscription-code">邀请码 / 兑换码<input id="subscription-code" name="code" autocomplete="off" maxlength="100" placeholder="粘贴完整兑换码" required></label><div class="form-actions"><button class="button primary" type="submit">查看兑换权益</button></div></form><p class="field-note">有限期码追加订阅天数，到期后从兑换时起算。长期码将账户改为长期有效。订阅码切换基础容量，扩容码累加额外容量。扩容长期保留，订阅有效时可用。</p><p class="field-note">爱发电档位开通前，请向管理员获取兑换码。</p></section>`}`;
  if (admin) return;
  body.querySelector('#subscription-redeem-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('[type=submit]');
    const code = new FormData(event.currentTarget).get('code').trim();
    submit.disabled = true;
    try {
      const preview = await api('/api/profile/subscription/preview', 'POST', { code });
      const { storageAddon, plan, subscription: previous, usage, nextTotalQuotaBytes } = preview;
      const reserved = usage.storageBytes + usage.pendingBytes;
      const heading = storageAddon ? '确认领取扩容' : '确认兑换订阅';
      const benefit = storageAddon ? `扩容包 · +${bytes(storageAddon.addedBytes)}` : `${escapeHtml(plan.name)}${plan.permanent ? '（账号无到期日）' : ` · ${plan.days} 天`} · ${bytes(plan.quotaBytes)} 基础容量`;
      const details = storageAddon ? `
        <div><dt>本次增加</dt><dd>+${bytes(storageAddon.addedBytes)}</dd></div>
        <div><dt>累计扩容</dt><dd>${bytes(previous.storageAddonBytes)} → ${bytes(storageAddon.nextStorageAddonBytes)}</dd></div>` : `
        <div><dt>订阅有效期</dt><dd>${previous.permanent ? '当前长期有效' : subscriptionDate(previous.expiresAt)} → ${plan.permanent ? '转为长期有效' : subscriptionDate(preview.nextExpiresAt)}</dd></div>
        <div><dt>基础容量</dt><dd>${bytes(previous.quotaBytes)} → ${bytes(plan.quotaBytes)}</dd></div>
        ${previous.storageAddonBytes ? `<div><dt>累计扩容</dt><dd>${bytes(previous.storageAddonBytes)} · 继续保留</dd></div>` : ''}`;
      const element = dialog(`${dialogHeading(heading)}<p class="subscription-confirm-plan">${benefit}</p><dl class="subscription-confirm-details">
        ${details}
        <div><dt>总容量</dt><dd>${bytes(previous.totalQuotaBytes)} → ${bytes(nextTotalQuotaBytes)}</dd></div>
        <div><dt>已用与待上传</dt><dd>${bytes(usage.storageBytes)}${usage.pendingBytes ? ` + 待上传 ${bytes(usage.pendingBytes)}` : ''}</dd></div>
      </dl>
      ${storageAddon && previous.expired ? '<p class="subscription-capacity-warning">订阅已到期。可以先领取并保留扩容，续费后可用。当前剩余 0 B。</p>' : ''}
      ${!storageAddon && previous.permanent && !plan.permanent ? '<p class="subscription-capacity-warning">当前账户为长期有效，兑换后将转为上面显示的有限期订阅。</p>' : ''}
      ${nextTotalQuotaBytes < previous.totalQuotaBytes ? '<p class="subscription-capacity-warning">兑换后总容量会降低，已有照片保留。</p>' : ''}
      ${reserved > nextTotalQuotaBytes ? '<p class="subscription-capacity-warning">当前文件与待上传任务超过新额度。已有照片保留，上传将在用量回到额度内或容量提高后恢复。</p>' : ''}
      <p class="field-note">${storageAddon ? '扩容长期保留，订阅有效时可用。' : ''}确认后此码即已使用。</p>
      <div class="form-actions"><button type="button" class="button secondary" data-close>取消</button><button type="button" class="button primary" id="confirm-subscription-redeem">确认兑换</button></div>`);
      element.querySelector('#confirm-subscription-redeem').addEventListener('click', async () => {
        const confirm = element.querySelector('#confirm-subscription-redeem');
        confirm.disabled = true;
        try {
          const result = await api('/api/profile/subscription', 'POST', { code });
          element.close();
          await subscription({ ...result, plans: data.plans });
          window.dispatchEvent(new CustomEvent('subscription-updated', { detail: result.subscription }));
          if (storageAddon) notify(result.subscription.expired ? '扩容已领取，续费后可用。' : '扩容已到账，容量已更新。');
          else notify('兑换成功，订阅期限和容量已更新。');
        } catch (error) {
          notify(error.message, true);
          confirm.disabled = false;
        }
      });
    } catch (error) {
      notify(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
}

async function invitations(page=1) {
  const data=await api(`/api/platform/invitations?page=${page}`);
  body.innerHTML=`<section class="panel"><div class="panel-heading"><div><h2>兑换码</h2><p>订阅码可用于注册和续期，扩容码由已有账号在工作台领取。每个码仅可使用一次。</p></div><button type="button" class="button primary" id="create-invitation">生成兑换码</button></div><div class="table-wrap"><table class="platform-table"><thead><tr><th>兑换码摘要 / 备注</th><th>状态</th><th>使用账户</th><th>套餐 / 容量权益</th><th>可兑换截止时间</th><th>操作</th></tr></thead><tbody>${data.invitations.map(item=>{const state=item.usedAt ? '已使用' : item.revokedAt ? '已撤销' : item.expiresAt && item.expiresAt<=Date.now() ? '已过期' : '未使用';const plan=item.planId ? data.plans.find(plan=>plan.id === item.planId) : null;return `<tr><td><strong>${escapeHtml(item.hint)}</strong><small>${escapeHtml(item.note)}</small></td><td><span class="badge ${state === '未使用' ? 'active' : ''}">${state}</span></td><td>${item.usedBy ? escapeHtml(item.usedBy) : '—'}</td><td>${item.addOnBytes ? `扩容包<small>+${bytes(item.addOnBytes)} · 长期保留</small>` : `${item.permanent ? '长期有效（账号无到期日）' : plan ? `${escapeHtml(plan.name)} · ${item.durationDays} 天` : '原有注册码'}<small>${bytes(item.quotaBytes)}${plan || item.permanent ? ' 基础容量' : ''}</small>`}</td><td>${date(item.expiresAt)}</td><td>${!item.usedAt && !item.revokedAt ? `<button type="button" class="button ghost small" data-revoke="${item.id}">撤销</button>` : '—'}</td></tr>`;}).join('') || '<tr><td colspan="6" class="empty-state">还没有兑换码，点击右上角生成。</td></tr>'}</tbody></table></div><p class="field-note">原有注册码继续按原规则使用。可兑换截止时间只限制何时能使用码。兑换成功后，按码的类型获得订阅或扩容权益。</p></section>`;
  document.querySelector('#create-invitation').addEventListener('click',()=>{
    const subscriptionNote = '有限期套餐会预填订阅天数和基础容量。长期有效的账号无到期日，基础容量仍可调整。';
    const element=dialog(`${dialogHeading('生成兑换码')}<form><label>权益类型<select name="planId">${data.plans.map(plan=>`<option value="${plan.id}">${escapeHtml(plan.name)} · ${plan.days} 天 · ${plan.quotaBytes/1024**3} GiB</option>`).join('')}<option value="permanent">长期有效（账号无到期日）</option><option value="storage-addon">扩容包（增加存储容量）</option></select></label><p class="field-note" id="invitation-rights-note">${subscriptionNote}</p><div class="form-row"><label>订阅天数<input name="durationDays" type="number" value="${data.plans[0].days}" min="1" step="1" required></label><label><span id="invitation-quota-label">基础容量（GiB）</span><input name="quota" type="number" value="${data.plans[0].quotaBytes/1024**3}" min="${1/1024**3}" step="any" required></label></div><p class="info-note" id="invitation-benefits-preview" aria-live="polite"></p><div class="form-row"><label>数量<input name="count" type="number" value="1" min="1" max="50" step="1" required></label><label>码的可兑换期限<select name="days"><option value="0">长期可兑换</option><option value="7">生成后 7 天</option><option value="30">生成后 30 天</option><option value="90">生成后 90 天</option></select></label></div><p class="field-note">可兑换期限只限制此码何时可用。领取后的扩容长期保留，有限期订阅从激活或续期时另算。</p><label>备注（选填）<input name="note" maxlength="80"></label><div class="form-actions"><button type="button" class="button secondary" data-close>取消</button><button class="button primary" type="submit">生成</button></div></form>`);
    const planSelect = element.querySelector('[name=planId]');
    const durationInput = element.querySelector('[name=durationDays]');
    const quotaInput = element.querySelector('[name=quota]');
    const durationField = durationInput.closest('label');
    const rightsNote = element.querySelector('#invitation-rights-note');
    const quotaLabel = element.querySelector('#invitation-quota-label');
    const preview = element.querySelector('#invitation-benefits-preview');
    const updatePreview = () => {
      const selected = planSelect.value;
      if (selected === 'storage-addon') {
        preview.textContent = `本批兑换权益：扩容包 · +${quotaInput.value} GiB · 长期保留`;
        return;
      }
      const plan = data.plans.find(item=>item.id === selected);
      const term = selected === 'permanent' ? '长期有效（账号无到期日）' : `${plan.name} · ${durationInput.value} 天`;
      preview.textContent = `本批兑换权益：${term} · ${quotaInput.value} GiB 基础容量`;
    };
    planSelect.addEventListener('change',()=>{
      const plan = data.plans.find(item=>item.id === planSelect.value);
      const storageAddon = planSelect.value === 'storage-addon';
      durationField.hidden = !plan;
      durationInput.disabled = !plan;
      durationInput.required = Boolean(plan);
      quotaLabel.textContent = storageAddon ? '本次增加容量（GiB）' : '基础容量（GiB）';
      rightsNote.textContent = storageAddon ? '扩容码只供已有账号在工作台领取。领取后累加容量，长期保留，订阅有效时可用。' : subscriptionNote;
      if (plan) {
        durationInput.value = plan.days;
        quotaInput.value = plan.quotaBytes/1024**3;
      }
      updatePreview();
    });
    durationInput.addEventListener('input',updatePreview);
    quotaInput.addEventListener('input',updatePreview);
    updatePreview();
    element.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault();const form=new FormData(event.currentTarget);const submit=element.querySelector('[type=submit]');submit.disabled=true;
      try{
        const selected = form.get('planId');
        const quotaBytes = Math.round(Number(form.get('quota')) * 1024**3);
        const rights = selected === 'storage-addon' ? { addOnBytes: quotaBytes } : selected === 'permanent'
          ? { permanent: true, quotaBytes } : { planId: selected, durationDays: Number(form.get('durationDays')), quotaBytes };
        const result = await api('/api/platform/invitations','POST',{...rights,count:Number(form.get('count')),days:Number(form.get('days')),note:form.get('note')});
        element.close();
        const benefit = result.addOnBytes ? `扩容包 · +${bytes(result.addOnBytes)} · 长期保留` : `${escapeHtml(result.plan.name)}${result.plan.permanent ? '（账号无到期日）' : ` · ${result.plan.days} 天`} · ${result.plan.quotaBytes/1024**3} GiB 基础容量`;
        const redemption = result.addOnBytes ? '仅已有账号可领取一次。请在「订阅与容量」兑换。' : '每个码可注册或续期一次。';
        const created = dialog(`${dialogHeading('兑换码已生成')}<p class="subscription-confirm-plan">${benefit}</p><p class="field-note">完整码只在这里显示一次，请复制或下载保存。${redemption}请通过选定渠道交付，使用自助领取链接的方案不要同时启用随机库存码。</p><label>兑换码<textarea id="new-codes" rows="${Math.min(result.codes.length+1,12)}" readonly>${escapeHtml(result.codes.join('\n'))}</textarea></label><div class="form-actions"><button type="button" class="button secondary" data-close>完成</button><button type="button" class="button secondary" id="download-codes">下载 TXT</button><button type="button" class="button primary" id="copy-codes">复制兑换码</button></div>`);
        created.querySelector('#copy-codes').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(result.codes.join('\n'));notify('兑换码已复制。');}catch{created.querySelector('#new-codes').select();notify('请选中文本手动复制。');}});
        created.querySelector('#download-codes').addEventListener('click',()=>{
          const url=URL.createObjectURL(new Blob([result.codes.join('\n')+'\n'],{type:'text/plain;charset=utf-8'}));
          const filename = result.addOnBytes ? `storage-addon-+${bytes(result.addOnBytes).replace(' ', '')}` : result.plan.id;
          const link=document.createElement('a');link.href=url;link.download=`photographer-${filename}-codes.txt`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
        });
        try { await invitations(); }
        catch (error) { notify(`兑换码已生成，列表刷新失败。请先保存本批兑换码。${error.message}`, true); }
      }catch(error){notify(error.message,true);}finally{submit.disabled=false;}
    });
  });
  body.querySelectorAll('[data-revoke]').forEach(button=>button.addEventListener('click',async()=>{
    button.disabled=true;
    try{await api('/api/platform/invitations','DELETE',{id:button.dataset.revoke});await invitations(data.page);notify('兑换码已撤销。');}
    catch(error){notify(error.message,true);button.disabled=false;}
  }));
  const pages=Math.max(1,Math.ceil(data.total/50));
  const pagination=document.createElement('div');pagination.className='table-pagination';
  pagination.innerHTML=`<span>共 ${data.total} 条 · 第 ${data.page} / ${pages} 页</span><div><button type="button" class="button secondary small" data-page="${data.page-1}" ${data.page===1?'disabled':''}>上一页</button><button type="button" class="button secondary small" data-page="${data.page+1}" ${data.page===pages?'disabled':''}>下一页</button></div>`;
  body.append(pagination);
  pagination.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>invitations(Number(button.dataset.page)).catch(error=>notify(error.message,true))));
}


async function profile() {
  const {account,usage}=await api('/api/profile');
  const storageSummary = (account, usage) => `总容量 ${bytes(account.totalQuotaBytes)} · 基础 ${bytes(account.quotaBytes)} · 累计扩容 ${bytes(account.storageAddonBytes)}${account.storageAddonBytes && usage.subscriptionExpired ? '（暂停使用）' : ''} · 剩余 ${bytes(usage.availableBytes)} · ${usage.photoCount} 张照片`;
  body.innerHTML=`<section class="panel directory-listing-panel" aria-labelledby="directory-listing-title"><div class="panel-heading"><h2 id="directory-listing-title">主页展示设置</h2><span id="directory-listing-status" class="badge">${account.listed ? '主入口展示已开启' : '主入口展示已关闭'}</span></div><form id="directory-listing-form"><div><label class="directory-listing-toggle"><input type="checkbox" role="switch" name="listed" ${account.listed ? 'checked' : ''}><span>在主入口展示我的主页</span></label><p class="field-note">保存后生效。关闭后，主入口的摄影师列表不展示你的主页，个人主页和相册仍可通过链接访问。</p></div><button class="button primary" type="submit">保存展示设置</button></form></section><div class="profile-layout"><div><section class="panel profile-cover-panel"><div class="panel-heading"><h2>主页封面</h2><span class="badge">16:9</span></div><div id="cover-preview" class="profile-cover-preview">${account.coverUrl ? `<img src="${escapeHtml(account.coverUrl)}" alt="主页封面">` : '<span>还未上传封面</span>'}</div><div class="cover-actions"><label class="button secondary" for="cover-file" style="margin:0;cursor:pointer">上传封面</label><input type="file" id="cover-file" accept="image/jpeg,image/png,image/webp,image/gif" class="sr-only"><button type="button" class="button ghost" id="remove-cover" ${account.coverUrl ? '' : 'hidden'}>移除封面</button></div><p class="field-note">头像、摄影师名称与个性签名显示在封面左上方，个人简介显示在身份信息下方；未上传封面时不预留图片区域。</p></section><section class="panel profile-cover-panel"><div class="panel-heading"><h2>目录卡片背景</h2><span class="badge">16:10</span></div><div id="directory-cover-preview" class="profile-cover-preview directory-cover-preview">${account.directoryCoverUrl || account.coverUrl ? `<img src="${escapeHtml(account.directoryCoverUrl || account.coverUrl)}" alt="目录卡片背景">` : '<span>还未设置背景</span>'}</div><div class="cover-actions"><label class="button secondary" for="directory-cover-file" style="margin:0;cursor:pointer">上传独立背景</label><input type="file" id="directory-cover-file" accept="image/jpeg,image/png,image/webp,image/gif" class="sr-only"><button type="button" class="button secondary" id="adjust-directory-cover" ${account.directoryCoverUrl || account.coverUrl ? '' : 'disabled'}>调整当前背景</button><button type="button" class="button ghost" id="remove-directory-cover" ${account.directoryCoverUrl ? '' : 'hidden'}>恢复使用主页封面</button></div><p class="field-note">默认沿用主页封面，可单独上传或裁切目录背景。头像、名字、签名、地区和简介使用下方资料，目录中只展示摘要。</p></section><section class="panel"><div class="panel-heading"><h2>个人资料</h2></div><div class="avatar-editor"><div id="avatar-preview">${account.avatarUrl ? `<img src="${escapeHtml(account.avatarUrl)}" alt="账户头像">` : ''}</div><div class="avatar-actions"><label class="button secondary" for="avatar-file" style="margin:0;cursor:pointer">上传头像</label><input type="file" id="avatar-file" accept="image/jpeg,image/png,image/webp,image/gif" class="sr-only"><button type="button" class="button ghost" id="remove-avatar" ${account.avatarUrl ? '' : 'hidden'}>移除</button></div></div><form id="profile-form"><label>摄影师名称<input name="displayName" maxlength="40" value="${escapeHtml(account.displayName)}" required></label><label>个人站名<input name="siteName" maxlength="40" value="${escapeHtml(account.siteName)}" required></label><label>主页访问 ID<input name="publicId" pattern="[a-z][a-z0-9_-]{2,23}" maxlength="24" value="${escapeHtml(account.publicId)}" required></label><p class="field-note">更改主页 ID 只更新访问地址，作品和登录账号均保留；旧链接仍可访问。</p><label>个性签名（选填）<textarea name="bio" maxlength="240" rows="4">${escapeHtml(account.bio)}</textarea></label><label>地区（选填）<input name="region" maxlength="80" value="${escapeHtml(account.region)}"></label><p class="field-note">可自定义地区文字，不读取设备定位。</p><label>个人简介（选填）<textarea name="introduction" maxlength="1000" rows="6">${escapeHtml(account.introduction)}</textarea></label><label class="checkbox-label"><input type="checkbox" name="showPhotoNames" ${account.showPhotoNames ? 'checked' : ''}>公开展示文件名</label><p class="field-note">默认关闭；关闭时，照片墙悬停提示和放大浏览不显示文件名，后台管理仍保留。</p><div class="form-actions"><button class="button primary" type="submit">保存资料</button></div></form></section></div><div><section class="panel"><h2>我的个人主页</h2><a class="profile-url" href="/${escapeHtml(account.publicId)}">${escapeHtml(location.origin)}/${escapeHtml(account.publicId)} ↗</a><h3 style="margin-top:1.8rem">存储用量</h3><div class="storage-total">${bytes(usage.storageBytes)}</div><p id="profile-storage-summary" class="field-note">${storageSummary(account, usage)}</p>${usage.storageComplete ? '' : '<p class="field-note">历史照片容量核对中。</p>'}${usage.pendingBytes ? `<p class="field-note" id="profile-pending">待完成上传：${bytes(usage.pendingBytes)}</p>` : ''}</section><section class="panel"><h2>登录账号</h2><form id="login-id-form"><label>登录名<input name="loginId" autocomplete="username" pattern="[a-z][a-z0-9_-]{2,23}" minlength="3" maxlength="24" value="${escapeHtml(account.loginId)}" required></label><p class="field-note">3–24 位小写字母、数字、下划线或连字符，以字母开头。仅用于登录，与主页访问 ID 独立；修改需二次确认和当前密码，完成后所有设备需重新登录。</p><div class="form-actions"><button class="button secondary" type="submit">修改登录名</button></div></form></section><section class="panel"><h2>修改密码</h2><form id="password-form"><label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required></label><label>新密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><label>确认新密码<input name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><div class="form-actions"><button class="button secondary" type="submit">修改密码</button></div></form></section></div></div>`;
  const refreshUsage=async()=>{
    const fresh=await api('/api/profile');
    document.querySelector('.storage-total').textContent=bytes(fresh.usage.storageBytes);
    document.querySelector('#profile-storage-summary').textContent=storageSummary(fresh.account, fresh.usage);
    const note=document.querySelector('#profile-pending');
    if(note){note.textContent=`待完成上传：${bytes(fresh.usage.pendingBytes)}`;note.hidden=!fresh.usage.pendingBytes;}
    const manage=document.querySelector('#profile-manage-uploads');
    if(manage)manage.hidden=!fresh.usage.pendingBytes;
  };
  if(usage.pendingBytes){
    const manage=document.createElement('button');manage.type='button';manage.id='profile-manage-uploads';manage.className='button secondary small';manage.textContent='管理未完成上传';
    document.querySelector('.storage-total').parentElement.append(manage);
    manage.addEventListener('click',async()=>{
      try{
        const {uploads}=await api('/api/profile/uploads');
        const element=dialog(`${dialogHeading('未完成上传')}<p class="field-note">这些任务尚未加入作品集。取消任务会清理对应的未完成文件。</p><div class="pending-upload-list">${uploads.map(upload=>`<div class="pending-upload"><div><strong>${escapeHtml(upload.title)}</strong><small>${bytes(upload.size)} · ${date(upload.createdAt)}</small></div><button type="button" class="button secondary small" data-upload="${upload.id}">取消上传</button></div>`).join('') || '<p class="muted">暂无未完成的照片任务。</p>'}</div>`);
        element.querySelectorAll('[data-upload]').forEach(button=>button.addEventListener('click',async()=>{
          button.disabled=true;
          try{
            await api('/api/profile/uploads','DELETE',{id:button.dataset.upload});button.closest('.pending-upload').remove();
            await refreshUsage();
            if(!element.querySelector('.pending-upload'))element.querySelector('.pending-upload-list').textContent='暂无未完成的照片任务。';
            notify('上传任务已取消。');
          }catch(error){notify(error.message,true);button.disabled=false;}
        }));
      }catch(error){notify(error.message,true);}
    });
  }
  document.querySelector('#directory-listing-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const input=event.currentTarget.elements.namedItem('listed');
    const submit=event.currentTarget.querySelector('[type=submit]');
    input.disabled=submit.disabled=true;
    try{
      const {listed}=await api('/api/profile/listing','PATCH',{listed:input.checked});
      document.querySelector('#directory-listing-status').textContent=listed ? '主入口展示已开启' : '主入口展示已关闭';
      notify('主页展示设置已保存。');
    }catch(error){notify(error.message,true);}finally{input.disabled=submit.disabled=false;}
  });
  document.querySelector('#profile-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=new FormData(event.currentTarget);const submit=event.currentTarget.querySelector('[type=submit]');submit.disabled=true;
    try{await api('/api/profile','PATCH',{displayName:form.get('displayName'),siteName:form.get('siteName'),publicId:form.get('publicId'),bio:form.get('bio'),introduction:form.get('introduction'),region:form.get('region'),showPhotoNames:form.has('showPhotoNames')});document.querySelector('.sidebar-account strong').textContent=form.get('displayName');location.reload();}
    catch(error){notify(error.message,true);}finally{submit.disabled=false;}
  });
  document.querySelector('#login-id-form').addEventListener('submit',event=>{
    event.preventDefault();
    const loginId=new FormData(event.currentTarget).get('loginId').trim();
    if(loginId.toLowerCase()===account.loginId.toLowerCase()){notify('新登录名与当前登录名相同。',true);return;}
    const element=dialog(`${dialogHeading('确认修改登录名')}<p class="field-note">当前登录名：<strong>${escapeHtml(account.loginId)}</strong><br>新登录名：<strong>${escapeHtml(loginId)}</strong></p><p class="field-note">确认后所有设备会退出登录，请使用新登录名和原密码重新登录。主页地址和作品保持不变。</p><form id="confirm-login-id-form"><label>再次输入新登录名<input name="confirmationLoginId" autocomplete="off" maxlength="24" required></label><label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required></label><div class="form-actions"><button class="button secondary" type="button" data-close>取消</button><button class="button primary" type="submit">确认修改并重新登录</button></div></form>`);
    element.querySelector('form').addEventListener('submit',async confirmation=>{
      confirmation.preventDefault();
      const form=new FormData(confirmation.currentTarget);
      if(form.get('confirmationLoginId').trim()!==loginId){notify('两次输入的新登录名不一致。',true);return;}
      const submit=confirmation.currentTarget.querySelector('[type=submit]');submit.disabled=true;
      try{await api('/api/profile/login-id','POST',{loginId,confirmationLoginId:form.get('confirmationLoginId'),currentPassword:form.get('currentPassword')});location.assign('/login');}
      catch(error){notify(error.message,true);submit.disabled=false;}
    });
  });
  document.querySelector('#password-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=new FormData(event.currentTarget);if(form.get('password')!==form.get('confirmation')){notify('两次输入的新密码不一致。',true);return;}const submit=event.currentTarget.querySelector('[type=submit]');submit.disabled=true;
    try{await api('/api/profile/password','POST',{currentPassword:form.get('currentPassword'),password:form.get('password')});location.assign('/login');}
    catch(error){notify(error.message,true);submit.disabled=false;}
  });
  const setAvatar=url=>{document.querySelector('#avatar-preview').innerHTML=url ? `<img src="${escapeHtml(url)}" alt="账户头像">` : '';document.querySelector('#remove-avatar').hidden=!url;};
  document.querySelector('#avatar-file').addEventListener('change',async event=>{
    const input=event.currentTarget;const file=input.files[0];if(!file)return;input.disabled=true;
    try{
      const image=await createImageBitmap(file);
      const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
      const size=Math.min(image.width,image.height);canvas.getContext('2d').drawImage(image,(image.width-size)/2,(image.height-size)/2,size,size,0,0,256,256);image.close();
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.88));
      if(!blob)throw new Error('无法处理头像，请换一张图片。');
      await api('/api/profile/avatar','POST',blob);setAvatar(`/api/avatars/${account.publicId}?v=${Date.now()}`);await refreshUsage();notify('头像已更新。');
    }catch(error){notify(error.message,true);}finally{input.disabled=false;input.value='';}
  });
  document.querySelector('#remove-avatar').addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{await api('/api/profile/avatar','DELETE');setAvatar('');await refreshUsage();notify('头像已移除。');}
    catch(error){notify(error.message,true);}finally{button.disabled=false;}
  });
  for(const cover of [{id:'cover',label:'主页封面',height:9,urlPrefix:'/api/covers/'},{id:'directory-cover',label:'目录卡片背景',height:10,urlPrefix:'/api/directory-covers/'}]){
    const input=document.querySelector(`#${cover.id}-file`);
    const adjust=document.querySelector(`#adjust-${cover.id}`);
    const setCover=url=>{
      if(cover.id==='cover')account.coverUrl=url;
      else account.directoryCoverUrl=url;
      document.querySelector(`#${cover.id}-preview`).innerHTML=url || (cover.id==='directory-cover' && account.coverUrl) ? `<img src="${escapeHtml(url || account.coverUrl)}" alt="${cover.label}">` : `<span>还未设置${cover.label}</span>`;
      document.querySelector(`#remove-${cover.id}`).hidden=!url;
      document.querySelector('#adjust-directory-cover').disabled=!(account.directoryCoverUrl || account.coverUrl);
      if(cover.id==='cover' && !account.directoryCoverUrl)document.querySelector('#directory-cover-preview').innerHTML=url ? `<img src="${escapeHtml(url)}" alt="目录卡片背景">` : '<span>还未设置背景</span>';
    };
    const cropCover=async file=>{
      input.disabled=true;
      if(adjust)adjust.disabled=true;
      let bitmap;
      try{bitmap=await createImageBitmap(file);}
      catch{
        input.disabled=false;input.value='';
        if(adjust)adjust.disabled=!(account.directoryCoverUrl || account.coverUrl);
        notify('无法打开这张图片，请选择 JPG、PNG、WebP 或 GIF。',true);
        return;
      }
      const sourceUrl=URL.createObjectURL(file);
      const element=dialog(`${dialogHeading(`裁切${cover.label}`)}<div class="cover-crop-preview" style="aspect-ratio:16/${cover.height}"><img src="${escapeHtml(sourceUrl)}" alt="背景裁切预览"></div><div class="cover-crop-controls"><label>水平位置<input name="horizontal" type="range" min="0" max="100" value="50"></label><label>垂直位置<input name="vertical" type="range" min="0" max="100" value="50"></label></div><p class="field-note">固定 16:${cover.height}，调整取景后保存。${cover.id==='directory-cover' ? '只更新目录卡片背景，主页封面保留。' : '头像、名字和签名显示在封面左上方。'}</p><div class="form-actions"><button type="button" class="button secondary" data-close>取消</button><button type="button" class="button primary" id="save-cover">保存背景</button></div>`);
      element.classList.add('cover-crop-dialog');
      const preview=element.querySelector('.cover-crop-preview img');
      const horizontal=element.querySelector('[name=horizontal]');
      const vertical=element.querySelector('[name=vertical]');
      const cropWidth=Math.min(bitmap.width,bitmap.height*16/cover.height);
      const cropHeight=cropWidth*cover.height/16;
      horizontal.disabled=bitmap.width<=cropWidth;
      vertical.disabled=bitmap.height<=cropHeight;
      for(const control of [horizontal,vertical])control.addEventListener('input',()=>{preview.style.objectPosition=`${horizontal.value}% ${vertical.value}%`;});
      let saving=false;
      element.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
      element.addEventListener('close',()=>{bitmap.close();URL.revokeObjectURL(sourceUrl);input.disabled=false;input.value='';if(adjust)adjust.disabled=!(account.directoryCoverUrl || account.coverUrl);},{once:true});
      element.querySelector('#save-cover').addEventListener('click',async()=>{
        saving=true;
        element.querySelectorAll('input,button').forEach(control=>{control.disabled=true;});
        const submit=element.querySelector('#save-cover');
        submit.textContent='正在保存…';
        const canvas=document.createElement('canvas');
        try{
          canvas.width=Math.min(1920,Math.max(16,Math.floor(cropWidth/16)*16));
          canvas.height=canvas.width*cover.height/16;
          canvas.getContext('2d').drawImage(bitmap,(bitmap.width-cropWidth)*Number(horizontal.value)/100,(bitmap.height-cropHeight)*Number(vertical.value)/100,cropWidth,cropHeight,0,0,canvas.width,canvas.height);
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.9));
          if(!blob)throw new Error('无法处理背景，请换一张图片。');
          if(blob.size>4*1024**2)throw new Error('处理后的背景过大，请换一张图片。');
          await api(`/api/profile/${cover.id}`,'POST',blob);
          setCover(`${cover.urlPrefix}${account.publicId}?v=${Date.now()}`);
          element.close();
          await refreshUsage();
          notify(`${cover.label}已保存。`);
        }catch(error){notify(error.message,true);}
        finally{
          canvas.width=canvas.height=1;
          saving=false;
          if(element.open){element.querySelectorAll('input,button').forEach(control=>{control.disabled=false;});horizontal.disabled=bitmap.width<=cropWidth;vertical.disabled=bitmap.height<=cropHeight;submit.textContent='保存背景';}
        }
      });
    };
    input.addEventListener('change',()=>{if(input.files[0])void cropCover(input.files[0]);});
    if(adjust)adjust.addEventListener('click',async()=>{
      adjust.disabled=true;input.disabled=true;
      try{
        const response=await fetch(account.directoryCoverUrl || account.coverUrl);
        if(!response.ok)throw new Error('无法读取当前背景，请上传图片后重试。');
        await cropCover(await response.blob());
      }catch(error){notify(error.message,true);input.disabled=false;adjust.disabled=!(account.directoryCoverUrl || account.coverUrl);}
    });
    document.querySelector(`#remove-${cover.id}`).addEventListener('click',async event=>{
      const button=event.currentTarget;button.disabled=true;
      try{await api(`/api/profile/${cover.id}`,'DELETE');setCover('');await refreshUsage();notify(cover.id==='directory-cover' ? '目录卡片已恢复使用主页封面。' : '封面已移除。');}
      catch(error){notify(error.message,true);}finally{button.disabled=false;}
    });
  }
}

async function downloadNoteImage(button, note) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '正在导出…';
  button.setAttribute('aria-busy', 'true');
  try {
    let module;
    try { module = await import('/note-image-export.js?v=20261102-note-image' + (noteImageExportRetry ? `&retry=${noteImageExportRetry}` : '')); }
    catch { noteImageExportRetry++; throw new Error('导出组件加载失败，请重试。'); }
    const { exportNoteImage } = module;
    await exportNoteImage(note);
    notify('便签图片已导出。');
  } catch (error) { notify(error.message, true); }
  finally {
    button.disabled = noteListBusy && body.contains(button);
    button.textContent = label;
    button.removeAttribute('aria-busy');
  }
}

async function notes() {
  const request = ++noteListRequest;
  const { notes: items } = await api('/api/profile/notes');
  if (request !== noteListRequest) return;
  const groups = [
    { isPinned: true, title: '置顶便签', description: '优先展示在公开主页' },
    { isPinned: false, title: '其他便签', description: '按下方顺序展示，新便签默认加入本组首位' },
  ].map(group => ({ ...group, items: items.filter(note => note.isPinned === group.isPinned) }));
  body.innerHTML = `<section class="panel notes-manager"><div class="panel-heading"><div><h2>我的便签 <span class="notes-total">${items.length} / 100</span></h2><p>把重要内容置顶，其余随心编排。</p></div><button type="button" class="button primary" id="create-note" ${items.length >= 100 ? 'disabled' : ''}>写便签</button></div><p class="notes-order-guide">置顶便签优先展示。组内可前后移动或指定位置，调整后立即保存到公开主页。</p>${groups.filter(group => group.items.length).map(group => `<section class="notes-group" aria-labelledby="notes-${group.isPinned ? 'pinned' : 'regular'}-title"><div class="notes-group-heading"><h3 id="notes-${group.isPinned ? 'pinned' : 'regular'}-title">${group.title}<span>${group.items.length}</span></h3><p>${group.description}</p></div><ol class="workspace-notes">${group.items.map((note, index) => `<li class="workspace-note${note.isPinned ? ' is-pinned' : ''}" data-note-id="${escapeHtml(note.id)}"><div class="workspace-note-heading"><span class="workspace-note-number" aria-label="本组第 ${index + 1} 条">${String(index + 1).padStart(2, '0')}</span><div><h4 class="workspace-note-title"><button type="button" data-preview-note="${escapeHtml(note.id)}">${escapeHtml(note.title)}</button></h4><p class="workspace-note-date">${note.updatedAt !== note.createdAt ? '编辑于 ' + date(note.updatedAt) : '创建于 ' + date(note.createdAt)}</p></div>${note.isPinned ? '<span class="note-pin-badge">置顶</span>' : ''}</div><p class="workspace-note-content">${escapeHtml(note.content)}</p><div class="workspace-note-footer"><div class="workspace-note-actions"><button type="button" class="button secondary small" data-edit-note="${escapeHtml(note.id)}">编辑</button><button type="button" class="button secondary small" data-export-note="${escapeHtml(note.id)}">导出图片</button><button type="button" class="button secondary small" data-pin-note="${escapeHtml(note.id)}">${note.isPinned ? '取消置顶' : '置顶'}</button><button type="button" class="button ghost small" data-delete-note="${escapeHtml(note.id)}">删除</button></div><div class="note-order-controls"><div class="note-order-buttons" role="group" aria-label="调整${escapeHtml(note.title)}的组内顺序"><button type="button" class="button secondary small" data-note-move="first" data-id="${escapeHtml(note.id)}" ${index === 0 ? 'disabled' : ''}>最前</button><button type="button" class="button secondary small" data-note-move="previous" data-id="${escapeHtml(note.id)}" ${index === 0 ? 'disabled' : ''}>上移</button><button type="button" class="button secondary small" data-note-move="next" data-id="${escapeHtml(note.id)}" ${index === group.items.length - 1 ? 'disabled' : ''}>下移</button><button type="button" class="button secondary small" data-note-move="last" data-id="${escapeHtml(note.id)}" ${index === group.items.length - 1 ? 'disabled' : ''}>最后</button></div><form class="note-position-form" data-note-position="${escapeHtml(note.id)}"><label>移至<input type="number" name="position" min="1" max="${group.items.length}" step="1" value="${index + 1}" required aria-label="${escapeHtml(note.title)}在${group.title}中的目标位置"><span>/ ${group.items.length}</span></label><button type="submit" class="button secondary small" ${group.items.length === 1 ? 'disabled' : ''}>移动</button></form></div></div></li>`).join('')}</ol></section>`).join('') || '<div class="notes-empty"><span aria-hidden="true">✎</span><h3>还没有便签</h3><p>写下想拍的主题、拍摄计划或最近的灵感。</p><button type="button" class="button secondary" id="create-first-note">写第一条便签</button></div>'}</section>`;

  async function saveArrangement(path, data, message, noteId) {
    if (noteListBusy) return;
    noteListBusy = true;
    noteListRequest++;
    const manager = body.querySelector('.notes-manager');
    const controls = [...manager.querySelectorAll('button,input')].map(control => [control, control.disabled]);
    manager.setAttribute('aria-busy', 'true');
    controls.forEach(([control]) => { control.disabled = true; });
    let saved = false;
    try {
      await api(path, 'POST', data);
      saved = true;
      await notes();
      notify(message);
      body.querySelector(`[data-pin-note="${CSS.escape(noteId)}"]`)?.focus();
    } catch (error) {
      notify(saved ? '调整已保存，但列表刷新失败，请刷新页面查看最新顺序。' : error.message, true);
    } finally {
      noteListBusy = false;
      manager.removeAttribute('aria-busy');
      controls.forEach(([control, disabled]) => { control.disabled = control.hasAttribute('data-export-note') ? control.getAttribute('aria-busy') === 'true' : disabled; });
    }
  }

  async function moveNote(id, target) {
    const note = items.find(item => item.id === id);
    const group = items.filter(item => item.isPinned === note.isPinned);
    const from = group.findIndex(item => item.id === id);
    if (!Number.isInteger(target) || target < 0 || target >= group.length) {
      notify(`请输入 1–${group.length} 之间的组内位置。`, true);
      return;
    }
    if (from === target) return;
    const groupIds = group.map(item => item.id);
    groupIds.splice(target, 0, groupIds.splice(from, 1)[0]);
    let position = 0;
    const ids = items.map(item => item.isPinned === note.isPinned ? groupIds[position++] : item.id);
    await saveArrangement('/api/profile/notes/order', { ids }, '便签顺序已保存。', id);
  }

  body.querySelector('#create-note').addEventListener('click', () => noteEditor());
  body.querySelector('#create-first-note')?.addEventListener('click', () => noteEditor());
  body.querySelectorAll('[data-edit-note]').forEach(button => button.addEventListener('click', () => noteEditor(items.find(note => note.id === button.dataset.editNote))));
  body.querySelectorAll('[data-export-note]').forEach(button => button.addEventListener('click', () => {
    void downloadNoteImage(button, items.find(note => note.id === button.dataset.exportNote));
  }));
  body.querySelectorAll('[data-pin-note]').forEach(button => button.addEventListener('click', () => {
    const note = items.find(item => item.id === button.dataset.pinNote);
    void saveArrangement('/api/profile/notes/pin', { id: note.id, isPinned: !note.isPinned }, note.isPinned ? '已取消置顶，便签移至其他便签首位。' : '便签已置顶，并移至置顶组首位。', note.id);
  }));
  body.querySelectorAll('[data-note-move]').forEach(button => button.addEventListener('click', () => {
    const note = items.find(item => item.id === button.dataset.id);
    const group = items.filter(item => item.isPinned === note.isPinned);
    const index = group.findIndex(item => item.id === note.id);
    const positions = { first: 0, previous: index - 1, next: index + 1, last: group.length - 1 };
    void moveNote(note.id, positions[button.dataset.noteMove]);
  }));
  body.querySelectorAll('[data-note-position]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    void moveNote(form.dataset.notePosition, Number(form.elements.position.value) - 1);
  }));
  body.querySelectorAll('[data-preview-note]').forEach(button => button.addEventListener('click', async () => {
    const note = items.find(item => item.id === button.dataset.previewNote);
    const element = dialog(`${dialogHeading(escapeHtml(note.title))}<div class="note-reading-content">正在加载便签…</div><div class="form-actions"><button type="button" class="button secondary" data-close>关闭</button><button type="button" class="button secondary" data-export-preview>导出图片</button><button type="button" class="button primary" data-edit-preview>编辑便签</button></div>`);
    element.classList.add('note-reading-dialog');
    element.setAttribute('aria-label', note.title);
    element.querySelector('[data-edit-preview]').addEventListener('click', () => { element.close(); noteEditor(note); });
    element.querySelector('[data-export-preview]').addEventListener('click', event => { void downloadNoteImage(event.currentTarget, note); });
    const content = element.querySelector('.note-reading-content');
    try { await renderNoteMarkdown(note.content, content); }
    catch {
      if (!element.open) return;
      content.textContent = note.content;
      content.classList.add('note-reading-fallback');
      notify('Markdown 排版加载失败，当前显示原文。', true);
    }
  }));

  body.querySelectorAll('[data-delete-note]').forEach(button => button.addEventListener('click', () => {
    const element = dialog(`${dialogHeading('删除便签')}<p class="muted">这条便签会从公开主页移除，删除后无法恢复。</p><div class="form-actions"><button type="button" class="button secondary" data-close>取消</button><button type="button" class="button primary" id="confirm-delete-note">确认删除</button></div>`);
    let deleting = false;
    element.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
    element.querySelector('#confirm-delete-note').addEventListener('click', async () => {
      deleting = true;
      element.querySelectorAll('button').forEach(control => { control.disabled = true; });
      try {
        await api('/api/profile/notes', 'DELETE', { id: button.dataset.deleteNote });
        element.close();
        await notes();
        notify('便签已删除。');
      } catch (error) { notify(error.message, true); }
      finally { deleting = false; element.querySelectorAll('button').forEach(control => { control.disabled = false; }); }
    });
  }));
}

function noteEditor(note) {
  const noteId = note?.id;
  const savedTitle = note?.title ?? '';
  const savedContent = note?.content ?? '';
  const element = dialog(`<div class="dialog-heading"><div><h2>${note ? '编辑便签' : '写便签'}</h2><p class="muted">使用下方格式工具编写 Markdown，右侧实时预览。</p></div><button type="button" class="dialog-close" id="close-note-editor" aria-label="关闭便签编辑器">×</button></div><div class="note-editor-body"></div>`);
  element.classList.add('note-editor-dialog');
  element.setAttribute('aria-label', note ? '编辑便签' : '写便签');
  let dirty = false;
  let saving = false;
  let closed = false;
  let previewTimer;
  let previewRequest = 0;
  const listeners = new AbortController();
  const signal = listeners.signal;
  const formats = [['heading','标题'],['bold','加粗'],['italic','斜体'],['strike','删除线'],['quote','引用'],['bullet','无序列表'],['ordered','有序列表'],['task','任务列表'],['code','行内代码'],['codeblock','代码块'],['link','链接'],['image','本站图片'],['table','表格'],['divider','分割线']];
  const example = '## 小标题\n\n**加粗**、*斜体*、~~删除线~~\n\n> 引用文字\n\n- 无序列表\n1. 有序列表\n- [ ] 待办事项\n- [x] 已完成事项\n\n[链接文字](https://example.com)\n![图片说明](/api/media/图片ID)\n\n`行内代码`\n\n```js\nconsole.log("代码块");\n```\n\n| 列名 | 列名 |\n| --- | --- |\n| 内容 | 内容 |\n\n---';
  element.querySelector('.note-editor-body').innerHTML = `<form class="note-editor" id="note-editor-form" data-mode="edit"><section class="note-editor-heading"><label>标题<input name="title" maxlength="80" value="${escapeHtml(savedTitle)}" placeholder="便签标题" required></label><details class="note-markdown-help"><summary>查看 Markdown 语法示例</summary><p>选中文字后点击格式按钮，也可以直接输入以下语法。图片地址请使用本站已有图片地址，外部图片不会自动加载。</p><pre>${escapeHtml(example)}</pre></details></section><div class="note-editor-view" role="group" aria-label="切换编辑和预览"><button type="button" data-mode="edit" aria-pressed="true">编辑</button><button type="button" data-mode="preview" aria-pressed="false">预览</button></div><div class="note-editor-grid"><section class="note-source-panel" aria-label="Markdown 源码"><div class="note-format-tools" role="toolbar" aria-label="Markdown 格式">${formats.map(([format,label]) => `<button type="button" data-format="${format}" title="${label}">${label}</button>`).join('')}</div><label class="sr-only" for="note-source">Markdown 正文</label><textarea id="note-source" name="content" maxlength="20000" spellcheck="false" placeholder="输入正文，或使用上方工具添加标题、列表和表格…" required>${escapeHtml(savedContent)}</textarea><div class="note-source-footer"><span id="note-character-count"></span><span>Tab 缩进 · Shift+Tab 取消缩进</span></div></section><section class="note-preview-panel" aria-label="Markdown 实时预览"><h2>实时预览</h2><div id="note-preview"></div></section></div><section class="note-close-confirm" role="alert" hidden><p>有未保存的修改，确定放弃吗？</p><div><button type="button" class="button secondary" id="continue-note-edit">继续编辑</button><button type="button" class="button ghost" id="discard-note-edit">放弃修改并关闭</button></div></section><footer class="note-editor-actions"><span id="note-save-state" role="status"></span><div><button type="button" class="button secondary" id="cancel-note-edit">取消</button><button type="button" class="button secondary" id="export-note-draft">导出图片</button><button type="submit" class="button primary" id="save-note">保存便签 <span class="note-shortcut" aria-hidden="true">Ctrl / ⌘ + S</span></button></div></footer></form>`;
  const form = element.querySelector('#note-editor-form');
  const title = form.querySelector('[name=title]');
  const source = form.querySelector('#note-source');
  const preview = form.querySelector('#note-preview');
  const status = form.querySelector('#note-save-state');
  const save = form.querySelector('#save-note');
  const closePrompt = form.querySelector('.note-close-confirm');
  preview.textContent = '正在加载预览…';

  function requestClose() {
    if (saving) return;
    if (!dirty) { closed = true; element.close(); return; }
    closePrompt.hidden = false;
    closePrompt.querySelector('#continue-note-edit').focus();
  }

  element.querySelector('#close-note-editor').addEventListener('click', requestClose);
  form.querySelector('#cancel-note-edit').addEventListener('click', requestClose);
  form.querySelector('#export-note-draft').addEventListener('click', event => {
    if (saving) return;
    title.setCustomValidity(title.value.trim() ? '' : '请填写便签标题。');
    source.setCustomValidity(source.value.trim() ? '' : '请填写便签正文。');
    if (!title.value.trim() || !source.value.trim()) {
      form.dataset.mode = 'edit';
      form.querySelectorAll('.note-editor-view button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === 'edit')));
    }
    const valid = form.reportValidity();
    title.setCustomValidity('');
    source.setCustomValidity('');
    if (!valid) return;
    void downloadNoteImage(event.currentTarget, { title: title.value.trim(), content: source.value });
  });
  form.querySelector('#continue-note-edit').addEventListener('click', () => { closePrompt.hidden = true; source.focus(); });
  form.querySelector('#discard-note-edit').addEventListener('click', () => { if (!saving) { closed = true; element.close(); } });
  element.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  element.addEventListener('click', event => {
    if (event.target !== element) return;
    const bounds = element.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestClose();
  });
  element.addEventListener('close', () => {
    closed = true;
    previewRequest++;
    clearTimeout(previewTimer);
    listeners.abort();
  }, { once: true });

  function updateState() {
    dirty = title.value !== savedTitle || source.value !== savedContent;
    form.querySelector('#note-character-count').textContent = `${source.value.length} / 20000 字符`;
    status.textContent = saving ? '正在保存…' : dirty ? '有未保存的修改' : noteId ? '已保存' : '尚未保存';
  }

  async function renderPreview() {
    clearTimeout(previewTimer);
    if (closed) return;
    const request = ++previewRequest;
    preview.setAttribute('aria-busy', 'true');
    try { await renderNoteMarkdown(source.value, preview); }
    catch (error) {
      if (request !== previewRequest) return;
      console.error('Markdown preview failed', error);
      preview.innerHTML = '<p>预览加载失败，以下显示原文。<button type="button" class="button secondary small">重试排版</button></p><pre class="note-markdown-fallback"></pre>';
      preview.querySelector('pre').textContent = source.value;
      preview.querySelector('button').addEventListener('click', renderPreview);
    } finally {
      if (request === previewRequest) preview.removeAttribute('aria-busy');
    }
  }

  function applyEdit(start, end, replacement, selectionStart, selectionEnd) {
    if (source.value.length - (end - start) + replacement.length > 20000) {
      notify('正文最多 20000 字符。', true);
      return;
    }
    source.setRangeText(replacement, start, end, 'preserve');
    source.setSelectionRange(selectionStart, selectionEnd);
    source.focus();
    source.dispatchEvent(new Event('input', { bubbles: true }));
  }

  title.addEventListener('input', updateState);
  source.addEventListener('input', () => {
    updateState();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 160);
  });
  form.querySelectorAll('[data-format]').forEach(button => button.addEventListener('click', () => {
    const start = source.selectionStart;
    const end = source.selectionEnd;
    const selected = source.value.slice(start, end);
    const format = button.dataset.format;
    const prefix = { heading: '## ', quote: '> ', bullet: '- ', ordered: '1. ', task: '- [ ] ' }[format];
    if (prefix) {
      const lineStart = start === 0 ? 0 : source.value.lastIndexOf('\n', start - 1) + 1;
      const lines = source.value.slice(lineStart, end).split('\n');
      applyEdit(lineStart, end, lines.map(line => prefix + line).join('\n'), start + prefix.length, end + prefix.length * lines.length);
      return;
    }
    if (format === 'table' || format === 'divider') {
      const block = format === 'table' ? `| 列名 | 列名 |\n| --- | --- |\n| ${selected || '内容'} | 内容 |` : '---';
      const replacement = (start === 0 ? '' : '\n\n') + block + '\n\n';
      applyEdit(start, end, replacement, start + replacement.length, start + replacement.length);
      return;
    }
    let before = { bold: '**', italic: '*', strike: '~~', code: '`', link: '[', image: '![' }[format];
    let after = format === 'link' ? '](https://)' : format === 'image' ? '](/api/media/图片ID)' : before;
    if (format === 'codeblock') {
      before = (start === 0 || source.value[start - 1] === '\n' ? '' : '\n') + '```\n';
      after = '\n```' + (end === source.value.length || source.value[end] === '\n' ? '' : '\n');
    }
    const selectionStart = format === 'link' && selected ? end + 3 : format === 'image' ? end + 4 : start + before.length;
    const selectionEnd = format === 'link' && selected ? selectionStart + 8 : format === 'image' ? selectionStart + 15 : end + before.length;
    applyEdit(start, end, before + selected + after, selectionStart, selectionEnd);
  }));
  source.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey || source.readOnly) return;
    event.preventDefault();
    const start = source.selectionStart;
    const end = source.selectionEnd;
    if (!event.shiftKey && start === end) { applyEdit(start, end, '  ', start + 2, end + 2); return; }
    const lineStart = start === 0 ? 0 : source.value.lastIndexOf('\n', start - 1) + 1;
    const blockEnd = end > start && source.value[end - 1] === '\n' ? end - 1 : end;
    const block = source.value.slice(lineStart, blockEnd);
    const lines = block.split('\n');
    const updated = lines.map(line => event.shiftKey ? line.replace(/^(?: {1,2}|\t)/, '') : '  ' + line);
    const replacement = updated.join('\n');
    const firstDelta = updated[0].length - lines[0].length;
    applyEdit(lineStart, blockEnd, replacement, Math.max(lineStart, start + firstDelta), end + replacement.length - block.length);
  });
  form.querySelectorAll('.note-editor-view button').forEach(button => button.addEventListener('click', () => {
    form.dataset.mode = button.dataset.mode;
    form.querySelectorAll('.note-editor-view button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    if (button.dataset.mode === 'preview') renderPreview();
  }));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const nextTitle = title.value.trim();
    const nextContent = source.value;
    if (!nextTitle) { notify('请填写 1–80 字的标题。', true); title.focus(); return; }
    if (!nextContent.trim()) { notify('请填写 1–20000 字符的正文。', true); source.focus(); return; }
    saving = true;
    title.readOnly = source.readOnly = true;
    save.disabled = true;
    form.querySelectorAll('[data-format]').forEach(button => { button.disabled = true; });
    updateState();
    let saved = false;
    try {
      await api('/api/profile/notes', noteId ? 'PATCH' : 'POST', noteId ? { id: noteId, title: nextTitle, content: nextContent } : { title: nextTitle, content: nextContent });
      if (closed) return;
      saved = true;
      dirty = false;
      notify('便签已保存，公开主页已更新。');
      closed = true;
      element.close();
      await notes();
    } catch (error) {
      if (saved) {
        console.error('Notes refresh failed after saving', error);
        feedback.textContent = '便签已保存，但列表刷新失败，请刷新页面。';
        feedback.className = 'form-message error';
        feedback.hidden = false;
      } else if (!closed) notify(error.message, true);
    }
    finally {
      saving = false;
      if (!closed) {
        title.readOnly = source.readOnly = false;
        save.disabled = false;
        form.querySelectorAll('[data-format]').forEach(button => { button.disabled = false; });
        updateState();
      }
    }
  });
  window.addEventListener('keydown', event => {
    if (closed) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!saving) form.requestSubmit();
    }
  }, { signal });
  window.addEventListener('beforeunload', event => {
    if (closed || (!dirty && !saving)) return;
    event.preventDefault();
    event.returnValue = '';
  }, { signal });
  updateState();
  void renderPreview();
  title.focus();
}

const pages={overview,accounts,invitations,profile,notes,visits,subscription};
pages[app.dataset.page]().catch(error=>notify(error.message,true));
if (app.dataset.page === 'notes') {
  let refreshing = false;
  const refreshNotes = async () => {
    if (refreshing || noteListBusy || document.querySelector('dialog[open]')) return;
    refreshing = true;
    try { await notes(); }
    catch (error) { notify(error.message, true); }
    finally { refreshing = false; }
  };
  window.addEventListener('focus', refreshNotes);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshNotes(); });
}
