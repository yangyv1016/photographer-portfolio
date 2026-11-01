import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountLightboxZoom } from '../../../public/lightbox-zoom.js';

function fixture(naturalWidth = 800, naturalHeight = 400) {
  const bounds = { left: 50, top: 30, width: 400, height: 400 };
  const view = new EventTarget();
  const viewport = new EventTarget();
  const image = Object.assign(new EventTarget(), { naturalWidth, naturalHeight });
  const resetButton = new EventTarget();
  const plane = { style: {}, dataset: {} };
  const captures = new Set();
  const classes = new Set();
  const swipes = [];
  const event = (type, values = {}) => {
    const input = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      pointerId: 1, pointerType: 'touch', button: 0, clientX: 250, clientY: 230, ...values,
    });
    viewport.dispatchEvent(input);
    return input;
  };
  Object.assign(viewport, {
    ownerDocument: { defaultView: view },
    getBoundingClientRect: () => bounds,
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture(id) {
      captures.delete(id);
      // Synchronous delivery also exercises reset/release re-entrancy safely.
      event('lostpointercapture', { pointerId: id });
    },
  });
  Object.defineProperty(viewport, 'clientHeight', { get: () => bounds.height });
  const reset = mountLightboxZoom(viewport, plane, image, resetButton, direction => swipes.push(direction));
  const state = () => {
    const values = plane.style.transform.match(/translate3d\(([-\d.e+]+)px, ([-\d.e+]+)px, 0\) scale\(([-\d.e+]+)\)/);
    assert.ok(values, plane.style.transform);
    return { x: Number(values[1]), y: Number(values[2]), scale: Number(values[3]) };
  };
  const wheel = (scale, values = {}) => event('wheel', { deltaY: -Math.log(scale) / 0.002, deltaMode: 0, ...values });
  return { viewport, image, resetButton, plane, view, bounds, captures, classes, swipes, event, state, wheel, reset };
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `Expected ${actual} to be near ${expected}`);
}

test('Wheel zoom keeps its focal point, bounds 1–8 exactly and restores swipe after fractional zoom', () => {
  const zoom = fixture();
  assert.equal(zoom.resetButton.disabled, true);
  assert.equal(zoom.wheel(2, { clientX: 350 }).defaultPrevented, true);
  assert.deepEqual(zoom.state(), { x: -100, y: 0, scale: 2 });
  assert.equal(zoom.resetButton.disabled, false);
  assert.ok(zoom.classes.has('is-zoomed'));
  zoom.wheel(1000);
  assert.equal(zoom.state().scale, 8);
  zoom.wheel(0.000001);
  assert.deepEqual(zoom.state(), { x: 0, y: 0, scale: 1 });
  zoom.wheel(1.1008);
  zoom.wheel(0.000001);
  assert.equal(zoom.state().scale, 1);
  assert.equal(zoom.resetButton.disabled, true);
  zoom.event('pointerdown', { clientX: 320 });
  zoom.event('pointerup', { clientX: 180 });
  assert.deepEqual(zoom.swipes, [1]);
});

test('Mouse dragging uses contained photograph bounds rather than the letterboxed plane', () => {
  const landscape = fixture(800, 400);
  landscape.wheel(2);
  landscape.event('pointerdown', { pointerType: 'mouse' });
  landscape.event('pointermove', { pointerType: 'mouse', clientX: 1000, clientY: 900 });
  assert.deepEqual(landscape.state(), { x: 200, y: 0, scale: 2 });
  landscape.event('pointerup', { pointerType: 'mouse', clientX: 1000, clientY: 900 });
  assert.deepEqual(landscape.swipes, []);
  assert.equal(landscape.captures.size, 0);
  const portrait = fixture(200, 400);
  portrait.wheel(2);
  portrait.event('pointerdown', { pointerType: 'mouse' });
  portrait.event('pointermove', { pointerType: 'mouse', clientX: 1000, clientY: 900 });
  assert.deepEqual(portrait.state(), { x: 0, y: 200, scale: 2 });
});

test('Pinching follows the moving midpoint and transitions to one-finger panning without a jump or swipe', () => {
  const zoom = fixture();
  zoom.event('pointerdown', { pointerId: 1, clientX: 150 });
  zoom.event('pointerdown', { pointerId: 2, clientX: 350 });
  zoom.event('pointermove', { pointerId: 1, clientX: 100 });
  zoom.event('pointermove', { pointerId: 2, clientX: 400 });
  near(zoom.state().scale, 1.5);
  near(zoom.state().x, 0);
  zoom.event('pointermove', { pointerId: 1, clientX: 150 });
  zoom.event('pointermove', { pointerId: 2, clientX: 450 });
  near(zoom.state().scale, 1.5);
  near(zoom.state().x, 50);
  zoom.event('pointerup', { pointerId: 2, clientX: 450 });
  const beforePan = zoom.state();
  zoom.event('pointermove', { pointerId: 1, clientX: 160 });
  near(zoom.state().x, beforePan.x + 10);
  near(zoom.state().scale, beforePan.scale);
  zoom.event('pointerup', { pointerId: 1, clientX: 160 });
  assert.deepEqual(zoom.swipes, []);
  assert.equal(zoom.captures.size, 0);
});

