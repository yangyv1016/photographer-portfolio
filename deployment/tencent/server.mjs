import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { root, origin } from './config.mjs';
import { getAccountGallery, getGalleryNotes, withAccount, closeDatabases } from './database.mjs';
import { getSession, requireSession, login, logout } from './auth.mjs';
import { platformDatabase, getPublicAccount } from './platform-database.mjs';
import { platformApi, accountUsage, backfillStorage } from './platform-api.mjs';
import { directoryPage, workspacePage, photoWorkspace } from './platform-html.mjs';
import { objectResponse } from './storage.mjs';
import { previewResponse } from './preview.mjs';
import { recordPublicVisit } from './visit-statistics.mjs';
import { uploadPart, finishUpload, startUpload } from './uploads.mjs';
import { renderPortfolio } from '../../app/route.ts';
import { renderAlbum } from '../../app/album.ts';
import { GET as photos } from '../../app/api/photos/route.ts';
import * as adminPhotos from '../../app/api/admin/photos/route.ts';
import * as series from '../../app/api/admin/series/route.ts';
import { POST as batch } from '../../app/api/admin/batch/route.ts';
import { POST as initialize } from '../../app/api/admin/initialize/route.ts';
import { POST as order } from '../../app/api/admin/order/route.ts';
import { POST as albumOrder } from '../../app/api/admin/album-order/route.ts';
import { DELETE as cancelUpload } from '../../app/api/admin/uploads/route.ts';
import { GET as exportScript } from '../../app/api/admin/export/route.ts';

