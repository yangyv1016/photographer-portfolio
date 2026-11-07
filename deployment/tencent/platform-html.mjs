import { adminHtml } from '../../app/admin-html.ts';

const platformAssetsVersion = '20261107-storage-addons';

export function escapeHtml(value) {
  return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

function documentPage(title, body, script = false, noIndex = false) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${noIndex ? '<meta name="robots" content="noindex,nofollow">' : ''}<title>${escapeHtml(title)} · 摄影师作品展示</title><link rel="stylesheet" href="/platform.css?v=${platformAssetsVersion}"><link rel="stylesheet" href="/note-markdown.css?v=20261101-markdown">${script ? `<script type="module" src="/platform.js?v=${platformAssetsVersion}"></script><script type="module" src="/subscription.js?v=${platformAssetsVersion}"></script>` : ''}</head><body>${body}</body></html>`;
}

export function authPage(mode, error = '') {
  const registering = mode === 'register';
  return documentPage(registering ? '邀请码注册' : '登录', `<main class="auth-layout"><a class="platform-brand" href="/">摄影师作品展示<span>PHOTOGRAPHERS</span></a><section class="auth-card"><span class="eyebrow">${registering ? 'JOIN THE DIRECTORY' : 'WELCOME BACK'}</span><h1>${registering ? '创建摄影师账户' : '登录工作台'}</h1><p class="muted">${registering ? '使用邀请码或订阅兑换码注册。' : '管理你的作品与个人主页。'}</p>${error ? `<p class="form-message error" role="alert">${escapeHtml(error)}</p>` : ''}<form action="/${mode}" method="post">
    ${registering ? '<label>邀请码 / 兑换码<input name="invitation" autocomplete="off" maxlength="100" required></label><label>摄影师名称<input name="displayName" maxlength="40" autocomplete="nickname" required></label>' : ''}
    <label>登录 ID<input name="username" autocomplete="username" ${registering ? 'minlength="3" maxlength="24"' : 'maxlength="80"'} required></label>
    ${registering ? '<p class="field-note">3–24 位小写字母、数字、下划线或连字符；也将用于个人主页地址。</p>' : ''}
    <label>密码<input name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" ${registering ? 'minlength="12"' : ''} maxlength="256" required></label>
    ${registering ? '<label>确认密码<input name="passwordConfirmation" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><p class="field-note">密码至少 12 个字符。</p>' : ''}
    <button class="button primary full" type="submit">${registering ? '注册并进入工作台' : '登录'}</button></form><p class="auth-switch">${registering ? '已有账户？<a href="/login">去登录</a>' : '获得了邀请码？<a href="/register">注册账户</a>'}</p><p class="auth-claim-link"><a href="/claim">付款后领取兑换码 ↗</a></p></section><a class="quiet-link" href="/">返回摄影师目录 ↗</a></main>`);
}

export function claimDeliveryPage() {
  return documentPage('领取订阅兑换码', `<main class="auth-layout claim-layout"><a class="platform-brand" href="/">摄影师作品展示<span>PHOTOGRAPHERS</span></a><section class="auth-card claim-card" aria-labelledby="claim-title"><span class="eyebrow">订单发货</span><h1 id="claim-title">领取你的订阅兑换码</h1><p class="muted">填写爱发电订单号，核验通过后，兑换码会发送到下单账号的爱发电私信。</p><p id="afdian-claim-status" class="claim-status" role="status" aria-live="polite" data-kind="pending">正在检查发货通道…</p><form id="afdian-claim-form"><label for="afdian-order-number">爱发电订单号<input id="afdian-order-number" name="orderNo" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="100" placeholder="从爱发电订单详情复制完整订单号" disabled required></label><p class="field-note">请使用购买月卡、季卡或年卡时的订单号。</p><button id="afdian-claim-submit" class="button primary full" type="submit" disabled>触发发货</button></form><ol class="claim-steps" aria-label="领取步骤"><li><span aria-hidden="true">1</span><div><strong>复制订单号</strong><p>在爱发电的订单详情中找到对应订单。</p></div></li><li><span aria-hidden="true">2</span><div><strong>触发发货</strong><p>提交后核验付款与套餐，重复提交不会生成新的兑换码。</p></div></li><li><span aria-hidden="true">3</span><div><strong>查看爱发电私信</strong><p>登录下单的爱发电账号查看兑换码，再回到本站注册或续期。</p></div></li></ol><p class="claim-privacy">兑换码仅发送到购买账号的私信，不会显示在这个页面。无需先注册本站账户。</p><div class="claim-links"><a class="button secondary" href="/register">用码注册</a><a class="button secondary" href="/dashboard/subscription">已有账号续期</a></div></section><a class="quiet-link" href="/">返回摄影师目录 ↗</a></main><script type="module" src="/afdian-claim.js?v=20261107-order-claim"></script>`, false, true);
}

export function sidebar(account, active) {
  const navigation = [['/dashboard','photos','作品管理'],['/dashboard/profile','profile','个人资料'],['/dashboard/notes','notes','便签本'],['/dashboard/visits','visits','访问统计'],['/dashboard/subscription','subscription','订阅与容量']];
  const icons = {
    subscription: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
    visits: '<path d="M4 4v16h16M7 15l4-5 4 3 5-7"/>',
    notes:'<path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6V3Z"/><path d="M3 7h5m-5 5h5m-5 5h5m3-9h5m-5 4h5"/>',photos:'<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/>',profile:'<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',accounts:'<circle cx="9" cy="8" r="3"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M17 5a3 3 0 0 1 0 6m5 10v-2a6 6 0 0 0-4-6"/>',invitations:'<path d="M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4V5Z"/><path d="M15 5v3m0 3v2m0 3v3"/>'
  };
  if (account.role === 'admin') navigation.push(['/admin','overview','平台概览'],['/admin/accounts','accounts','账户管理'],['/admin/invitations','invitations','兑换码']);
  return `<aside class="platform-sidebar"><a href="/" class="platform-brand">摄影师作品展示<span>WORKSPACE</span></a><div class="sidebar-label">WORKSPACE</div><nav aria-label="工作台导航">${navigation.map(([href,id,label])=>`<a href="${href}" class="${id === active ? 'selected' : ''}" ${id === active ? 'aria-current="page"' : ''}><svg class="nav-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[id]}</svg>${label}</a>`).join('')}</nav><a class="sidebar-preview" href="/${escapeHtml(account.public_id)}">查看我的主页 ↗</a><div class="sidebar-account">${account.avatar_key ? `<img src="/api/avatars/${escapeHtml(account.public_id)}" alt="">` : ''}<div><strong>${escapeHtml(account.display_name)}</strong><small>${escapeHtml(account.login_id)}${account.role === 'admin' ? ' · 管理员' : ''}</small></div></div><form method="post" action="/logout"><button class="sidebar-logout" type="submit">退出登录</button></form></aside>`;
}

export function workspacePage(account, active) {
  const headings = {
    notes: ['便签本','写下随想，展示在个人主页的作品下方'],
    profile: ['个人资料','个人宣传页与账户信息'],
    visits: ['访问统计', account.role === 'admin' ? '查看全站及各摄影师主页的访问变化' : '查看个人主页的每日访问变化'],
    overview: ['平台概览','账户、资源与运行状态'],
    accounts: ['账户管理','管理摄影师账户与存储配额'],
    invitations: ['兑换码','生成注册与订阅续期共用的一次性兑换码'],
    subscription: ['订阅与容量','查看订阅、管理存储并兑换订阅码或扩容码']
  };
  const [title, description] = headings[active];
  const adminVisits = active === 'visits' && account.role === 'admin' ? ' data-visits-admin' : '';
  return documentPage(title, `<div class="workspace-layout">${sidebar(account,active)}<main class="platform-content" id="platform-app" data-page="${active}" data-account-role="${account.role}"${adminVisits}><div id="subscription-status" class="subscription-banner" role="status" hidden></div><header class="workspace-heading"><div><p class="eyebrow">${account.role === 'admin' && !['profile','notes'].includes(active) ? 'PLATFORM' : 'WORKSPACE'}</p><h1>${title}</h1><p class="muted">${description}</p></div><a class="button secondary" href="/">摄影师目录 ↗</a></header><p id="platform-feedback" class="form-message" role="status" hidden></p><div id="platform-body"><p class="loading-state">正在加载…</p></div></main></div>`,true);
}

export function photoWorkspace(account) {
  return adminHtml.replace('</head>',`<link rel="stylesheet" href="/platform.css?v=${platformAssetsVersion}"><script type="module" src="/subscription.js?v=${platformAssetsVersion}"></script></head>`)
    .replace('<body>',`<body class="photo-workspace"><div class="workspace-layout">${sidebar(account,'photos')}<div class="photo-workspace-content"><div id="subscription-status" class="subscription-banner" role="status" hidden></div>`)
    .replace('</body>','</div></div></body>')
    .replace('href="/">查看作品集</a>',`href="/${escapeHtml(account.public_id)}">查看我的主页 ↗</a>`)
    .replace('href="/#collections"',`href="/${escapeHtml(account.public_id)}#collections"`)
    .replace('<div class="heading-actions">','<div class="heading-actions"><a class="secondary" href="/dashboard/album">相册排序</a>')
    .replace('<span class="header-label">照片管理</span>',`<span class="header-label">作品管理 / ${escapeHtml(account.display_name)}</span>`);
}


export function subscriptionExpiredPage(account) {
  return documentPage('订阅已到期', `<main class="auth-layout subscription-expired-page"><a class="platform-brand" href="/">摄影师作品展示<span>PHOTOGRAPHERS</span></a><section class="auth-card"><span class="eyebrow">SUBSCRIPTION</span><h1>本用户订阅已到期，请及时订阅</h1><p class="muted">${escapeHtml(account.display_name)}的作品暂时停止公开展示。照片已保留，续订后恢复。</p><a class="button primary full" href="/dashboard/subscription">登录工作台续订</a><a class="quiet-link" href="/">返回摄影师目录 ↗</a></section></main>`, false, true);
}

export function directoryPage(accounts) {
  const cards = accounts.map(account=>{
    const cover = account.directory_cover_key ? `/api/directory-covers/${account.public_id}` : account.cover_key ? `/api/covers/${account.public_id}` : '';
    return `<a class="photographer-card${cover ? ' has-cover' : ''}" data-search="${escapeHtml((account.display_name+' '+account.public_id).toLowerCase())}" href="/${escapeHtml(account.public_id)}">${cover ? `<img class="directory-cover" src="${escapeHtml(cover)}" alt="" loading="lazy" draggable="false">` : ''}<div class="card-content"><div class="card-identity">${account.avatar_key ? `<img class="directory-avatar" src="/api/avatars/${escapeHtml(account.public_id)}" alt="${escapeHtml(account.display_name)}的头像" loading="lazy" draggable="false">` : ''}<div class="card-heading"><h2>${escapeHtml(account.display_name)}</h2>${account.bio ? `<p class="card-signature">${escapeHtml(account.bio)}</p>` : ''}${account.region ? `<p class="card-region"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><span>${escapeHtml(account.region)}</span></p>` : ''}</div><span class="card-arrow" aria-hidden="true">↗</span></div>${account.introduction ? `<p class="card-introduction">${escapeHtml(account.introduction)}</p>` : ''}<div class="card-meta"><span class="profile-id">/${escapeHtml(account.public_id)}</span><span class="card-count">${account.photoCount} 张作品 · ${account.seriesCount} 个系列</span></div></div></a>`;
  }).join('');
  return documentPage('摄影师', `<header class="directory-header"><a class="platform-brand" href="/">摄影师作品展示<span>PHOTOGRAPHERS</span></a><nav><a href="/login">登录工作台</a><a class="button primary" href="/register">邀请码注册</a></nav></header><main class="directory-main"><div class="directory-title"><div><p class="eyebrow">PHOTOGRAPHERS</p><h1>摄影师</h1></div><span>${accounts.length} 位创作者</span></div><form class="directory-search" role="search"><label class="sr-only" for="directory-query">搜索摄影师名称或 ID</label><input id="directory-query" type="search" name="q" placeholder="搜索摄影师名称或 ID" autocomplete="off"><button class="button secondary" type="submit">搜索</button></form><div class="photographer-directory">${cards}</div><p id="directory-empty" class="empty-state" ${accounts.length ? 'hidden' : ''}>暂无摄影师。</p></main><footer class="directory-footer"><span>摄影师作品展示</span><a href="/login">进入工作台 ↗</a></footer><script src="/directory.js?v=20261101-markdown" defer></script>`);
}
