import lensSource from './lens.svg?raw';
import { desktopV1Enabled } from './mode';

const material = { refraction: 0.86, opacity: 0.82, thickness: 29 } as const;
let serial = 0;
const active = new Set<HTMLDialogElement>();
const updated = 'chunmo:glass-stack';
const reduced = matchMedia('(prefers-reduced-transparency: reduce)');
const textures = new Map<string, ReturnType<typeof maps>>();
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

function supportsRefraction() {
  const client = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { brands: { brand: string }[] };
  };
  const chromium =
    client.userAgentData?.brands.some(({ brand }) => /Chromium|Chrome|Edge/.test(brand)) ||
    /(?:Chrome|Edg)\//.test(navigator.userAgent);
  return (
    chromium &&
    (client.deviceMemory ?? 4) > 2 &&
    new URLSearchParams(location.search).get('glass') !== 'lite' &&
    CSS.supports('backdrop-filter', 'url("#glass")') &&
    CSS.supports('clip-path', 'path(evenodd, "M 0 0 H 5 V 5 Z")')
  );
}

function maps(context: CanvasRenderingContext2D, width: number, height: number, radius: number) {
  // Keep the displacement in CSS pixels, with half-resolution textures interpolated
  // by the compositor. Colour and text are never rasterized into these maps.
  const cols = Math.ceil(width / 2),
    rows = Math.ceil(height / 2);
  context.canvas.width = cols;
  context.canvas.height = rows;
  const vector = context.createImageData(cols, rows);
  const tint = context.createImageData(cols, rows);
  const halfW = width / 2,
    halfH = height / 2;
  const depthLimit = Math.min(material.thickness, halfW - 2, halfH - 2);
  for (let row = 0; row < rows; row++) {
    const y = ((row + 0.5) * height) / rows - halfH;
    for (let col = 0; col < cols; col++) {
      const x = ((col + 0.5) * width) / cols - halfW;
      const offset = (row * cols + col) * 4;
      const qx = Math.abs(x) - halfW + radius,
        qy = Math.abs(y) - halfH + radius;
      let r = 128,
        g = 128,
        opacity = 255;
      if (Math.max(qx, qy) > radius - depthLimit * 1.14) {
        const dx = Math.max(qx, 0),
          dy = Math.max(qy, 0);
        const corner = Math.sqrt(dx * dx + dy * dy);
        const depth = radius - corner - Math.min(Math.max(qx, qy), 0);
        const nx = (corner ? dx / corner : Number(qx > qy)) * Math.sign(x);
        const ny = (corner ? dy / corner : Number(qy >= qx)) * Math.sign(y);
        const lens = clamp(1 - depth / depthLimit, 0, 1);
        const shift = (depthLimit * 0.55 * material.refraction * lens * Math.sqrt(lens) * 255) / 64;
        r = 127.5 - nx * shift;
        g = 127.5 - ny * shift;
        const t = clamp(depth / (depthLimit * 1.14), 0, 1);
        opacity = 255 * (0.34 + 0.66 * t * t * (3 - 2 * t));
      }
      vector.data[offset] = r;
      vector.data[offset + 1] = g;
      vector.data[offset + 2] = 128;
      vector.data[offset + 3] = 255;
      tint.data[offset] = tint.data[offset + 1] = tint.data[offset + 2] = 255;
      tint.data[offset + 3] = opacity;
    }
  }
  const encode = (image: ImageData) => {
    context.putImageData(image, 0, 0);
    return context.canvas.toDataURL();
  };
  return { vector: encode(vector), tint: encode(tint) };
}

function aperture(rect: DOMRect, radius: number) {
  const { left, top, right, bottom } = rect;
  const arc = 'A ' + radius + ' ' + radius + ' 0 0 1 ';
  return (
    'path(evenodd, "' +
    [
      'M 0 0 H' + innerWidth + ' V' + innerHeight + ' H0 Z',
      'M' + (left + radius) + ' ' + top + ' H' + (right - radius),
      arc + right + ' ' + (top + radius) + ' V' + (bottom - radius),
      arc + (right - radius) + ' ' + bottom + ' H' + (left + radius),
      arc + left + ' ' + (bottom - radius) + ' V' + (top + radius),
      arc + (left + radius) + ' ' + top + ' Z',
    ].join(' ') +
    '")'
  );
}

/** Native dialog owns focus and the entrance. The two paint layers sample the
 * live scene after the transform settles, without cloning or blurring the DOM. */