const logError = console.error;
console.error = message => logError(message);
const staticFiles = new Map();
const publicDirectory = resolve(root, 'app/public');
for (const entry of await readdir(publicDirectory, { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) {
    const absolutePath = resolve(entry.parentPath, entry.name);
    staticFiles.set('/' + absolutePath.slice(publicDirectory.length + 1).replaceAll('\\', '/'), absolutePath);
  }
}
const routes = new Map([
  ['/api/photos', { GET: photos }],
  ['/api/admin/photos', adminPhotos], ['/api/admin/series', series],
  ['/api/admin/batch', { POST: batch }], ['/api/admin/order', { POST: order }], ['/api/admin/album-order', { POST: albumOrder }],
  ['/api/admin/initialize', { POST: initialize }],
  ['/api/admin/uploads', { POST: startUpload, PATCH: finishUpload, DELETE: cancelUpload }],
  ['/api/admin/upload-part', { GET: uploadPart, PUT: uploadPart }], ['/api/admin/export', { GET: exportScript }],
]);
const contentTypes = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' };

async function route(request, clientIp) {
  const url = new URL(request.url);
  const path = url.pathname;
  const imageResponse = url.searchParams.get('preview') === '1' ? previewResponse : objectResponse;
  if (path === '/healthz' && ['GET', 'HEAD'].includes(request.method)) return Response.json({ status: 'ok' });
  if (path === '/login' || path === '/admin/login') return login(request, clientIp);
  if (path === '/register') return login(request, clientIp, true);
  if ((path === '/logout' || path === '/admin/logout') && request.method === 'POST') return logout(request);
  const visitPage = path.match(/^\/api\/visits\/([a-z][a-z0-9_-]{2,23})$/);
  if (visitPage) return recordPublicVisit(request, visitPage[1], clientIp);
  if (path === '/' && request.method === 'GET') {
    const accounts = platformDatabase.prepare('SELECT * FROM users WHERE is_active=1 AND listed=1 AND deleted_at IS NULL ORDER BY created_at,id').all();
    return new Response(directoryPage(accounts.map(account=>({ ...account, ...accountUsage(account) }))), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const privatePath = path === '/admin' || path.startsWith('/admin/') || path === '/dashboard' || path.startsWith('/dashboard/') || path.startsWith('/api/admin/') || path.startsWith('/api/platform/') || path.startsWith('/api/profile') || path === '/api/session' || path === '/admin.js' || path === '/admin-client.js';
  if (privatePath) {
    const denied = requireSession(request);
    if (denied) return (path === '/admin' || path.startsWith('/admin/') || path === '/dashboard' || path.startsWith('/dashboard/')) && denied.status === 401 ? new Response(null, { status: 303, headers: { Location: '/login', 'Cache-Control': 'private, no-store' } }) : denied;
    const account = getSession(request);
    if ((path === '/admin' || path.startsWith('/admin/')) && account.role !== 'admin') return new Response('仅平台管理员可访问。', { status: 403 });
    return withAccount(account, async () => {
      if (path === '/dashboard' && request.method === 'GET') return new Response(photoWorkspace(account), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (path === '/dashboard/album' && request.method === 'GET') {
        const profile = { publicId: account.public_id, name: account.display_name, siteName: account.site_name, showPhotoNames: account.show_photo_names === 1 };
        return renderAlbum(profile, { selectedSeriesId: url.searchParams.get('series') ?? '', workspace: true });
      }
      const workspace = new Map([['/dashboard/profile','profile'],['/dashboard/notes','notes'],['/dashboard/visits','visits'],['/admin','overview'],['/admin/accounts','accounts'],['/admin/invitations','invitations']]);
      if (workspace.has(path) && request.method === 'GET') return new Response(workspacePage(account,workspace.get(path)), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (path.startsWith('/api/platform/') || path.startsWith('/api/profile') || path === '/api/session') return platformApi(request,account);
      if ((path === '/api/admin/export-image' || path === '/api/admin/download') && request.method === 'GET') {
        const photo = getAccountGallery(account.id,account.storage_id).sqlite.prepare('SELECT image_key,title,is_sample FROM photos WHERE id=?').get(new URL(request.url).searchParams.get('id') ?? '');
        if (!photo?.image_key || (path === '/api/admin/download' && photo.is_sample === 1)) return new Response('Photo not found', { status: 404 });
        const response = await objectResponse(photo.image_key);
        if (path === '/api/admin/download') {
          const extension = extname(photo.image_key).toLowerCase();
          let title = photo.title.replace(/\.(?:jpe?g|png|webp|gif)$/i, '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '') || 'photo';
          if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = `photo-${title}`;
          const filename = encodeURIComponent(title + extension).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
          response.headers.set('Content-Disposition', `attachment; filename="photo${extension}"; filename*=UTF-8''${filename}`);
        }
        return response;
      }
      if (path === '/api/admin/photos' && request.method === 'GET') {
        const response = await adminPhotos.GET(request);
        if (!response.ok) return response;
        const gallery = await response.json();
        return Response.json({ ...gallery, photos: gallery.photos.map(photo => photo.isSample ? photo : { ...photo, exportSrc: `/api/admin/export-image?id=${encodeURIComponent(photo.id)}`, downloadSrc: `/api/admin/download?id=${encodeURIComponent(photo.id)}` }) });
      }
      const handlers = routes.get(path);
      if (handlers) {
        const handler = handlers[request.method];
        return typeof handler === 'function' ? handler(request) : new Response(null, { status: 405, headers: { Allow: Object.keys(handlers).filter(key=>typeof handlers[key] === 'function').join(', ') } });
      }
      const file = staticFiles.get(path);
      if (file && ['GET','HEAD'].includes(request.method)) return new Response(request.method === 'HEAD' ? null : await readFile(file), { headers: { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': 'private, no-store' } });
      return new Response('Not found', { status: 404 });
    });
  }
  if (path.startsWith('/api/avatars/') && request.method === 'GET') {
    const account = getPublicAccount(path.slice('/api/avatars/'.length));
    return account?.avatar_key ? imageResponse(account.avatar_key) : new Response('Avatar not found', { status: 404 });
  }
  if ((path.startsWith('/api/covers/') || path.startsWith('/api/directory-covers/')) && request.method === 'GET') {
    const isDirectoryCover = path.startsWith('/api/directory-covers/');
    const prefix = isDirectoryCover ? '/api/directory-covers/' : '/api/covers/';
    const account = getPublicAccount(path.slice(prefix.length));
    const key = isDirectoryCover ? account?.directory_cover_key : account?.cover_key;
    return key ? imageResponse(key) : new Response('Cover not found', { status: 404 });
  }
  if (path.startsWith('/api/media/') && request.method === 'GET') {
    const parts = path.slice('/api/media/'.length).split('/');
    const account = parts.length === 2 ? getPublicAccount(parts[0]) : platformDatabase.prepare('SELECT * FROM users WHERE id=1 AND is_active=1 AND deleted_at IS NULL').get();
    if (!account || parts.length > 2) return new Response('Photo not found', { status: 404 });
    const photo = getAccountGallery(account.id,account.storage_id).sqlite.prepare('SELECT image_key AS imageKey FROM photos WHERE id=?').get(decodeURIComponent(parts.at(-1)));
    if (!photo?.imageKey) return new Response('Photo not found', { status: 404 });
    // Only registered photos can be viewed; never expose an arbitrary COS object key.
    return imageResponse(photo.imageKey);
  }
  const handlers = routes.get(path);
  if (handlers) {
    const handler = handlers[request.method];
    return typeof handler === 'function' ? handler(request) : new Response(null, { status: 405, headers: { Allow: Object.keys(handlers).filter(key => typeof handlers[key] === 'function').join(', ') } });
  }
  const file = staticFiles.get(path);
  if (file && ['GET', 'HEAD'].includes(request.method)) return new Response(request.method === 'HEAD' ? null : await readFile(file), { headers: { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': privatePath ? 'private, no-store' : 'public, max-age=3600' } });
  const publicPage = path.match(/^\/([a-z][a-z0-9_-]{2,23})(\/album)?$/);
  if (request.method === 'GET' && publicPage) {
    const account = getPublicAccount(publicPage[1]);
    if (account) {
      const notes = getGalleryNotes(account.id,account.storage_id);
      const profile = { publicId: account.public_id, name: account.display_name, siteName: account.site_name, avatarUrl: account.avatar_key ? `/api/avatars/${account.public_id}` : '', coverUrl: account.cover_key ? `/api/covers/${account.public_id}` : '', bio: account.bio, introduction: account.introduction, region: account.region, showPhotoNames: account.show_photo_names === 1, notes };
      return withAccount(account, () => publicPage[2]
        ? renderAlbum(profile, { selectedSeriesId: url.searchParams.get('series') ?? '' })
        : renderPortfolio({ ...profile, visitStatistics: true }));
    }
  }
  return new Response('Not found', { status: 404 });
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    if (headers.get('host') !== new URL(origin).host) { outgoing.writeHead(400); outgoing.end('Invalid host'); return; }
    let body;
    if (!['GET', 'HEAD'].includes(incoming.method)) {
      // Only photo-part PUTs accept 8 MiB; processed profile and directory covers accept 4 MiB.
      const chunks = [];
      let size = 0;
      const maximumBodyBytes = url.pathname === '/api/admin/upload-part' && incoming.method === 'PUT' ? 8 * 1024 ** 2
        : ['/api/profile/cover','/api/profile/directory-cover'].includes(url.pathname) ? 4 * 1024 ** 2 : 1024 ** 2;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > maximumBodyBytes) { outgoing.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); outgoing.end(JSON.stringify({ error: '请求内容过大。' })); return; }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const request = new Request(url, { method: incoming.method, headers, body });
    // Only Caddy on loopback can reach this server; it replaces incoming forwarded headers.
    const response = await route(request, headers.get('x-forwarded-for')?.split(',')[0].trim() || incoming.socket.remoteAddress);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'same-origin');
    response.headers.set('X-Frame-Options', 'DENY');
    if (['/admin','/dashboard','/login','/register'].some(prefix=>url.pathname.startsWith(prefix)) || url.pathname.startsWith('/api/')) {
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && incoming.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), outgoing);
    else outgoing.end();
  } catch (error) {
    // Do not log COS errors or request headers: SDK errors may contain signed URLs.
    console.error('Request failed:', error instanceof SyntaxError ? 'invalid JSON' : 'server or upstream failure');
    if (!outgoing.headersSent) {
      outgoing.writeHead(error instanceof SyntaxError ? 400 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      outgoing.end(JSON.stringify({ error: error instanceof SyntaxError ? '提交内容格式无效。' : '服务暂时不可用，请稍后重试。' }));
    } else outgoing.destroy();
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
const port = Number(process.env.PORT || 8080);
server.listen(port, '127.0.0.1', () => console.log(`Yangyu server listening at http://127.0.0.1:${port}`));
backfillStorage().catch(() => console.error('Storage measurement did not complete.'));
process.on('SIGTERM', () => server.close(() => { closeDatabases(); platformDatabase.close(); process.exit(0); }));
