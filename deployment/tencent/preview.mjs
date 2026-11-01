import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dataDirectory } from './config.mjs';
import { bucketParameters, objectResponse } from './storage.mjs';

const directory = resolve(dataDirectory,'previews');
const maximumCacheBytes = 128 * 1024 ** 2;
const maximumCacheFiles = 4096;
const maximumInputBytes = 64 * 1024 ** 2;
const jobs = new Map();
let generationQueue = Promise.resolve();
let ready;
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 32 });

async function pruneCache() {
  const files = [];
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    if (!entry.isFile()) continue;
    const filename = resolve(directory,entry.name);
    if (/^[a-f0-9]{64}-[a-f0-9-]{36}\.tmp$/.test(entry.name)) { await rm(filename); continue; }
    if (!/^[a-f0-9]{64}\.webp$/.test(entry.name)) continue;
    const info = await stat(filename);
    files.push({ filename, size: info.size, modified: info.mtimeMs });
  }
  files.sort((a,b)=>a.modified-b.modified);
  let bytes = files.reduce((sum,file)=>sum+file.size,0);
  let remaining = files.length;
  for (const file of files) {
    if (bytes <= maximumCacheBytes && remaining <= maximumCacheFiles) break;
    await rm(file.filename);
    bytes -= file.size;
    remaining--;
  }
}

export async function previewResponse(key) {
  if (!ready) ready = mkdir(directory,{recursive:true,mode:0o700}).then(pruneCache);
  await ready;
  // Object keys change on replacement; bucket/region also isolate caches after a storage switch.
  const id = createHash('sha256').update(JSON.stringify([bucketParameters.Bucket,bucketParameters.Region,key,'webp-1280-q80-v2'])).digest('hex');
  const filename = resolve(directory,id+'.webp');
  let bytes;
  try { bytes = await readFile(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!jobs.has(id)) {
      // One running conversion and at most 31 queued keys; duplicates share their existing job.
      if (jobs.size >= 32) return Response.json({error:'缩略图正在生成，请稍后重试。'},{status:503,headers:{'Retry-After':'2','Cache-Control':'private, no-store'}});
      const job = generationQueue.then(async()=>{
        try { await stat(filename); return; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await mkdir(directory,{recursive:true,mode:0o700});
        const temporary = resolve(directory,id+'-'+randomUUID()+'.tmp');
        try {
          const original = await objectResponse(key);
          let received = 0;
          const inputLimit = new Transform({transform(chunk,encoding,callback){
            received += chunk.length;
            callback(received > maximumInputBytes ? new Error('Preview input exceeds 64 MiB.') : null,chunk);
          }});
          const image = sharp({pages:1,autoOrient:true,limitInputPixels:100_000_000})
            .resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true})
            .webp({quality:80,effort:3}).timeout({seconds:15});
          await pipeline(Readable.fromWeb(original.body),inputLimit,image,createWriteStream(temporary,{flags:'wx',mode:0o600}));
          await rename(temporary,filename);
          await pruneCache();
        } finally { await rm(temporary,{force:true}); }
      });
      jobs.set(id,job);
      generationQueue = job.then(()=>{jobs.delete(id);},()=>{jobs.delete(id);});
    }
    await jobs.get(id);
    bytes = await readFile(filename);
  }
  return new Response(bytes,{headers:{'Content-Type':'image/webp','Content-Disposition':'inline','Content-Length':String(bytes.length),'Cache-Control':'private, no-store'}});
}
