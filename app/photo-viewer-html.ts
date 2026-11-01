export const photoViewerHtml = `<dialog class="lightbox" id="lightbox" aria-label="照片放大浏览">
    <div class="lightbox-header"><span id="lightbox-series"></span><span id="lightbox-count"></span><button type="button" class="lightbox-reset" id="reset-photo-zoom" aria-label="还原照片缩放" disabled>还原</button><button class="close-button" id="close-lightbox" aria-label="关闭照片">关闭 <span aria-hidden="true">×</span></button></div>
    <div class="lightbox-stage" id="lightbox-stage"><div class="lightbox-viewport" id="lightbox-viewport"><div class="lightbox-image-plane" id="lightbox-image-plane"><img id="lightbox-image" alt=""></div></div><button class="photo-navigation previous" id="previous-photo" aria-label="上一张照片">上一张</button><button class="photo-navigation next" id="next-photo" aria-label="下一张照片">下一张</button></div>
    <div class="lightbox-footer"><span id="lightbox-title"></span><a id="lightbox-credit" target="_blank" rel="noopener noreferrer"></a></div>
  </dialog>`;
