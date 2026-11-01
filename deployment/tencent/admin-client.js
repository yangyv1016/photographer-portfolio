export async function uploadCosPart(id, partNumber, bytes) {
  const response = await fetch(`/api/admin/upload-part?id=${encodeURIComponent(id)}&part=${partNumber}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return { partNumber, etag: data.etag };
}
