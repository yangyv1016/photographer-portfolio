let rendererPromise;
let retry = 0;
const renderRequests = new WeakMap();

function createMarkdownRenderer({ MarkdownIt, taskLists }) {
  // Raw HTML stays text. Only this fixed task-list markup may create form elements.
  const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false })
    .use(taskLists, { enabled: false, label: false, labelAfter: false });

  markdown.validateLink = href => {
    try {
      // A fixed HTTPS base also checks relative links without consulting user markup.
      return ['http:', 'https:', 'mailto:'].includes(new URL(href, 'https://markdown.invalid/').protocol);
    } catch {
      return false;
    }
  };

  markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, options);
  };

  const renderImage = markdown.renderer.rules.image;
  markdown.renderer.rules.image = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const address = new URL(token.attrGet('src'), environment.page);
    let path;
    try { path = decodeURIComponent(address.pathname); }
    catch { path = null; } // Malformed URL escapes cannot be approved for automatic image loading.
    if (path !== null && address.origin === environment.page.origin
      && /^\/(?:api\/(?:media|avatars|covers|directory-covers)|assets)\//.test(address.pathname)
      && !/\.svgz?$/i.test(path)) {
      // Keep automatic requests on the website's existing, controlled media routes.
      token.attrSet('src', address.pathname + address.search + address.hash);
      token.attrSet('loading', 'lazy');
      token.attrSet('decoding', 'async');
      return renderImage(tokens, index, options, environment, renderer);
    }

    const alternative = renderer.renderInlineAsText(token.children, options, environment);
    const label = markdown.utils.escapeHtml(alternative ? `图片：${alternative}` : '图片');
    // An image can itself be inside a Markdown link; do not create nested anchors.
    for (let previous = index - 1; previous >= 0; previous--) {
      if (tokens[previous].type === 'link_close') break;
      if (tokens[previous].type === 'link_open') return `<span class="note-markdown-image-link">${label}</span>`;
    }
    return `<a class="note-markdown-image-link" href="${markdown.utils.escapeHtml(address.href)}" rel="noopener noreferrer">${label}</a>`;
  };
  return markdown;
}

export async function renderNoteMarkdown(source, container) {
  const request = {};
  renderRequests.set(container, request);
  container.classList.add('note-markdown');
  if (!rendererPromise) {
    // Sites pages without notes never request this Tencent-only browser bundle.
    const vendor = './vendor/note-markdown-vendor.js?v=20261101-markdown' + (retry ? `&retry=${retry}` : '');
    rendererPromise = import(vendor).then(createMarkdownRenderer).catch(error => {
      rendererPromise = undefined;
      retry++;
      // A new URL on retry also avoids browsers caching a failed module load.
      throw error;
    });
  }
  const markdown = await rendererPromise;
  if (renderRequests.get(container) !== request) return;
  const page = new URL(container.ownerDocument.baseURI);
  // html:false, the URL whitelist and the fixed renderers above are the HTML boundary.
  container.innerHTML = markdown.render(source, { page });
}
