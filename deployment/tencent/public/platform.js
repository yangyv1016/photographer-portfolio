/* eslint-disable @next/next/no-location-assign-relative-destination -- Standalone Node client; no Next.js client router is mounted. */
import { renderNoteMarkdown } from '/note-markdown.js?v=20261101-markdown';

const app = document.querySelector('#platform-app');
const body = document.querySelector('#platform-body');
const feedback = document.querySelector('#platform-feedback');

const escapeHtml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function bytes(value) {
  if (value < 1024) return `${value} B`;
  const unit = Math.min(Math.floor(Math.log(value)/Math.log(1024)),4);
  return `${(value/1024**unit).toFixed(unit > 1 ? 2 : 0)} ${['B','KiB','MiB','GiB','TiB'][unit]}`;
}
const date = value => value ? new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '长期有效';
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
    <article class="stat-card"><span class="stat-label">照片与资料图片</span><strong>${bytes(data.storageBytes)}</strong><small>${data.storageComplete ? '已核对 COS 对象大小' : '历史照片容量核对中'}</small></article>
    <article class="stat-card"><span class="stat-label">待完成上传</span><strong>${bytes(data.pendingBytes)}</strong><small>已为上传任务预留容量</small></article>
    </div><div class="resource-grid"><section class="panel"><div class="panel-heading"><h2>服务器资源</h2><button class="button ghost" id="refresh-overview">刷新</button></div>
    ${resource('系统内存',system.usedMemoryBytes,system.totalMemoryBytes,'Linux 使用可用内存计算，排除可回收缓存。')}
    ${resource('服务器磁盘',system.usedDiskBytes,system.totalDiskBytes,'服务器磁盘含系统、数据库和本地备份；照片原件存储在 COS。')}
    <div class="resource-row"><div class="resource-label"><span>网站进程内存</span><span>${bytes(system.appMemoryBytes)}</span></div><p class="resource-note">服务器已运行 ${Math.floor(system.uptimeSeconds/3600)} 小时。</p></div></section>
    <section class="panel"><div class="panel-heading"><h2>网络流量</h2><span class="badge">服务器自启动累计</span></div><div class="traffic-values"><div><small>接收</small><strong>${system.network ? bytes(system.network.receivedBytes) : '当前系统不提供'}</strong></div><div><small>发送</small><strong>${system.network ? bytes(system.network.sentBytes) : '当前系统不提供'}</strong></div></div><div class="info-note">${escapeHtml(data.cloudTraffic.explanation)}</div></section></div>`;
  document.querySelector('#refresh-overview').addEventListener('click',()=>overview().catch(error=>notify(error.message,true)));
}

async function accounts() {
  const data = await api('/api/platform/accounts');
  body.innerHTML = `<section class="panel"><div class="panel-heading"><div><h2>摄影师账户</h2><p>${data.accounts.length} 个账户。点击「分配容量」单独设置每个账户的上传上限。</p></div><a class="button primary" href="/admin/invitations">邀请摄影师</a></div><div class="table-wrap"><table class="platform-table"><thead><tr><th>摄影师 / ID</th><th>状态</th><th>作品</th><th>已用 / 分配容量</th><th>加入时间</th><th>操作</th></tr></thead><tbody>${data.accounts.map(account=>`<tr><td><strong>${escapeHtml(account.displayName)}</strong><small>/${escapeHtml(account.publicId)} · ${escapeHtml(account.loginId)}</small></td><td><span class="badge ${account.deletedAt ? 'deleted' : account.active ? 'active' : 'disabled'}">${account.deletedAt ? '回收站' : account.active ? '正常' : '停用'}</span>${account.role === 'admin' ? ' <span class="badge admin">管理员</span>' : ''}</td><td>${account.photoCount} 张<small>${account.seriesCount} 个系列</small></td><td><strong>${bytes(account.storageBytes)} / ${bytes(account.quotaBytes)}</strong><div class="meter account-storage-meter"><span style="width:${Math.min(100,Math.round((account.storageBytes+account.pendingBytes)/account.quotaBytes*100))}%"></span></div><small>剩余 ${bytes(account.availableBytes)}${account.pendingBytes ? ` · 待上传 ${bytes(account.pendingBytes)}` : ''}${account.storageComplete ? '' : ' · 容量核对中'}</small></td><td>${date(account.createdAt)}</td><td class="actions"><button type="button" class="button secondary small" data-quota="${account.id}">分配容量</button><a class="button ghost small" href="/${escapeHtml(account.publicId)}">主页 ↗</a>${account.role !== 'admin' ? account.deletedAt ? `<button type="button" class="button ghost small" data-account="${account.id}" data-action="restore">恢复</button>` : `<button type="button" class="button ghost small" data-account="${account.id}" data-action="${account.active ? 'disable' : 'enable'}">${account.active ? '停用' : '启用'}</button><button type="button" class="button ghost small" data-account="${account.id}" data-action="trash">回收站</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section>`;
  body.querySelectorAll('[data-quota]').forEach(button=>button.addEventListener('click',()=>{
    const account = data.accounts.find(item=>item.id === Number(button.dataset.quota));
    const element = dialog(`${dialogHeading('分配上传容量')}<p class="field-note">${escapeHtml(account.displayName)} · 已用 ${bytes(account.storageBytes)} · 待上传 ${bytes(account.pendingBytes)}</p><form><label>上传容量上限（GiB）<input type="number" name="quota" min="${1/1024**3}" step="any" value="${account.quotaBytes/1024**3}" required></label><p class="field-note">必须大于 0。照片、头像、封面和待完成上传共同计入容量；调低上限不会删除已有照片，超额后将停止继续上传。</p><div class="form-actions"><button type="button" class="button secondary" data-close>取消</button><button type="submit" class="button primary">保存容量</button></div></form>`);
    element.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault(); const submit=element.querySelector('[type=submit]');submit.disabled=true;
      try { await api('/api/platform/accounts','PATCH',{id:account.id,action:'quota',quotaBytes:Math.round(Number(new FormData(event.currentTarget).get('quota'))*1024**3)});element.close();await accounts();notify('上传容量已保存。'); }
      catch(error){notify(error.message,true);} finally{submit.disabled=false;}
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

async function invitations(page=1) {
  const data=await api(`/api/platform/invitations?page=${page}`);
  body.innerHTML=`<section class="panel"><div class="panel-heading"><div><h2>邀请码</h2><p>一个邀请码仅可注册一个账户。</p></div><button type="button" class="button primary" id="create-invitation">生成邀请码</button></div><div class="table-wrap"><table class="platform-table"><thead><tr><th>邀请码摘要 / 备注</th><th>状态</th><th>注册账户</th><th>初始配额</th><th>有效期</th><th>操作</th></tr></thead><tbody>${data.invitations.map(item=>{const state=item.usedAt ? '已使用' : item.revokedAt ? '已撤销' : item.expiresAt && item.expiresAt<=Date.now() ? '已过期' : '未使用';return `<tr><td><strong>${escapeHtml(item.hint)}</strong><small>${escapeHtml(item.note)}</small></td><td><span class="badge ${state === '未使用' ? 'active' : ''}">${state}</span></td><td>${item.usedBy ? escapeHtml(item.usedBy) : '—'}</td><td>${bytes(item.quotaBytes)}</td><td>${date(item.expiresAt)}</td><td>${!item.usedAt && !item.revokedAt ? `<button type="button" class="button ghost small" data-revoke="${item.id}">撤销</button>` : '—'}</td></tr>`;}).join('') || '<tr><td colspan="6" class="empty-state">还没有邀请码，点击右上角生成。</td></tr>'}</tbody></table></div></section>`;
  document.querySelector('#create-invitation').addEventListener('click',()=>{
    const element=dialog(`${dialogHeading('生成邀请码')}<form><div class="form-row"><label>数量<input name="count" type="number" value="1" min="1" max="50" step="1" required></label><label>有效期<select name="days"><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="0">长期有效</option></select></label></div><label>新账户上传容量（GiB）<input name="quota" type="number" min="${1/1024**3}" step="any" value="${data.defaultQuotaBytes/1024**3}" required></label><p class="field-note">必须大于 0，注册后可在账户管理中单独调整。</p><label>备注（选填）<input name="note" maxlength="80"></label><div class="form-actions"><button type="button" class="button secondary" data-close>取消</button><button class="button primary" type="submit">生成</button></div></form>`);
    element.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault();const form=new FormData(event.currentTarget);const submit=element.querySelector('[type=submit]');submit.disabled=true;
      try{
        const result=await api('/api/platform/invitations','POST',{count:Number(form.get('count')),days:Number(form.get('days')),quotaBytes:Math.round(Number(form.get('quota'))*1024**3),note:form.get('note')});
        element.close();await invitations();
        const created=dialog(`${dialogHeading('邀请码已生成')}<p class="field-note">完整邀请码只在这里显示一次，请复制保存。每个邀请码只能注册一个账户。</p><label>邀请码<textarea id="new-codes" rows="${Math.min(result.codes.length+1,12)}" readonly>${escapeHtml(result.codes.join('\n'))}</textarea></label><div class="form-actions"><button type="button" class="button secondary" data-close>完成</button><button type="button" class="button primary" id="copy-codes">复制邀请码</button></div>`);
        created.querySelector('#copy-codes').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(result.codes.join('\n'));notify('邀请码已复制。');}catch{created.querySelector('#new-codes').select();notify('请选中文本手动复制。');}});
      }catch(error){notify(error.message,true);}finally{submit.disabled=false;}
    });
  });
  body.querySelectorAll('[data-revoke]').forEach(button=>button.addEventListener('click',async()=>{
    button.disabled=true;
    try{await api('/api/platform/invitations','DELETE',{id:button.dataset.revoke});await invitations(data.page);notify('邀请码已撤销。');}
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
  body.innerHTML=`<div class="profile-layout"><div><section class="panel profile-cover-panel"><div class="panel-heading"><h2>主页封面</h2><span class="badge">16:9</span></div><div id="cover-preview" class="profile-cover-preview">${account.coverUrl ? `<img src="${escapeHtml(account.coverUrl)}" alt="主页封面">` : '<span>还未上传封面</span>'}</div><div class="cover-actions"><label class="button secondary" for="cover-file" style="margin:0;cursor:pointer">上传封面</label><input type="file" id="cover-file" accept="image/jpeg,image/png,image/webp,image/gif" class="sr-only"><button type="button" class="button ghost" id="remove-cover" ${account.coverUrl ? '' : 'hidden'}>移除封面</button></div><p class="field-note">头像、摄影师名称与个性签名显示在封面左上方，个人简介显示在身份信息下方；未上传封面时不预留图片区域。</p></section><section class="panel profile-cover-panel"><div class="panel-heading"><h2>目录卡片背景</h2><span class="badge">16:10</span></div><div id="directory-cover-preview" class="profile-cover-preview directory-cover-preview">${account.directoryCoverUrl || account.coverUrl ? `<img src="${escapeHtml(account.directoryCoverUrl || account.coverUrl)}" alt="目录卡片背景">` : '<span>还未设置背景</span>'}</div><div class="cover-actions"><label class="button secondary" for="directory-cover-file" style="margin:0;cursor:pointer">上传独立背景</label><input type="file" id="directory-cover-file" accept="image/jpeg,image/png,image/webp,image/gif" class="sr-only"><button type="button" class="button secondary" id="adjust-directory-cover" ${account.directoryCoverUrl || account.coverUrl ? '' : 'disabled'}>调整当前背景</button><button type="button" class="button ghost" id="remove-directory-cover" ${account.directoryCoverUrl ? '' : 'hidden'}>恢复使用主页封面</button></div><p class="field-note">默认沿用主页封面，可单独上传或裁切目录背景。头像、名字、签名、地区和简介使用下方资料，目录中只展示摘要。</p></section><section class="panel"><div class="panel-heading"><h2>个人资料</h2></div><div class="avatar-editor"><div id="avatar-preview">${account.avatarUrl ? `<img src="${escapeHtml(account.avatarUrl)}" alt="账户头像">` : ''}</div><div class="avatar-actions"><label class="button secondary" for="avatar-file" style="margin:0;cursor:pointer">上传头像</label><input type="file" id="avatar-file" accept="image/jpeg,image/png,image/webp,image/gif" class="sr-only"><button type="button" class="button ghost" id="remove-avatar" ${account.avatarUrl ? '' : 'hidden'}>移除</button></div></div><form id="profile-form"><label>摄影师名称<input name="displayName" maxlength="40" value="${escapeHtml(account.displayName)}" required></label><label>个人站名<input name="siteName" maxlength="40" value="${escapeHtml(account.siteName)}" required></label><label>主页访问 ID<input name="publicId" pattern="[a-z][a-z0-9_-]{2,23}" maxlength="24" value="${escapeHtml(account.publicId)}" required></label><p class="field-note">更改主页 ID 只更新访问地址，作品和登录账号均保留；旧链接仍可访问。</p><label>个性签名（选填）<textarea name="bio" maxlength="240" rows="4">${escapeHtml(account.bio)}</textarea></label><label>地区（选填）<input name="region" maxlength="80" value="${escapeHtml(account.region)}"></label><p class="field-note">可自定义地区文字，不读取设备定位。</p><label>个人简介（选填）<textarea name="introduction" maxlength="1000" rows="6">${escapeHtml(account.introduction)}</textarea></label><label class="checkbox-label"><input type="checkbox" name="showPhotoNames" ${account.showPhotoNames ? 'checked' : ''}>公开展示文件名</label><p class="field-note">默认关闭；关闭时，照片墙悬停提示和放大浏览不显示文件名，后台管理仍保留。</p><label class="checkbox-label"><input type="checkbox" name="listed" ${account.listed ? 'checked' : ''}>出现在摄影师目录</label><p class="field-note">取消后，个人主页仍可通过地址访问。</p><div class="form-actions"><button class="button primary" type="submit">保存资料</button></div></form></section></div><div><section class="panel"><h2>我的个人主页</h2><a class="profile-url" href="/${escapeHtml(account.publicId)}">${escapeHtml(location.origin)}/${escapeHtml(account.publicId)} ↗</a><h3 style="margin-top:1.8rem">存储用量</h3><div class="storage-total">${bytes(usage.storageBytes)}</div><p id="profile-storage-summary" class="field-note">容量上限：${bytes(account.quotaBytes)} · 剩余 ${bytes(usage.availableBytes)} · ${usage.photoCount} 张照片</p>${usage.storageComplete ? '' : '<p class="field-note">历史照片容量核对中。</p>'}${usage.pendingBytes ? `<p class="field-note" id="profile-pending">待完成上传：${bytes(usage.pendingBytes)}</p>` : ''}</section><section class="panel"><h2>登录账号</h2><form id="login-id-form"><label>登录名<input name="loginId" autocomplete="username" pattern="[a-z][a-z0-9_-]{2,23}" minlength="3" maxlength="24" value="${escapeHtml(account.loginId)}" required></label><p class="field-note">3–24 位小写字母、数字、下划线或连字符，以字母开头。仅用于登录，与主页访问 ID 独立；修改需二次确认和当前密码，完成后所有设备需重新登录。</p><div class="form-actions"><button class="button secondary" type="submit">修改登录名</button></div></form></section><section class="panel"><h2>修改密码</h2><form id="password-form"><label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required></label><label>新密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><label>确认新密码<input name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><div class="form-actions"><button class="button secondary" type="submit">修改密码</button></div></form></section></div></div>`;
  const refreshUsage=async()=>{
    const fresh=await api('/api/profile');
    document.querySelector('.storage-total').textContent=bytes(fresh.usage.storageBytes);
    document.querySelector('#profile-storage-summary').textContent=`容量上限：${bytes(fresh.account.quotaBytes)} · 剩余 ${bytes(fresh.usage.availableBytes)} · ${fresh.usage.photoCount} 张照片`;
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
  document.querySelector('#profile-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=new FormData(event.currentTarget);const submit=event.currentTarget.querySelector('[type=submit]');submit.disabled=true;
    try{await api('/api/profile','PATCH',{displayName:form.get('displayName'),siteName:form.get('siteName'),publicId:form.get('publicId'),bio:form.get('bio'),introduction:form.get('introduction'),region:form.get('region'),showPhotoNames:form.has('showPhotoNames'),listed:form.has('listed')});document.querySelector('.sidebar-account strong').textContent=form.get('displayName');location.reload();}
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

async function notes() {
  const { notes: items } = await api('/api/profile/notes');
  body.innerHTML = `<section class="panel notes-manager"><div class="panel-heading"><div><h2>我的便签</h2><p>保存后会展示在你的公开主页。</p></div><button type="button" class="button primary" id="create-note" ${items.length >= 100 ? 'disabled' : ''}>写便签</button></div><p class="field-note">${items.length} / 100 条 · 标题 1–80 字，正文 1–20000 字符，支持 Markdown；最新创建的便签排在前面。</p><div class="workspace-notes">${items.map(note => `<article class="workspace-note"><h3 class="workspace-note-title">${escapeHtml(note.title)}</h3><p class="workspace-note-content">${escapeHtml(note.content)}</p><div class="workspace-note-footer"><small>创建于 ${date(note.createdAt)}${note.updatedAt !== note.createdAt ? ` · 编辑于 ${date(note.updatedAt)}` : ''}</small><div><button type="button" class="button secondary small" data-edit-note="${escapeHtml(note.id)}">编辑</button><button type="button" class="button ghost small" data-delete-note="${escapeHtml(note.id)}">删除</button></div></div></article>`).join('') || '<p class="empty-state">还没有便签。点击「写便签」添加第一条。</p>'}</div></section>`;

  body.querySelector('#create-note').addEventListener('click', () => noteEditor());
  body.querySelectorAll('[data-edit-note]').forEach(button => button.addEventListener('click', () => noteEditor(items.find(note => note.id === button.dataset.editNote))));

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
  element.querySelector('.note-editor-body').innerHTML = `<form class="note-editor" id="note-editor-form" data-mode="edit"><section class="note-editor-heading"><label>标题<input name="title" maxlength="80" value="${escapeHtml(savedTitle)}" placeholder="便签标题" required></label><details class="note-markdown-help"><summary>查看 Markdown 语法示例</summary><p>选中文字后点击格式按钮，也可以直接输入以下语法。图片地址请使用本站已有图片地址，外部图片不会自动加载。</p><pre>${escapeHtml(example)}</pre></details></section><div class="note-editor-view" role="group" aria-label="切换编辑和预览"><button type="button" data-mode="edit" aria-pressed="true">编辑</button><button type="button" data-mode="preview" aria-pressed="false">预览</button></div><div class="note-editor-grid"><section class="note-source-panel" aria-label="Markdown 源码"><div class="note-format-tools" role="toolbar" aria-label="Markdown 格式">${formats.map(([format,label]) => `<button type="button" data-format="${format}" title="${label}">${label}</button>`).join('')}</div><label class="sr-only" for="note-source">Markdown 正文</label><textarea id="note-source" name="content" maxlength="20000" spellcheck="false" placeholder="输入正文，或使用上方工具添加标题、列表和表格…" required>${escapeHtml(savedContent)}</textarea><div class="note-source-footer"><span id="note-character-count"></span><span>Tab 缩进 · Shift+Tab 取消缩进</span></div></section><section class="note-preview-panel" aria-label="Markdown 实时预览"><h2>实时预览</h2><div id="note-preview"></div></section></div><section class="note-close-confirm" role="alert" hidden><p>有未保存的修改，确定放弃吗？</p><div><button type="button" class="button secondary" id="continue-note-edit">继续编辑</button><button type="button" class="button ghost" id="discard-note-edit">放弃修改并关闭</button></div></section><footer class="note-editor-actions"><span id="note-save-state" role="status"></span><div><button type="button" class="button secondary" id="cancel-note-edit">取消</button><button type="submit" class="button primary" id="save-note">保存便签 <span class="note-shortcut" aria-hidden="true">Ctrl / ⌘ + S</span></button></div></footer></form>`;
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

const pages={overview,accounts,invitations,profile,notes};
pages[app.dataset.page]().catch(error=>notify(error.message,true));
if (app.dataset.page === 'notes') {
  let refreshing = false;
  const refreshNotes = async () => {
    if (refreshing || document.querySelector('dialog[open]')) return;
    refreshing = true;
    try { await notes(); }
    catch (error) { notify(error.message, true); }
    finally { refreshing = false; }
  };
  window.addEventListener('focus', refreshNotes);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshNotes(); });
}
