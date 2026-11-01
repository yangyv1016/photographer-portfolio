import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExportPages } from '../../../app/admin-photo-export.js';

const photos = Object.freeze(Array.from({ length: 19 }, (_, index) => Object.freeze({ id: `photo-${index + 1}` })));

function assertLayout(selected, options, result) {
  const { pages, width } = result;
  assert.equal(pages.length, options.count, 'The requested number of output images stays exact');
  assert.ok(Number.isInteger(width) && width > 0 && width <= options.width);
  const cells = pages.flatMap(page => page.cells);
  assert.deepEqual(cells.map(cell => cell.photo), selected, 'Every selected photo appears once, in its original order');
  cells.forEach((cell, index) => assert.equal(cell.photo, selected[index], 'Layout preserves the original photo objects'));
  const counts = pages.map(page => page.cells.length);
  assert.ok(Math.min(...counts) >= 1);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'Photos are distributed evenly between images');
  for (const page of pages) {
    assert.ok(Number.isInteger(page.height) && page.height > 0 && page.height <= 12000);
    assert.ok(width * Math.round(page.height) <= 24000000, 'The actual integer canvas stays within 24 megapixels');
    const rows = new Map();
    for (const cell of page.cells) {
      for (const value of [cell.x, cell.y, cell.width, cell.height]) assert.ok(Number.isFinite(value));
      assert.ok(cell.x >= 0 && cell.y >= 0 && cell.width > 0 && cell.height > 0);
      assert.ok(cell.x + cell.width <= width + 1e-7, 'A photo must fit inside the output width');
      assert.ok(cell.y + cell.height <= page.height + 1e-7, 'A photo must fit inside the output height');
      assert.ok(Math.abs(cell.width / cell.height - options.ratio) < 1e-7 * options.ratio);
      if (!rows.has(cell.y)) rows.set(cell.y, []);
      rows.get(cell.y).push(cell);
    }
    let previousBottom = 0;
    for (const [y, row] of rows) {
      assert.ok(y >= previousBottom, 'Rows must not overlap');
      assert.equal(row[0].x, 0);
      assert.ok(row.length <= options.columns);
      for (let index = 1; index < row.length; index++) {
        assert.ok(row[index].x >= row[index - 1].x + row[index - 1].width, 'Columns must not overlap');
        assert.equal(row[index].width, row[0].width);
        assert.equal(row[index].height, row[0].height);
      }
      const last = row.at(-1);
      assert.ok(width - (last.x + last.width) < 1 + 1e-7, 'Every row fills the canvas apart from integer rounding');
      previousBottom = y + row[0].height;
    }
    assert.ok(page.height - previousBottom < 1 + 1e-7, 'The output does not leave an extra blank row');
  }
}

test('Nineteen selected photos export as exactly 1, 2, 3, 5 or 19 balanced images with one to four columns', () => {
  for (const count of [1, 2, 3, 5, 19]) {
    for (const columns of [1, 2, 3, 4]) {
      const options = { count, columns, width: 1600, gap: 24, ratio: 3 };
      const result = createExportPages(photos, options);
      assertLayout(photos, options, result);
      assert.equal(result.width, options.width, 'Layouts below both safety limits keep the requested resolution');
    }
  }
  assert.deepEqual(photos.map(photo => photo.id), Array.from({ length: 19 }, (_, index) => `photo-${index + 1}`));
});

test('A partial last row expands equally across the width without adding an outer margin', () => {
  for (const length of [7, 8]) {
    const selected = photos.slice(0, length);
    const options = { count: 1, columns: 3, width: 1200, gap: 24, ratio: 1.5 };
    const result = createExportPages(selected, options);
    assertLayout(selected, options, result);
    const page = result.pages[0];
    assert.deepEqual(page.cells.slice(0, 6).map(({ x, y, width, height }) => ({ x, y, width, height })), [
      { x: 0, y: 0, width: 384, height: 256 },
      { x: 408, y: 0, width: 384, height: 256 },
      { x: 816, y: 0, width: 384, height: 256 },
      { x: 0, y: 280, width: 384, height: 256 },
      { x: 408, y: 280, width: 384, height: 256 },
      { x: 816, y: 280, width: 384, height: 256 },
    ]);
    assert.deepEqual(page.cells.slice(6).map(({ x, y, width, height }) => ({ x, y, width, height })), length === 7
      ? [{ x: 0, y: 560, width: 1200, height: 800 }]
      : [{ x: 0, y: 560, width: 588, height: 392 }, { x: 612, y: 560, width: 588, height: 392 }]);
    assert.equal(page.height, length === 7 ? 1360 : 952);
  }
});

test('Tall photos and high resolution layouts shrink safely without silently adding output images', () => {
  for (const options of [
    { count: 1, columns: 1, width: 2400, gap: 48, ratio: 0.001 },
    { count: 2, columns: 1, width: 3600, gap: 48, ratio: 4 },
    { count: 1, columns: 3, width: 3600, gap: 24, ratio: 1.5 },
    { count: 5, columns: 2, width: 2400, gap: 48, ratio: 0.01 },
    { count: 19, columns: 4, width: 3600, gap: 0, ratio: 0.01 },
  ]) {
    const result = createExportPages(photos, options);
    assertLayout(photos, options, result);
    assert.ok(result.width < options.width, 'Oversized layouts reduce resolution');
    if (options.count === 5) {
      const firstWidth = result.pages[0].cells[0].width;
      assert.ok(result.pages.every(page => page.cells[0].width === firstWidth), 'All pages use one common scale');
      assert.ok(result.pages.at(-1).height > result.pages[0].height, 'The enlarged final row can make the shorter page tallest');
    }
  }
});

test('A single panorama and zero-gap rows remain positive and contiguous', () => {
  for (const selected of [photos.slice(0, 1), photos]) {
    const options = { count: 1, columns: 4, width: 3600, gap: 0, ratio: 100 };
    const result = createExportPages(selected, options);
    assertLayout(selected, options, result);
    assert.equal(result.width, 3600);
    for (let index = 1; index < result.pages[0].cells.length; index++) {
      const cell = result.pages[0].cells[index];
      const previous = result.pages[0].cells[index - 1];
      assert.equal(cell.y === previous.y ? cell.x : cell.y, cell.y === previous.y ? previous.x + previous.width : previous.y + previous.height);
    }
  }
});