export function attachGlass(dialog: HTMLDialogElement, optical: boolean) {
  const context =
    optical && supportsRefraction() ? document.createElement('canvas').getContext('2d') : null;
  const entrance = Promise.allSettled(
    dialog.getAnimations().map((animation) => animation.finished),
  );
  let disposed = false;
  const layer = document.createElement('div');
  layer.className = 'cm-glass-layer';
  layer.dataset.kind = 'blocking';
  layer.ariaHidden = 'true';
  layer.inert = true;
  layer.hidden = true;
  layer.innerHTML =
    (context ? lensSource + '<div class="cm-glass-optic"><b></b></div>' : '') +
    '<div class="cm-glass-scene"></div>';
  const lens = layer.querySelector('filter');
  const warp = lens?.querySelector('feImage');
  if (lens) {
    lens.id = 'cm-glass-' + ++serial;
    layer.style.setProperty('--cm-glass-filter', 'url("#' + lens.id + '")');
    layer.style.setProperty('--cm-glass-opacity', String(material.opacity));
  }
  document.body.append(layer);
  active.add(dialog);
  let generation = 0;
  let frame = 0;
  let size = '';
  let ready = false;
  let entered = false;

  function show(mode: 'liquid' | 'frosted') {
    const foreground = frontmost();
    layer.hidden = !foreground;
    layer.dataset.mode = mode;
    dialog.dataset.cmGlass = mode;
    dialog.toggleAttribute('data-cm-glass-backdrop', foreground);
  }
  function frontmost() {
    const top = [...active].filter((item) => item.open && item.matches(':modal')).at(-1);
    return !disposed && desktopV1Enabled() && top === dialog;
  }
  function paint() {
    frame = 0;
    if (!frontmost() || !context || !lens || !warp || reduced.matches) {
      show('frosted');
      return;
    }
    const rect = dialog.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) return;
    const radius = Math.min(
      rect.width / 2,
      rect.height / 2,
      parseFloat(getComputedStyle(dialog).borderTopLeftRadius),
    );
    for (const [key, value] of Object.entries({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      radius,
    }))
      layer.style.setProperty('--cm-glass-' + key, value + 'px');
    layer.style.setProperty('--cm-glass-aperture', aperture(rect, radius));
    const width = Math.round(rect.width),
      height = Math.round(rect.height);
    const key = [width, height, radius].join(':');
    if (key === size) {
      if (ready) show('liquid');
      return;
    }
    size = key;
    ready = false;
    const task = ++generation;
    try {
      let mapsForSize = textures.get(key);
      if (!mapsForSize) {
        mapsForSize = maps(context, width, height, radius);
        if (textures.size >= 4) textures.delete(textures.keys().next().value!);
        textures.set(key, mapsForSize);
      }
      const { vector, tint } = mapsForSize;
      const image = new Image();
      image.src = vector;
      void image
        .decode()
        .then(() => {
          if (disposed || task !== generation) return;
          for (const element of [lens, warp]) {
            element.setAttribute('width', String(rect.width));
            element.setAttribute('height', String(rect.height));
          }
          warp.setAttribute('href', vector);
          layer.style.setProperty('--cm-glass-tint', 'url("' + tint + '")');
          ready = true;
          if (frontmost() && !reduced.matches) show('liquid');
        })
        .catch(() => {
          if (!disposed && task === generation) show('frosted');
        });
    } catch {
      show('frosted');
    }
  }
  function schedule() {
    if (entered && !disposed && !frame) frame = requestAnimationFrame(paint);
  }
  const dimensions = new ResizeObserver(schedule);
  dimensions.observe(dialog);
  const closing = new MutationObserver(() =>
    layer.toggleAttribute('data-closing', dialog.classList.contains('closing')),
  );
  closing.observe(dialog, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  reduced.addEventListener('change', schedule);
  document.addEventListener(updated, schedule);
  void entrance.then(() => {
    entered = true;
    schedule();
  });
  document.dispatchEvent(new Event(updated));
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    active.delete(dialog);
    dimensions.disconnect();
    closing.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule);
    reduced.removeEventListener('change', schedule);
    document.removeEventListener(updated, schedule);
    delete dialog.dataset.cmGlass;
    dialog.removeAttribute('data-cm-glass-backdrop');
    layer.remove();
    document.dispatchEvent(new Event(updated));
  };
}
