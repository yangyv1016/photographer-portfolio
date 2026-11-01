import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { createZipArchive } from '../../../public/photo-export-zip.js';

test('ZIP preserves ordered UTF-8 names and file bytes with native CRC-32 verification', async () => {
  const entries = [
    { name: '拼图-01.jpg', blob: new Blob(['123456789']) },
    { name: '拼图-02.png', blob: new Blob([Uint8Array.from({ length: 1048593 }, (_, index) => index % 256)]) },
    { name: 'empty.png', blob: new Blob() },
  ];
  const archive = await createZipArchive(entries);
  assert.equal(archive.type, 'application/zip');
  const bytes = Buffer.from(await archive.arrayBuffer());
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 8), entries.length);
  assert.equal(bytes.readUInt16LE(end + 10), entries.length);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  assert.equal(directoryOffset + bytes.readUInt32LE(end + 12), end);
  let directoryCursor = directoryOffset;
  let localCursor = 0;
  for (const entry of entries) {
    assert.equal(bytes.readUInt32LE(directoryCursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(directoryCursor + 8), 0x0800);
    assert.equal(bytes.readUInt16LE(directoryCursor + 10), 0);
    assert.equal(bytes.readUInt32LE(directoryCursor + 42), localCursor);
    const filenameLength = bytes.readUInt16LE(directoryCursor + 28);
    assert.equal(bytes.subarray(directoryCursor + 46, directoryCursor + 46 + filenameLength).toString('utf8'), entry.name);
    assert.equal(bytes.readUInt32LE(localCursor), 0x04034b50);
    assert.equal(bytes.readUInt16LE(localCursor + 6), 0x0800);
    assert.equal(bytes.readUInt16LE(localCursor + 8), 0);
    assert.equal(bytes.readUInt16LE(localCursor + 26), filenameLength);
    assert.equal(bytes.readUInt16LE(localCursor + 28), 0);
    assert.equal(bytes.subarray(localCursor + 30, localCursor + 30 + filenameLength).toString('utf8'), entry.name);
    const dataStart = localCursor + 30 + filenameLength;
    const payload = Buffer.from(await entry.blob.arrayBuffer());
    assert.deepEqual(bytes.subarray(dataStart, dataStart + payload.length), payload);
    for (const offset of [localCursor + 18, localCursor + 22, directoryCursor + 20, directoryCursor + 24]) {
      assert.equal(bytes.readUInt32LE(offset), payload.length);
    }
    const checksum = crc32(payload);
    assert.equal(bytes.readUInt32LE(localCursor + 14), checksum);
    assert.equal(bytes.readUInt32LE(directoryCursor + 16), checksum);
    directoryCursor += 46 + filenameLength;
    localCursor = dataStart + payload.length;
  }
  assert.equal(localCursor, directoryOffset);
  assert.equal(directoryCursor, end);
});

test('ZIP closes an empty archive and rejects overflowing ZIP32 records before reading data', async () => {
  const empty = Buffer.from(await (await createZipArchive([])).arrayBuffer());
  assert.equal(empty.length, 22);
  assert.equal(empty.readUInt16LE(10), 0);
  await assert.rejects(createZipArchive(new Array(0xffff)), /张数过多/);
  await assert.rejects(createZipArchive([{ name: 'a'.repeat(65536), blob: new Blob() }]), /文件名过长/);
  const oversized = { size: 0xffffffff, slice() { throw new Error('Must reject size before reading data'); } };
  await assert.rejects(createZipArchive([{ name: 'large.png', blob: oversized }]), /大小限制/);
});

test('ZIP cancellation aborts before starting or while reading a file', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(createZipArchive([], { signal: before.signal }), { name: 'AbortError' });
  const during = new AbortController();
  const blob = new Blob(['cancelled']);
  let chunksRead = 0;
  blob.slice = (...range) => {
    chunksRead++;
    during.abort();
    return Blob.prototype.slice.apply(blob, range);
  };
  await assert.rejects(createZipArchive([{ name: 'cancelled.jpg', blob }], { signal: during.signal }), { name: 'AbortError' });
  assert.equal(chunksRead, 1);
});
