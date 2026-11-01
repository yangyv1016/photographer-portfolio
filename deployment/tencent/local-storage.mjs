import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export async function createLocalStorage(dataDirectory) {
  const root = await realpath(dataDirectory);
  const directory = resolve(root, 'objects');
  const multipartDirectory = resolve(root, 'multipart');

  function objectPath(key) {
    if (typeof key !== 'string' || !/^photos\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:jpe?g|png|webp|gif)$/i.test(key)
      || key.split('/').some(segment => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
      throw new Error('Invalid local object key.');
    }
    return resolve(directory, ...key.split('/'));
  }

  async function checkDirectory(path, create = false) {
    const child = relative(root, path);
    if (child === '..' || child.startsWith('..' + sep) || resolve(root, child) !== path) throw new Error('Local storage directory is outside the data directory.');
    let current = root;
    for (const segment of child.split(sep).filter(Boolean)) {
      current = join(current, segment);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        try { await mkdir(current, { mode: 0o700 }); }
        catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
        info = await lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local storage directories must not contain symlinks.');
    }
  }

  async function regularFile(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Local storage files must be regular files.');
    return info;
  }

  async function writeAtomic(path, bytes) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async function inspectObject(key) {
    const filename = objectPath(key);
    try {
      await checkDirectory(dirname(filename));
      const info = await regularFile(filename);
      await regularFile(filename + '.json');
      const metadata = JSON.parse(await readFile(filename + '.json', 'utf8'));
      if (metadata.size !== info.size) throw new Error('Local object size does not match its metadata.');
      return { filename, size: info.size, contentType: metadata.contentType, etag: metadata.etag, uploadId: metadata.uploadId };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function readUpload(key, uploadId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uploadId)) throw new Error('Invalid local upload ID.');
    const path = resolve(multipartDirectory, uploadId);
    await checkDirectory(path);
    await regularFile(join(path, 'upload.json'));
    const metadata = JSON.parse(await readFile(join(path, 'upload.json'), 'utf8'));
    if (metadata.key !== key) throw new Error('The local upload does not belong to this object.');
    return { path, contentType: metadata.contentType };
  }

  async function head(key) {
    const object = await inspectObject(key);
    return object && { size: object.size, contentType: object.contentType, etag: object.etag };
  }

  async function cleanupCompletedUpload(path) {
    try { await rm(path, { recursive: true, force: true }); }
    catch { console.error('Local image is saved, but temporary upload parts could not be removed.'); }
  }

  function resumeMultipartUpload(key, uploadId) {
    const filename = objectPath(key);
    return {
      key, uploadId,
      async uploadPart(partNumber, value) {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error('Invalid local part number.');
        const bytes = Buffer.from(value);
        if (!bytes.length || bytes.length > 8 * 1024 ** 2) throw new Error('Local upload parts must contain 1–8388608 bytes.');
        const upload = await readUpload(key, uploadId);
        await writeAtomic(join(upload.path, 'part-' + partNumber), bytes);
        return { partNumber, etag: createHash('sha256').update(bytes).digest('hex') };
      },
      async complete(parts) {
        const upload = await readUpload(key, uploadId);
        if (!parts.length || parts.length > 10000 || parts.some((part, index) => part.partNumber !== index + 1 || !/^[a-f0-9]{64}$/.test(part.etag))) {
          throw new Error('Invalid local multipart completion.');
        }
        const existing = await inspectObject(key);
        if (existing) {
          if (existing.uploadId !== uploadId) throw new Error('The local object already belongs to another upload.');
          await cleanupCompletedUpload(upload.path);
          return head(key);
        }
        await checkDirectory(dirname(filename), true);
        const temporary = filename + '.' + randomUUID() + '.tmp';
        const output = await open(temporary, 'wx', 0o600);
        let published = false;
        let committed = false;
        let size = 0;
        const hash = createHash('sha256');
        try {
          try {
            for (const part of parts) {
              const partPath = join(upload.path, 'part-' + part.partNumber);
              await regularFile(partPath);
              const partHash = createHash('sha256');
              for await (const chunk of createReadStream(partPath)) {
                partHash.update(chunk);
                hash.update(chunk);
                size += chunk.length;
                await output.writeFile(chunk);
              }
              if (partHash.digest('hex') !== part.etag) throw new Error('Local upload part ETag does not match.');
            }
          } finally { await output.close(); }
          const metadata = { contentType: upload.contentType, size, etag: hash.digest('hex'), uploadId };
          await rename(temporary, filename);
          published = true;
          await writeAtomic(filename + '.json', JSON.stringify(metadata));
          committed = true;
          await cleanupCompletedUpload(upload.path);
          return { size, contentType: metadata.contentType, etag: metadata.etag };
        } finally {
          await rm(temporary, { force: true });
          if (published && !committed) await rm(filename, { force: true });
        }
      },
      async abort() {
        let upload;
        try { upload = await readUpload(key, uploadId); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        await rm(upload.path, { recursive: true });
      },
    };
  }

  const bucket = {
    head,
    resumeMultipartUpload,
    async createMultipartUpload(key, { httpMetadata }) {
      objectPath(key);
      const uploadId = randomUUID();
      const path = resolve(multipartDirectory, uploadId);
      await checkDirectory(path, true);
      try { await writeAtomic(join(path, 'upload.json'), JSON.stringify({ key, contentType: httpMetadata.contentType })); }
      catch (error) { await rm(path, { recursive: true }); throw error; }
      return resumeMultipartUpload(key, uploadId);
    },
    async put(key, value, { httpMetadata }) {
      const upload = await bucket.createMultipartUpload(key, { httpMetadata });
      try {
        const part = await upload.uploadPart(1, value);
        await upload.complete([part]);
      } catch (error) {
        try { await upload.abort(); } catch { console.error('Unable to abort local image upload.'); }
        throw error;
      }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const filename = objectPath(key);
        try { await checkDirectory(dirname(filename)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const path of [filename, filename + '.json']) {
          try { await regularFile(path); await rm(path); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    },
  };

  await checkDirectory(directory, true);
  await checkDirectory(multipartDirectory, true);
  return {
    directory, bucket,
    async objectResponse(key) {
      const object = await inspectObject(key);
      if (!object) throw new Error('Unable to read the registered local image.');
      const stream = createReadStream(object.filename);
      return new Response(Readable.toWeb(stream), { headers: {
        'Content-Type': object.contentType,
        'Content-Length': String(object.size),
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
      } });
    },
    async readObjectPrefix(key, length) {
      const object = await inspectObject(key);
      if (!object) throw new Error('Unable to read the registered local image.');
      const file = await open(object.filename, 'r');
      try {
        const bytes = Buffer.alloc(length);
        const result = await file.read(bytes, 0, length, 0);
        return bytes.subarray(0, result.bytesRead);
      } finally { await file.close(); }
    },
  };
}
