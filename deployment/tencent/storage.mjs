import COS from 'cos-nodejs-sdk-v5';
import { dataDirectory, storageBackend } from './config.mjs';
import { createLocalStorage } from './local-storage.mjs';

if (storageBackend === 'cos') {
  for (const name of ['COS_BUCKET', 'COS_REGION', 'COS_SECRET_ID', 'COS_SECRET_KEY']) {
    if (!process.env[name]) throw new Error(`${name} is not configured.`);
  }
}
export const cos = storageBackend === 'cos' ? new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Protocol: 'https:' }) : undefined;
export const bucketParameters = storageBackend === 'cos' ? { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION } : undefined;
const local = storageBackend === 'local' ? await createLocalStorage(dataDirectory) : undefined;
export const storageIdentity = local ? ['local', local.directory] : [bucketParameters.Bucket, bucketParameters.Region];

export async function objectHead(key) {
  if (local) return local.bucket.head(key);
  try {
    const result = await cos.headObject({ ...bucketParameters, Key: key });
    return { size: Number(result.headers['content-length']), contentType: result.headers['content-type'], etag: result.ETag };
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

export function signedUrl(key, options = {}) {
  if (local) throw new Error('Local storage does not expose signed object URLs.');
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({ ...bucketParameters, Key: key, Sign: true, Expires: 900, Protocol: 'https:', ...options }, (error, result) => error ? reject(error) : resolve(result.Url));
  });
}

export async function objectResponse(key) {
  if (local) return local.objectResponse(key);
  // The server reads the configured private bucket; browsers stay on this origin.
  const object = await fetch(await signedUrl(key), { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!object.ok) throw new Error('Unable to read the registered image.');
  return new Response(object.body, { headers: {
    'Content-Type': object.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store',
  } });
}

export async function readObjectPrefix(key, length) {
  if (local) return local.readObjectPrefix(key, length);
  const { Body } = await cos.getObject({ ...bucketParameters, Key: key, Range: `bytes=0-${length - 1}` });
  return Buffer.from(Body);
}

function resumeMultipartUpload(key, uploadId) {
  return {
    key, uploadId,
    async uploadPart(partNumber, bytes) {
      const result = await cos.multipartUpload({ ...bucketParameters, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: bytes });
      if (!result.ETag) throw new Error('The uploaded part has no ETag.');
      return { partNumber, etag: result.ETag };
    },
    async complete(parts) {
      await cos.multipartComplete({ ...bucketParameters, Key: key, UploadId: uploadId, Parts: parts.map(part => ({ PartNumber: part.partNumber, ETag: part.etag })) });
      return objectHead(key);
    },
    async abort() {
      try { await cos.multipartAbort({ ...bucketParameters, Key: key, UploadId: uploadId }); }
      catch (error) { if (error.statusCode !== 404) throw error; }
    },
  };
}

const cosBucket = {
  async createMultipartUpload(key, { httpMetadata }) {
    const result = await cos.multipartInit({ ...bucketParameters, Key: key, ContentType: httpMetadata.contentType });
    return resumeMultipartUpload(key, result.UploadId);
  },
  resumeMultipartUpload,
  head: objectHead,
  async put(key, bytes, { httpMetadata }) {
    const upload = await cosBucket.createMultipartUpload(key, { httpMetadata });
    try {
      const part = await upload.uploadPart(1, bytes);
      await cos.multipartComplete({ ...bucketParameters, Key: key, UploadId: upload.uploadId, Parts: [{ PartNumber: part.partNumber, ETag: part.etag }] });
    } catch (error) {
      try { await upload.abort(); } catch { console.error('Unable to abort COS image upload.'); }
      throw error;
    }
  },
  async delete(keys) {
    if (!Array.isArray(keys)) { await cos.deleteObject({ ...bucketParameters, Key: keys }); return; }
    const result = await cos.deleteMultipleObject({ ...bucketParameters, Objects: keys.map(Key => ({ Key })) });
    if (result.Error.length) throw new Error('COS did not delete every selected photo.');
  },
};

export const env = { BUCKET: local ? local.bucket : cosBucket };
