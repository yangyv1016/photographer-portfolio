import { renderNoteMarkdown } from './note-markdown.js?v=20261101-markdown';

export function mountNotebook(notebook, notes) {
  if (!notes.length) return;
  const dialog = document.querySelector('#notebook-dialog');
  let noteRenderRequest = 0;

  for (const button of notebook.querySelectorAll('.notebook-card')) {
    const note = notes.find(item => item.id === button.dataset.noteId);
    const summary = button.querySelector('.notebook-card-summary');
    const preview = document.createElement('template');
    void renderNoteMarkdown(note.content, preview)
      .then(() => preview.content.textContent, () => note.content)
      .then(text => {
        const characters = [...text.replace(/\s+/g, ' ').trim()];
        summary.textContent = characters.slice(0, 180).join('') + (characters.length > 180 ? '…' : '');
      });
  }

  async function renderNote(note) {
    const request = ++noteRenderRequest;
    const content = dialog.querySelector('#notebook-dialog-content');
    content.textContent = '正在加载便签…';
    content.setAttribute('aria-busy', 'true');
    try { await renderNoteMarkdown(note.content, content); }
    catch (error) {
      if (request !== noteRenderRequest) return;
      console.error('Markdown note failed', error);
      content.innerHTML = '<p>排版加载失败，以下显示原文。<button type="button" class="notebook-retry">重试排版</button></p><pre class="note-markdown-fallback"></pre>';
      content.querySelector('pre').textContent = note.content;
      content.querySelector('button').addEventListener('click', () => { void renderNote(note); });
    } finally {
      if (request === noteRenderRequest) content.removeAttribute('aria-busy');
    }
  }

  notebook.addEventListener('click', event => {
    const button = event.target.closest('[data-note-id]');
    if (!button) return;
    const note = notes.find(item => item.id === button.dataset.noteId);
    dialog.querySelector('#notebook-dialog-title').textContent = note.title;
    void renderNote(note);
    dialog.showModal();
    dialog.querySelector('#notebook-dialog-content').scrollTop = 0;
    document.body.style.overflow = 'hidden';
  });
  dialog.querySelector('#close-notebook').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { noteRenderRequest++; document.body.style.overflow = ''; });
}
