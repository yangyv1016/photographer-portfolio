// ZIP Store records: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// JPG and PNG are already compressed; preserve their bytes without recompression.
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export async function createZipArchive(entries, { signal } = {}) {
  signal?.throwIfAborted();
  if (entries.length >= 0xffff) throw new Error('导出张数过多，请减少张数后重试。');
  const encoder = new TextEncoder();
  const date = new Date();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const directory = [];
  let archiveOffset = 0;
  let directorySize = 0;
  for (const { name, blob } of entries) {
    signal?.throwIfAborted();
    const filename = encoder.encode(name);
    if (filename.length > 0xffff) throw new Error('导出文件名过长。');
    const entrySize = 30 + filename.length + blob.size;
    const recordSize = 46 + filename.length;
    if (archiveOffset + entrySize + directorySize + recordSize + 22 >= 0xffffffff) {
      throw new Error('ZIP 超出大小限制，请降低最大宽度或减少照片后重试。');
    }
    let crc = 0xffffffff;
    for (let fileOffset = 0; fileOffset < blob.size; fileOffset += 1048576) {
      const bytes = new Uint8Array(await blob.slice(fileOffset, fileOffset + 1048576).arrayBuffer());
      signal?.throwIfAborted();
      for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 filenames, Store method (0).
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, blob.size, true);
    localView.setUint32(22, blob.size, true);
    localView.setUint16(26, filename.length, true);
    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    central.set(local.subarray(4), 6);
    centralView.setUint32(42, archiveOffset, true);
    parts.push(local, filename, blob);
    directory.push(central, filename);
    archiveOffset += entrySize;
    directorySize += recordSize;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, archiveOffset, true);
  signal?.throwIfAborted();
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
