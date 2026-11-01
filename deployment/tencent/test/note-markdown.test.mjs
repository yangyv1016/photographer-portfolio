import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { build } from 'esbuild';
import { parseFragment } from 'parse5';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Bundle only the real vendor entry in memory. Do not build or change app/.
const { outputFiles } = await build({
  entryPoints: [resolve(directory, 'note-markdown-vendor.mjs')],
  bundle: true, platform: 'browser', target: 'es2022', format: 'esm', write: false,
});
const vendorURL = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64');
const failedVendorURL = 'data:text/javascript,' + encodeURIComponent('throw new Error("Test vendor unavailable");');
const gate = Promise.withResolvers();
globalThis.noteMarkdownTestGate = gate.promise;
const delayedVendorURL = 'data:text/javascript;base64,' + Buffer.from('await globalThis.noteMarkdownTestGate;\n' + outputFiles[0].text).toString('base64');
const vendorRequests = [];
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./vendor/note-markdown-vendor.js?')) {
      vendorRequests.push({ specifier, parentURL: context.parentURL });
      if (context.parentURL.endsWith('?retry-test') && !specifier.includes('&retry=')) return { url: failedVendorURL, shortCircuit: true };
      if (context.parentURL.endsWith('?race-test')) return { url: delayedVendorURL, shortCircuit: true };
      return { url: vendorURL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
after(() => { hooks.deregister(); delete globalThis.noteMarkdownTestGate; });
const sourceURL = pathToFileURL(resolve(directory, '../../public/note-markdown.js')).href;
const { renderNoteMarkdown } = await import(sourceURL);
const baseURI = 'https://portfolio.example/u/photographer';

async function render(source) {
  const classes = new Set();
  const container = { ownerDocument: { baseURI }, classList: { add: value => classes.add(value) }, innerHTML: '' };
  await renderNoteMarkdown(source, container);
  assert.ok(classes.has('note-markdown'));
  const nodes = [parseFragment(container.innerHTML)];
  for (let index = 0; index < nodes.length; index++) {
    if ('childNodes' in nodes[index]) nodes.push(...nodes[index].childNodes);
  }
  return {
    html: container.innerHTML,
    elements: nodes.filter(node => 'tagName' in node).map(node => ({ tag: node.tagName, attributes: Object.fromEntries(node.attrs.map(attribute => [attribute.name, attribute.value])) })),
  };
}

test('Importing the shared renderer without notes never loads the Tencent-only vendor', () => {
  assert.equal(vendorRequests.length, 0);
});

test('Shared note Markdown renders common structures, escaped code and disabled tasks', async () => {
  const { html, elements } = await render([
    '# 标题', '', '## 小标题', '', '**粗体** *斜体* ~~删除~~ 和 `a < b`。', '',
    '> 引用', '', '- 第一项', '- 第二项', '', '1. 有序一', '2. 有序二', '',
    '- [ ] 未完成', '- [x] 已完成', '', '| 名称 | 数量 |', '| :--- | ---: |', '| 照片 | 2 |', '',
    '```html', '<img src=x onerror=alert(1)>', '```', '', '[网站](https://example.com "说明")',
  ].join('\n'));
  for (const tag of ['h1', 'h2', 'strong', 'em', 's', 'code', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'th', 'td', 'pre', 'a']) {
    assert.ok(elements.some(element => element.tag === tag), `Missing ${tag}`);
  }
  assert.match(html, /a &lt; b/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(elements.filter(element => element.tag === 'img').length, 0);
  const tasks = elements.filter(element => element.tag === 'input');
  assert.equal(tasks.length, 2);
  for (const task of tasks) {
    assert.equal(task.attributes.type, 'checkbox');
    assert.ok('disabled' in task.attributes);
    assert.equal(task.attributes.id, undefined);
    assert.equal(task.attributes.name, undefined);
  }
  assert.ok(!('checked' in tasks[0].attributes));
  assert.ok('checked' in tasks[1].attributes);
  assert.equal(elements.find(element => element.tag === 'a').attributes.rel, 'noopener noreferrer');
  assert.equal(elements.find(element => element.tag === 'a').attributes.target, undefined);
});

test('HTML, dangerous protocols, attribute payloads and code-fence language cannot become executable markup', async () => {
  const payloads = [
    '<script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe>',
    '<svg><style><img src=x onerror=alert(1)></svg><math><mtext><img src=x onerror=alert(1)></mtext></math>',
    '</script><img src=x onerror="alert(1)"><base href="https://evil.example"><form id=notes name=notes></form>',
    '[click](javascript:alert(1)) [click](JaVaScRiPt:alert(1)) [click](jav&#x61;script:alert(1))',
    '[click](java&#x09;script:alert(1)) [click](java&#x0a;script:alert(1)) [click](data:text/html,evil)',
    '[click](vbscript:evil) [click](file:///private) [click](blob:https://portfolio.example/id) [click](ftp://evil.example)',
    '![alt](data:image/png;base64,aGVsbG8=) ![alt](data:image/svg+xml,evil) ![alt](javascript:alert(1))',
    '![<svg/onload=alert(1)>](https://evil.example/image.jpg "\" onload=evil")',
    '- [x] <img src=x onerror=alert(1)>\n- [ ] <input type=hidden name=csrf>',
    '```x" onmouseover="alert(1)\n<script>alert(1)</script>\n```',
  ];
  for (const source of payloads) {
    const { elements } = await render(source);
    for (const { tag, attributes } of elements) {
      assert.ok(!['script', 'style', 'svg', 'math', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'].includes(tag), tag);
      assert.ok(!Object.keys(attributes).some(name => /^on/i.test(name)), JSON.stringify(attributes));
      assert.equal(attributes.id, undefined);
      assert.equal(attributes.name, undefined);
      assert.equal(attributes.srcset, undefined);
      if (attributes.href) assert.ok(['http:', 'https:', 'mailto:'].includes(new URL(attributes.href, baseURI).protocol));
      if (tag === 'input') {
        assert.equal(attributes.type, 'checkbox');
        assert.ok('disabled' in attributes);
      }
      assert.notEqual(tag, 'img', source);
    }
  }
});

test('Images load automatically only from the current document origin and controlled website paths', async () => {
  const urls = [
    '/api/media/author/photo?preview=1', '/api/avatars/author', '/api/covers/author',
    '/api/directory-covers/author', '/assets/photo.jpg', 'https://portfolio.example/api/media/author/photo',
    '//portfolio.example/assets/photo.jpg', '../api/media/author/photo',
  ];
  const { elements } = await render(urls.map(url => `![照片 **说明**](${url} "标题")`).join('\n\n'));
  const images = elements.filter(element => element.tag === 'img');
  assert.equal(images.length, urls.length);
  for (const { attributes } of images) {
    assert.ok(attributes.src.startsWith('/'));
    assert.ok(!attributes.src.startsWith('//'));
    assert.equal(new URL(attributes.src, baseURI).origin, new URL(baseURI).origin);
    assert.equal(attributes.loading, 'lazy');
    assert.equal(attributes.decoding, 'async');
    assert.equal(attributes.alt, '照片 说明');
    assert.equal(attributes.title, '标题');
  }
  assert.equal(elements.filter(element => element.tag === 'a').length, 0);
  const quoted = await render('![" onerror="evil](/api/media/author/photo "&quot; onload=&quot;evil")');
  const attributes = quoted.elements.find(element => element.tag === 'img').attributes;
  assert.equal(attributes.alt, '" onerror="evil');
  assert.equal(attributes.title, '" onload="evil');
  assert.ok(!Object.keys(attributes).some(name => /^on/i.test(name)));
});

test('External, COS, SVG and unapproved image routes become visible links without automatic requests', async () => {
  const urls = [
    'https://evil.example/track.jpg', '//evil.example/api/media/author/photo',
    'https://bucket.cos.ap-chengdu.myqcloud.com/photo.jpg', 'https://portfolio.example.evil/api/media/photo',
    '/api/profile/photo', '/api/media-wrong/photo', '/api/media/../../admin/photo',
    '/assets/image.svg', '/assets/image.SVGZ', '/assets/image%2esvg', '/assets/image.%73%76%67', '/assets/%FF.jpg',
  ];
  const { elements, html } = await render(urls.map(url => `![照片](${url})`).join('\n\n') + '\n\n![引用][ref]\n\n[ref]: https://evil.example/ref.png');
  assert.equal(elements.filter(element => element.tag === 'img').length, 0);
  const links = elements.filter(element => element.tag === 'a');
  assert.equal(links.length, urls.length + 1);
  assert.match(html, /图片：照片/);
  assert.match(html, /图片：引用/);
  for (const { attributes } of links) {
    assert.equal(attributes.rel, 'noopener noreferrer');
    assert.equal(attributes.target, undefined);
    assert.ok(['http:', 'https:'].includes(new URL(attributes.href, baseURI).protocol));
  }
  const nested = await render('[![图片](https://evil.example/image.jpg)](https://example.com/page)');
  assert.equal(nested.elements.filter(element => element.tag === 'a').length, 1);
  assert.equal(nested.elements.filter(element => element.tag === 'img').length, 0);
  assert.match(nested.html, /图片：图片/);
});

test('Safe links and independent render origins work for both dialog and editor preview', async () => {
  const { elements } = await render('[站外](https://example.com) [邮件](mailto:author@example.com) [锚点](#notebook) [相对](../about) [同源](/u/author)');
  const links = elements.filter(element => element.tag === 'a');
  assert.equal(links.length, 5);
  assert.equal(links[1].attributes.href, 'mailto:author@example.com');
  assert.equal(links[2].attributes.href, '#notebook');
  const container = { ownerDocument: { baseURI: 'https://editor.example/dashboard/notes/editor' }, classList: { add() {} }, innerHTML: '' };
  await renderNoteMarkdown('![旧站](https://portfolio.example/api/media/author/photo) ![本站](/api/media/author/photo)', container);
  const fragment = parseFragment(container.innerHTML);
  assert.equal(fragment.childNodes[0].childNodes.filter(node => node.tagName === 'img').length, 1);
  assert.match(container.innerHTML, /href="https:\/\/portfolio.example\/api\/media/);
  assert.match(container.innerHTML, /src="\/api\/media\/author\/photo"/);
  await renderNoteMarkdown('新的 **内容**', container);
  assert.equal(container.innerHTML, '<p>新的 <strong>内容</strong></p>\n');
  const long = await render('正文'.repeat(10000));
  assert.equal(long.html, '<p>' + '正文'.repeat(10000) + '</p>\n');
});

test('A failed vendor import rejects visibly and a changed retry URL can load successfully', async () => {
  const { renderNoteMarkdown: retryRender } = await import(sourceURL + '?retry-test');
  const classes = new Set();
  const container = { ownerDocument: { baseURI }, classList: { add: value => classes.add(value) }, innerHTML: '原始正文' };
  await assert.rejects(retryRender('**重试内容**', container), /Test vendor unavailable/);
  assert.equal(container.innerHTML, '原始正文');
  assert.ok(classes.has('note-markdown'), 'The first-load fallback also receives Markdown styles');
  await retryRender('**重试内容**', container);
  assert.equal(container.innerHTML, '<p><strong>重试内容</strong></p>\n');
  const requests = vendorRequests.filter(request => request.parentURL.endsWith('?retry-test'));
  assert.equal(requests.length, 2);
  assert.ok(!requests[0].specifier.includes('&retry='));
  assert.ok(requests[1].specifier.endsWith('&retry=1'));
});

test('Concurrent first renders share one vendor load and only the latest call writes each container', async () => {
  const { renderNoteMarkdown: delayedRender } = await import(sourceURL + '?race-test');
  const writes = [];
  const container = { ownerDocument: { baseURI }, classList: { add() {} }, set innerHTML(value) { writes.push(value); } };
  const other = { ownerDocument: { baseURI }, classList: { add() {} }, innerHTML: '' };
  const first = delayedRender('**旧便签**', container);
  const latest = delayedRender('**当前便签**', container);
  const independent = delayedRender('另一个预览', other);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, []);
  gate.resolve();
  await Promise.all([first, latest, independent]);
  assert.deepEqual(writes, ['<p><strong>当前便签</strong></p>\n']);
  assert.equal(other.innerHTML, '<p>另一个预览</p>\n');
  assert.equal(vendorRequests.filter(request => request.parentURL.endsWith('?race-test')).length, 1);
});