test('Only a single horizontal touch at fit size navigates; vertical, mouse, multitouch and canceled gestures do not', () => {
  const zoom = fixture();
  zoom.event('pointerdown', { clientX: 100 });
  zoom.event('pointerup', { clientX: 200 });
  assert.deepEqual(zoom.swipes, [-1]);
  zoom.event('pointerdown');
  zoom.event('pointerup', { clientX: 180, clientY: 400 });
  zoom.event('pointerdown', { pointerType: 'mouse' });
  zoom.event('pointerup', { pointerType: 'mouse', clientX: 80 });
  zoom.event('pointerdown');
  zoom.event('pointercancel', { clientX: 80 });
  zoom.event('pointerdown');
  zoom.event('pointerdown', { pointerId: 2, clientX: 260 });
  zoom.event('pointerup', { pointerId: 2, clientX: 260 });
  zoom.event('pointerup', { clientX: 80 });
  assert.deepEqual(zoom.swipes, [-1]);
  zoom.event('pointerdown', { pointerId: 1, clientX: 150 });
  zoom.event('pointerdown', { pointerId: 2, clientX: 350 });
  zoom.event('pointermove', { pointerId: 2, clientX: 550 });
  assert.equal(zoom.state().scale, 2);
  zoom.event('pointermove', { pointerId: 2, clientX: 350 });
  assert.equal(zoom.state().scale, 1);
  zoom.event('pointerup', { pointerId: 2, clientX: 350 });
  zoom.event('pointermove', { pointerId: 1, clientX: 50 });
  zoom.event('pointerup', { pointerId: 1, clientX: 50 });
  assert.deepEqual(zoom.swipes, [-1], 'Pinching back to fit size must not become a swipe on the final finger');
  zoom.wheel(2);
  zoom.event('pointerdown');
  zoom.wheel(0.000001);
  zoom.event('pointerup', { clientX: 80 });
  assert.deepEqual(zoom.swipes, [-1], 'A gesture which began zoomed must not turn into a swipe');
});

test('Reset, resize, button restore and lost capture release active pointers without stale follow-up navigation', () => {
  const zoom = fixture();
  zoom.wheel(2);
  zoom.event('pointerdown', { pointerId: 1, clientX: 150 });
  zoom.event('pointerdown', { pointerId: 2, clientX: 350 });
  assert.equal(zoom.captures.size, 2);
  zoom.reset();
  assert.equal(zoom.captures.size, 0);
  assert.deepEqual(zoom.state(), { x: 0, y: 0, scale: 1 });
  zoom.event('pointerup', { pointerId: 1, clientX: 0 });
  zoom.event('pointerup', { pointerId: 2, clientX: 0 });
  assert.deepEqual(zoom.swipes, []);
  zoom.wheel(2);
  zoom.event('pointerdown');
  zoom.view.dispatchEvent(new Event('resize'));
  assert.equal(zoom.captures.size, 0);
  assert.deepEqual(zoom.state(), { x: 0, y: 0, scale: 1 });
  zoom.wheel(2);
  zoom.resetButton.dispatchEvent(new Event('click'));
  assert.equal(zoom.state().scale, 1);
  zoom.event('pointerdown');
  zoom.captures.clear();
  zoom.event('lostpointercapture', { clientX: 0 });
  zoom.event('pointerup', { clientX: 0 });
  assert.deepEqual(zoom.swipes, []);
});

test('Loaded image geometry reclamps a zoomed preview, and coincident pinch points never create invalid transforms', () => {
  const zoom = fixture(0, 0);
  zoom.wheel(2);
  zoom.event('pointerdown');
  zoom.event('pointermove', { clientX: 350, clientY: 330 });
  assert.deepEqual(zoom.state(), { x: 100, y: 100, scale: 2 });
  zoom.image.naturalWidth = 800;
  zoom.image.naturalHeight = 400;
  zoom.image.dispatchEvent(new Event('load'));
  assert.deepEqual(zoom.state(), { x: 100, y: 0, scale: 2 });
  zoom.reset();
  zoom.event('pointerdown', { pointerId: 1 });
  zoom.event('pointerdown', { pointerId: 2 });
  zoom.event('pointermove', { pointerId: 2, clientX: 350 });
  zoom.event('pointermove', { pointerId: 2, clientX: 450 });
  assert.equal(zoom.state().scale, 2);
  assert.ok(Object.values(zoom.state()).every(Number.isFinite));
});

test('Wheel units normalize, double-click toggles zoom and drag clicks cannot reach background handlers', () => {
  const pixel = fixture();
  const line = fixture();
  pixel.event('wheel', { deltaY: -16, deltaMode: 0 });
  line.event('wheel', { deltaY: -1, deltaMode: 1 });
  near(pixel.state().scale, line.state().scale);
  const zoom = fixture();
  zoom.event('dblclick');
  assert.equal(zoom.state().scale, 2);
  zoom.event('dblclick');
  assert.deepEqual(zoom.state(), { x: 0, y: 0, scale: 1 });
  zoom.wheel(2);
  zoom.event('pointerdown', { pointerType: 'mouse' });
  zoom.event('pointermove', { pointerType: 'mouse', clientX: 350 });
  zoom.event('pointerup', { pointerType: 'mouse', clientX: 350 });
  let clicks = 0;
  zoom.viewport.addEventListener('click', () => { clicks++; });
  assert.equal(zoom.event('click').defaultPrevented, true);
  assert.equal(clicks, 0);
  zoom.event('pointerdown', { pointerType: 'mouse' });
  zoom.event('pointerup', { pointerType: 'mouse' });
  assert.equal(zoom.event('click').defaultPrevented, false);
  assert.equal(clicks, 1);
});
