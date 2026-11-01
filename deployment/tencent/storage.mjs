import COS from 'cos-nodejs-sdk-v5';
import './config.mjs';

for (const name of ['COS_BUCKET', 'COS_REGION', 'COS_SECRET_ID', 'COS_SECRET_KEY']) {
  if (!process.env[name]) throw new Error(`${name} is not configured.`);
}
export const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Protocol: 'https:' });
export const bucketParameters = { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION };

export async function objectHead(key) {
  try {
    const result = await cos.headObject({ ...bucketParameters, Key: key });
    return { size: Number(result.headers['content-length']), contentType: result.headers['content-type'], etag: result.ETag };
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

export function signedUrl(key, options = {}) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({ ...bucketParameters, Key: key, Sign: true, Expires: 900, Protocol: 'https:', ...options }, (error, result) => error ? reject(error) : resolve(result.Url));
  });
}

export async function objectResponse(key) {
  // The same-region server reads the configured private bucket; browsers stay on this origin.
  const object = await fetch(await signedUrl(key), { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!object.ok) throw new Error('Unable to read the registered image.');
  return new Response(object.body, { headers: {
    'Content-Type': object.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store',
  } });
}

function resumeMultipartUpload(key, uploadId) {
  return {
    key, uploadId,
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

export const env = {
  BUCKET: {
    async createMultipartUpload(key, { httpMetadata }) {
      const result = await cos.multipartInit({ ...bucketParameters, Key: key, ContentType: httpMetadata.contentType });
      return resumeMultipartUpload(key, result.UploadId);
    },
    resumeMultipartUpload,
    head: objectHead,
    async delete(keys) {
      if (!Array.isArray(keys)) { await cos.deleteObject({ ...bucketParameters, Key: keys }); return; }
      const result = await cos.deleteMultipleObject({ ...bucketParameters, Objects: keys.map(Key => ({ Key })) });
      if (result.Error.length) throw new Error('COS did not delete every selected photo.');
    },
  },
};
