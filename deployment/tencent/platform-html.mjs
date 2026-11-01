import { adminHtml } from '../../app/admin-html.ts';

export function escapeHtml(value) {
  return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

function documentPage(title, body, script = false) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 摄影师作品展示</title><link rel="stylesheet" href="/platform.css?v=20261102-notes-compact"><link rel="stylesheet" href="/note-markdown.css?v=20261101-markdown">${script ? '<script type="module" src="/platform.js?v=20261102-storage-modes"></script>' : ''}</head><body>${body}</body></html>`;
}

export function authPage(mode, error = '') {
  const registering = mode === 'register';
  return documentPage(registering ? '邀请码注册' : '登录', `<main class="auth-layout"><a class="platform-brand" href="/">摄影师作品展示<span>PHOTOGRAPHERS</span></a><section class="auth-card"><span class="eyebrow">${registering ? 'JOIN THE DIRECTORY' : 'WELCOME BACK'}</span><h1>${registering ? '创建摄影师账户' : '登录工作台'}</h1><p class="muted">${registering ? '使用管理员提供的邀请码注册。' : '管理你的作品与个人主页。'}</p>${error ? `<p class="form-message error" role="alert">${escapeHtml(error)}</p>` : ''}<form action="/${mode}" method="post">
    ${registering ? '<label>邀请码<input name="invitation" autocomplete="off" maxlength="100" required></label><label>摄影师名称<input name="displayName" maxlength="40" autocomplete="nickname" required></label>' : ''}
    <label>登录 ID<input name="username" autocomplete="username" ${registering ? 'minlength="3" maxlength="24"' : 'maxlength="80"'} required></label>
    ${registering ? '<p class="field-note">3–24 位小写字母、数字、下划线或连字符；也将用于个人主页地址。</p>' : ''}
    <label>密码<input name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" ${registering ? 'minlength="12"' : ''} maxlength="256" required></label>
    ${registering ? '<label>确认密码<input name="passwordConfirmation" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><p class="field-note">密码至少 12 个字符。</p>' : ''}
    <button class="button primary full" type="submit">${registering ? '注册并进入工作台' : '登录'}</button></form><p class="auth-switch">${registering ? '已有账户？<a href="/login">去登录</a>' : '获得了邀请码？<a href="/register">注册账户</a>'}</p></section><a class="quiet-link" href="/">返回摄影师目录 ↗</a></main>`);
}

export function sidebar(account, active) {
  const navigation = [['/dashboard','photos','作品管理'],['/dashboard/profile','profile','个人资料'],['/dashboard/notes','notes','便签本']];
  const icons={notes:'<path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6V3Z"/><path d="M3 7h5m-5 5h5m-5 5h5m3-9h5m-5 4h5"/>',photos:'<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/>',profile:'<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',accounts:'<circle cx="9" cy="8" r="3"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M17 5a3 3 0 0 1 0 6m5 10v-2a6 6 0 0 0-4-6"/>',invitations:'<path d="M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4V5Z"/><path d="M15 5v3m0 3v2m0 3v3"/>'};
  if (account.role === 'admin') navigation.push(['/admin','overview','平台概览'],['/admin/accounts','accounts','账户管理'],['/admin/invitations','invitations','邀请码']);
  return `<aside class="platform-sidebar"><a href="/" class="platform-brand">摄影师作品展示<span>WORKSPACE</span></a><div class="sidebar-label">WORKSPACE</div><nav aria-label="工作台导航">${navigation.map(([href,id,label])=>`<a href="${href}" class="${id === active ? 'selected' : ''}" ${id === active ? 'aria-current="page"' : ''}><svg class="nav-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[id]}</svg>${label}</a>`).join('')}</nav><a class="sidebar-preview" href="/${escapeHtml(account.public_id)}">查看我的主页 ↗</a><div class="sidebar-account">${account.avatar_key ? `<img src="/api/avatars/${escapeHtml(account.public_id)}" alt="">` : ''}<div><strong>${escapeHtml(account.display_name)}</strong><small>${escapeHtml(account.login_id)}${account.role === 'admin' ? ' · 管理员' : ''}</small></div></div><form method="post" action="/logout"><button class="sidebar-logout" type="submit">退出登录</button></form></aside>`;
}

export function workspacePage(account, active) {
  const headings = { notes: ['便签本','写下随想，展示在个人主页的作品下方'], profile: ['个人资料','个人宣传页与账户信息'], overview: ['平台概览','账户、资源与运行状态'], accounts: ['账户管理','管理摄影师账户与存储配额'], invitations: ['邀请码','邀请新的摄影师加入'] };
  const [title, description] = headings[active];
  return documentPage(title, `<div class="workspace-layout">${sidebar(account,active)}<main class="platform-content" id="platform-app" data-page="${active}"><header class="workspace-heading"><div><p class="eyebrow">${account.role === 'admin' && !['profile','notes'].includes(active) ? 'PLATFORM' : 'WORKSPACE'}</p><h1>${title}</h1><p class="muted">${description}</p></div><a class="button secondary" href="/">摄影师目录 ↗</a></header><p id="platform-feedback" class="form-message" role="status" hidden></p><div id="platform-body"><p class="loading-state">正在加载…</p></div></main></div>`,true);
}

export function photoWorkspace(account) {
  return adminHtml.replace('</head>','<link rel="stylesheet" href="/platform.css?v=20261102-notes-compact"></head>')
    .replace('<body>',`<body class="photo-workspace"><div class="workspace-layout">${sidebar(account,'photos')}<div class="photo-workspace-content">`)
    .replace('</body>','</div></div></body>')
    .replace('href="/">查看作品集</a>',`href="/${escapeHtml(account.public_id)}">查看我的主页 ↗</a>`)
    .replace('href="/#collections"',`href="/${escapeHtml(account.public_id)}#collections"`)
    .replace('<div class="heading-actions">','<div class="heading-actions"><a class="secondary" href="/dashboard/album">相册排序</a>')
    .replace('<span class="header-label">照片管理</span>',`<span class="header-label">作品管理 / ${escapeHtml(account.display_name)}</span>`);
}

export function directoryPage(accounts) {
  const cards = accounts.map(account=>{
    const cover = account.directory_cover_key ? `/api/directory-covers/${account.public_id}` : account.cover_key ? `/api/covers/${account.public_id}` : '';
    return `<a class="photographer-card${cover ? ' has-cover' : ''}" data-search="${escapeHtml((account.display_name+' '+account.public_id).toLowerCase())}" href="/${escapeHtml(account.public_id)}">${cover ? `<img class="directory-cover" src="${escapeHtml(cover)}" alt="" loading="lazy" draggable="false">` : ''}<div class="card-content"><div class="card-identity">${account.avatar_key ? `<img class="directory-avatar" src="/api/avatars/${escapeHtml(account.public_id)}" alt="${escapeHtml(account.display_name)}的头像" loading="lazy" draggable="false">` : ''}<div class="card-heading"><h2>${escapeHtml(account.display_name)}</h2>${account.bio ? `<p class="card-signature">${escapeHtml(account.bio)}</p>` : ''}${account.region ? `<p class="card-region"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><span>${escapeHtml(account.region)}</span></p>` : ''}</div><span class="card-arrow" aria-hidden="true">↗</span></div>${account.introduction ? `<p class="card-introduction">${escapeHtml(account.introduction)}</p>` : ''}<div class="card-meta"><span class="profile-id">/${escapeHtml(account.public_id)}</span><span class="card-count">${account.photoCount} 张作品 · ${account.seriesCount} 个系列</span></div></div></a>`;
  }).join('');
  return documentPage('摄影师', `<header class="directory-header"><a class="platform-brand" href="/">摄影师作品展示<span>PHOTOGRAPHERS</span></a><nav><a href="/login">登录工作台</a><a class="button primary" href="/register">邀请码注册</a></nav></header><main class="directory-main"><div class="directory-title"><div><p class="eyebrow">PHOTOGRAPHERS</p><h1>摄影师</h1></div><span>${accounts.length} 位创作者</span></div><form class="directory-search" role="search"><label class="sr-only" for="directory-query">搜索摄影师名称或 ID</label><input id="directory-query" type="search" name="q" placeholder="搜索摄影师名称或 ID" autocomplete="off"><button class="button secondary" type="submit">搜索</button></form><div class="photographer-directory">${cards}</div><p id="directory-empty" class="empty-state" ${accounts.length ? 'hidden' : ''}>暂无摄影师。</p></main><footer class="directory-footer"><span>摄影师作品展示</span><a href="/login">进入工作台 ↗</a></footer><script src="/directory.js?v=20261101-markdown" defer></script>`);
}
