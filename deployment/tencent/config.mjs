import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = resolve(process.env.YANGYU_ROOT || process.cwd());
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
export const storageBackend = process.env.STORAGE_BACKEND ?? 'cos';
if (!['local', 'cos'].includes(storageBackend)) throw new Error('STORAGE_BACKEND must be local or cos.');
export const dataDirectory = resolve(root, process.env.DATA_DIRECTORY || 'data');
mkdirSync(dataDirectory, { recursive: true });
export const origin = new URL(process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:8080').origin;
const url = new URL(origin);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
  throw new Error('PUBLIC_ORIGIN must use HTTPS, except for loopback previews.');
}
