import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
// This generated directory contains no database or environment files.
await rm(resolve(directory, 'app'), { recursive: true, force: true });
await mkdir(resolve(directory, 'app'), { recursive: true });
await build({
  entryPoints: ['server.mjs', 'setup-admin.mjs', 'backup.mjs'].map(file => resolve(directory, file)),
  outdir: resolve(directory, 'app'), bundle: true, platform: 'node', target: 'node24', format: 'esm',
  outExtension: { '.js': '.mjs' },
  nodePaths: [resolve(directory, 'node_modules')],
  external: ['cos-nodejs-sdk-v5', 'sharp'],
  plugins: [{
    name: 'tencent-runtime',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: resolve(directory, 'storage.mjs') }));
      builder.onResolve({ filter: /(^|\/)admin-access$/ }, () => ({ path: resolve(directory, 'auth.mjs') }));
      builder.onResolve({ filter: /(^|\/)gallery$/ }, args => {
        if (resolve(args.resolveDir, args.path) === resolve(repository, 'db/gallery')) return { path: resolve(directory, 'gallery.mjs') };
      });
      builder.onResolve({ filter: /(^|\/)index$/ }, args => {
        if (resolve(args.resolveDir, args.path) === resolve(repository, 'db/index')) return { path: resolve(directory, 'database.mjs') };
      });
      builder.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
      builder.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
    },
  }],
});
await cp(resolve(repository, 'public'), resolve(directory, 'app/public'), { recursive: true });
await cp(resolve(directory, 'public'), resolve(directory, 'app/public'), { recursive: true });
await cp(resolve(directory, 'admin-client.js'), resolve(directory, 'app/public/admin-client.js'));
await build({
  entryPoints: [resolve(directory, 'note-markdown-vendor.mjs')],
  outfile: resolve(directory, 'app/public/vendor/note-markdown-vendor.js'),
  bundle: true, platform: 'browser', target: 'es2022', format: 'esm', minify: true,
  legalComments: 'linked',
  banner: { js: '/*! Third-party licenses: ./note-markdown-vendor.LICENSE.txt */' },
});
const markdownLicenses = await Promise.all([
  ['markdown-it', 'LICENSE'], ['markdown-it-task-lists', 'LICENSE'],
  ['entities', 'LICENSE'], ['linkify-it', 'LICENSE'], ['mdurl', 'LICENSE'],
  ['punycode.js', 'LICENSE-MIT.txt'], ['uc.micro', 'LICENSE.txt'],
].map(async ([name, filename]) => name + '\n\n' + await readFile(resolve(directory, 'node_modules', name, filename), 'utf8')));
await writeFile(resolve(directory, 'app/public/vendor/note-markdown-vendor.LICENSE.txt'), markdownLicenses.join('\n\n'));
const adminPath = resolve(directory, 'app/public/admin.js');
const adminSource = await readFile(adminPath, 'utf8');
const originalUpload = "await requestJson(`/api/admin/uploads?id=${encodeURIComponent(id)}&part=${partNumber}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: entry.file.slice(offset, offset + partSize) })";
if (!adminSource.includes(originalUpload)) throw new Error('The shared upload client changed. Review the COS adaptation before building.');
await writeFile(adminPath, "import { uploadCosPart } from '/admin-client.js';\n" + adminSource.replace(originalUpload, 'await uploadCosPart(id, partNumber, entry.file.slice(offset, offset + partSize))'));
console.log('Built the Tencent/COS deployment in deployment/tencent/app.');
