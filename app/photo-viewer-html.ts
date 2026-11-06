export const photoViewerHtml = `<dialog class="lightbox" id="lightbox" aria-label="照片放大浏览">
    <header class="lightbox-header">
      <div class="lightbox-context"><span class="lightbox-eyebrow">作品预览</span><span id="lightbox-series"></span></div>
      <div class="lightbox-actions">
        <span class="lightbox-count" id="lightbox-count" aria-live="polite" aria-atomic="true"></span>
        <button type="button" class="lightbox-reset" id="reset-photo-zoom" aria-label="还原照片缩放" title="还原缩放" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"/></svg></button>
        <button type="button" class="close-button" id="close-lightbox" aria-label="关闭照片" title="关闭 · Esc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </div>
    </header>
    <div class="lightbox-stage" id="lightbox-stage"><div class="lightbox-viewport" id="lightbox-viewport"><div class="lightbox-image-plane" id="lightbox-image-plane"><img id="lightbox-image" alt=""></div></div></div>
    <footer class="lightbox-footer">
      <div class="lightbox-details"><span id="lightbox-title"></span><a id="lightbox-credit" target="_blank" rel="noopener noreferrer"></a></div>
      <p class="lightbox-hint"><span class="lightbox-hint-pointer">滚轮缩放 · 双击放大 · 方向键切换</span><span class="lightbox-hint-touch">双指缩放 · 左右滑动切换</span></p>
      <div class="lightbox-navigation" aria-label="切换照片">
        <button type="button" class="photo-navigation previous" id="previous-photo" aria-label="上一张照片" title="上一张"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>
        <button type="button" class="photo-navigation next" id="next-photo" aria-label="下一张照片" title="下一张"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button>
      </div>
    </footer>
  </dialog>`;
