export function mountLightboxZoom(viewport, plane, image, resetButton, onSwipe) {
  const pointers = new Map();
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let gestureStart;
  let hadMultiplePointers = false;
  let suppressClick = false;

  function render() {
    const bounds = viewport.getBoundingClientRect();
    // Before the preview loads, its contain dimensions are not available yet.
    const fit = image.naturalWidth && image.naturalHeight
      ? Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight) : 1;
    const width = image.naturalWidth ? image.naturalWidth * fit : bounds.width;
    const height = image.naturalHeight ? image.naturalHeight * fit : bounds.height;
    const limitX = Math.max(0, (width * scale - bounds.width) / 2);
    const limitY = Math.max(0, (height * scale - bounds.height) / 2);
    offsetX = Math.max(-limitX, Math.min(limitX, offsetX));
    offsetY = Math.max(-limitY, Math.min(limitY, offsetY));
    plane.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${scale})`;
    plane.dataset.zoom = String(scale);
    viewport.classList.toggle('is-zoomed', scale > 1);
    viewport.classList.toggle('is-dragging', scale > 1 && pointers.size > 0);
    resetButton.disabled = scale === 1;
  }

  function zoomTo(nextScale, previousPoint, nextPoint = previousPoint) {
    const bounds = viewport.getBoundingClientRect();
    const boundedScale = Math.max(1, Math.min(8, nextScale));
    const ratio = boundedScale / scale;
    offsetX = nextPoint.x - bounds.left - bounds.width / 2
      - (previousPoint.x - bounds.left - bounds.width / 2 - offsetX) * ratio;
    offsetY = nextPoint.y - bounds.top - bounds.height / 2
      - (previousPoint.y - bounds.top - bounds.height / 2 - offsetY) * ratio;
    scale = boundedScale;
    if (gestureStart) gestureStart.canSwipe = false;
    render();
  }

  function resetZoom() {
    const capturedIds = [...pointers.keys()];
    suppressClick ||= pointers.size > 0;
    pointers.clear();
    for (const id of capturedIds) {
      if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    }
    gestureStart = undefined;
    hadMultiplePointers = false;
    scale = 1;
    offsetX = offsetY = 0;
    render();
  }

  viewport.addEventListener('wheel', event => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    zoomTo(scale * Math.exp(-event.deltaY * unit * 0.002), { x: event.clientX, y: event.clientY });
  }, { passive: false });

  viewport.addEventListener('dblclick', event => {
    event.preventDefault();
    if (scale > 1) resetZoom();
    else zoomTo(2, { x: event.clientX, y: event.clientY });
  });

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    if (pointers.size === 0) {
      gestureStart = { ...point, pointerType: event.pointerType, canSwipe: scale === 1 };
      hadMultiplePointers = false;
      suppressClick = false;
    } else {
      hadMultiplePointers = true;
      suppressClick = true;
    }
    pointers.set(event.pointerId, point);
    viewport.setPointerCapture(event.pointerId);
    render();
  });

  viewport.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const before = [...pointers.values()].slice(0, 2);
    const current = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, current);
    if (Math.hypot(current.x - gestureStart.x, current.y - gestureStart.y) > 6) suppressClick = true;
    if (pointers.size >= 2) {
      const after = [...pointers.values()].slice(0, 2);
      const previousMiddle = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
      const nextMiddle = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 };
      const previousDistance = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
      const nextDistance = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
      zoomTo(previousDistance > 0 ? scale * nextDistance / previousDistance : scale, previousMiddle, nextMiddle);
    } else if (scale > 1) {
      offsetX += current.x - previous.x;
      offsetY += current.y - previous.y;
      render();
    }
  });

  function finishPointer(event, canceled) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (canceled) {
      hadMultiplePointers = true;
      suppressClick = true;
    }
    render();
    if (pointers.size > 0) return;
    const distanceX = event.clientX - gestureStart.x;
    const distanceY = event.clientY - gestureStart.y;
    const swipe = !canceled && !hadMultiplePointers && scale === 1 && gestureStart.canSwipe && gestureStart.pointerType === 'touch'
      && Math.abs(distanceX) > 60 && Math.abs(distanceX) > Math.abs(distanceY) * 1.2;
    gestureStart = undefined;
    if (swipe) onSwipe(distanceX < 0 ? 1 : -1);
  }

  viewport.addEventListener('pointerup', event => finishPointer(event, false));
  viewport.addEventListener('pointercancel', event => finishPointer(event, true));
  viewport.addEventListener('lostpointercapture', event => finishPointer(event, true));
  viewport.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  image.addEventListener('load', render);
  resetButton.addEventListener('click', resetZoom);
  viewport.ownerDocument.defaultView.addEventListener('resize', resetZoom);
  resetZoom();
  return resetZoom;
}
