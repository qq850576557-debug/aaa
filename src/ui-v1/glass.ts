import lensSource from './lens.svg?raw';

const material = { refraction: 0.86, thickness: 29 } as const;
let serial = 0;
const updated = 'chunmo:glass-stack';
const reduced = matchMedia('(prefers-reduced-transparency: reduce)');
const textures = new Map<string, ReturnType<typeof maps>>();
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

function maps(context: CanvasRenderingContext2D, width: number, height: number, radius: number) {
  // Keep the displacement in CSS pixels, with half-resolution textures interpolated
  // by the compositor. Colour and text are never rasterized into these maps.
  const cols = Math.ceil(width / 2),
    rows = Math.ceil(height / 2);
  context.canvas.width = cols;
  context.canvas.height = rows;
  const vector = context.createImageData(cols, rows);
  const edge = context.createImageData(cols, rows);
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
        opacity = 0;
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
        opacity = 255 * (1 - t * t * (3 - 2 * t));
      }
      vector.data[offset] = r;
      vector.data[offset + 1] = g;
      vector.data[offset + 2] = 128;
      vector.data[offset + 3] = 255;
      edge.data[offset] = edge.data[offset + 1] = edge.data[offset + 2] = 255;
      edge.data[offset + 3] = opacity;
    }
  }
  const encode = (image: ImageData) => {
    context.putImageData(image, 0, 0);
    return context.canvas.toDataURL();
  };
  return { vector: encode(vector), edge: encode(edge) };
}

/** The optional rim samples the live background behind the native dialog.
 * The foreground and the full-page frost stay identical during texture setup. */
export function attachGlass(dialog: HTMLDialogElement) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return;
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
  layer.innerHTML = lensSource + '<div class="cm-glass-optic"></div>';
  const lens = layer.querySelector('filter')!;
  const warp = lens.querySelector('feImage')!;
  lens.id = 'cm-glass-' + ++serial;
  layer.style.setProperty('--cm-glass-filter', 'url("#' + lens.id + '")');
  document.body.append(layer);
  let generation = 0;
  let frame = 0;
  let size = '';
  let ready = false;
  let entered = false;

  function show(mode: 'liquid' | 'frosted') {
    layer.hidden = mode === 'frosted';
    dialog.dataset.cmGlass = mode;
  }
  function frontmost() {
    // Nested dialogs use the stable treatment so optics never appear behind
    // two foregrounds. Resume the cached rim when the nested dialog closes.
    const stack = document.querySelectorAll('dialog:modal');
    return !disposed && stack.length === 1 && stack[0] === dialog;
  }
  function paint() {
    frame = 0;
    if (!context || !frontmost() || reduced.matches) {
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
    const width = Math.round(rect.width),
      height = Math.round(rect.height);
    const key = [width, height, radius].join(':');
    if (key === size) {
      if (ready) show('liquid');
      return;
    }
    size = key;
    ready = false;
    show('frosted');
    const task = ++generation;
    try {
      let mapsForSize = textures.get(key);
      if (!mapsForSize) {
        mapsForSize = maps(context, width, height, radius);
        if (textures.size >= 4) textures.delete(textures.keys().next().value!);
        textures.set(key, mapsForSize);
      }
      const { vector, edge } = mapsForSize;
      void Promise.all(
        [vector, edge].map((source) => {
          const image = new Image();
          image.src = source;
          return image.decode();
        }),
      )
        .then(() => {
          if (disposed || task !== generation) return;
          for (const element of [lens, warp]) {
            element.setAttribute('width', String(rect.width));
            element.setAttribute('height', String(rect.height));
          }
          warp.setAttribute('href', vector);
          layer.style.setProperty('--cm-glass-edge', 'url("' + edge + '")');
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
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    dimensions.disconnect();
    closing.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule);
    reduced.removeEventListener('change', schedule);
    document.removeEventListener(updated, schedule);
    dialog.dataset.cmGlass = 'frosted';
    layer.remove();
  };
}
