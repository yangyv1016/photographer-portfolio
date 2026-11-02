import { toBlob } from 'html-to-image';
import { renderNoteMarkdown } from '/note-markdown.js?v=20261101-markdown';
import exportStyles from './note-image-export.css';

export async function exportNoteImage({ title, content }) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:960px;pointer-events:none';
  host.inert = true;
  host.setAttribute('aria-hidden', 'true');
  const style = document.createElement('style');
  style.textContent = exportStyles;
  const frame = document.createElement('div');
  frame.className = 'note-image-export';
  const paper = document.createElement('article');
  paper.className = 'note-image-paper';
  const heading = document.createElement('h1');
  heading.className = 'note-image-title';
  heading.textContent = title;
  const body = document.createElement('div');
  paper.append(heading, body);
  frame.append(paper);
  host.append(style, frame);
  document.body.append(host);
  try {
    await renderNoteMarkdown(content, body);
    await document.fonts.ready;
    // Embed approved same-origin images ourselves so a failed fetch cannot become a blank export.
    for (const image of body.querySelectorAll('img')) {
      const source = new URL(image.src);
      if (source.pathname.startsWith('/api/')) source.searchParams.set('preview', '1');
      let response;
      try { response = await fetch(source, { signal: AbortSignal.timeout(30000) }); }
      catch { throw new Error('便签中的图片加载失败，请检查图片后重试。'); }
      if (!response.ok) throw new Error('便签中的图片加载失败，请检查图片后重试。');
      const blob = await response.blob();
      image.src = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('无法读取便签图片，请重试。'));
        reader.readAsDataURL(blob);
      });
      image.loading = 'eager';
      try { await image.decode(); }
      catch { throw new Error('便签中的图片无法显示，请检查图片后重试。'); }
    }
    if (body.scrollWidth > body.clientWidth + 1) throw new Error('便签中的表格过宽，请减少列数后导出，避免裁掉内容。');
    const width = frame.offsetWidth;
    const height = Math.ceil(frame.getBoundingClientRect().height);
    // Keep all content, including the bottom padding, within browser canvas limits.
    const pixelRatio = Math.min(2, 16000 / height, Math.sqrt(12000000 / (width * height)));
    if (pixelRatio < 0.75) throw new Error('便签过长，无法一次生成清晰图片，请拆成多个便签后导出。');
    let blob;
    try { blob = await toBlob(frame, { width, height, pixelRatio, skipFonts: true, backgroundColor: '#f1ecdf', includeQueryParams: true }); }
    catch { throw new Error('便签图片生成失败，请重试或使用最新版浏览器。'); }
    if (!blob) throw new Error('浏览器无法生成便签图片，请缩短正文后重试。');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const filename = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || '便签';
    link.download = filename + '.png';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } finally { host.remove(); }
}
