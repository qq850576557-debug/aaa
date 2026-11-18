import lensSource from './lens.svg?raw';
import { desktopV1Enabled } from './mode';

const material = { refraction: 0.86, roughness: 3.4, opacity: 0.78, thickness: 29 } as const;
let serial = 0;
const active = new Set<HTMLDialogElement>();
const updated = 'chunmo:glass-stack';
const reduced = matchMedia('(prefers-reduced-transparency: reduce)');
const textureCache = new Map<string, ReturnType<typeof maps>>();
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
function eased(start: number, end: number, value: number) {
  const t = clamp((value - start) / (end - start), 0, 1);
  return t * t * (3 - 2 * t);
}
function supportsRefraction() {
  const client = navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } };
  const chromium =
    client.userAgentData?.brands.some(({ brand }) => /Chromium|Chrome|Edge/.test(brand)) ||
    /(?:Chrome|Edg)\//.test(navigator.userAgent);
  return (
    chromium &&
    CSS.supports('backdrop-filter', 'url("#glass")') &&
    CSS.supports('clip-path', 'path(evenodd, "M 0 0 H 5 V 5 Z")')
  );
}
function maps(context: CanvasRenderingContext2D, width: number, height: number, radius: number) {
  const { canvas } = context;
  const { thickness, refraction } = material;
  width = Math.round(width);
  height = Math.round(height);
  canvas.width = width;
  canvas.height = height;
  const vectorMap = context.createImageData(width, height);
  const tintMap = context.createImageData(width, height);
  const lightMap = context.createImageData(width, height);
  const halfW = width / 2,
    halfH = height / 2;
  const opticalDepth = Math.min(thickness, halfW - 2, halfH - 2);
  for (let row = 0; row < height; row++) {
    const y = row + 0.5 - halfH;
    for (let col = 0; col < width; col++) {
      const x = col + 0.5 - halfW;
      const qx = Math.abs(x) - halfW + radius,
        qy = Math.abs(y) - halfH + radius;
      const dx = Math.max(qx, 0),
        dy = Math.max(qy, 0);
      const corner = Math.hypot(dx, dy);
      const depth = radius - corner - Math.min(Math.max(qx, qy), 0);
      const nx = (corner ? dx / corner : Number(qx > qy)) * Math.sign(x);
      const ny = (corner ? dy / corner : Number(qy >= qx)) * Math.sign(y);
      const offset = (row * width + col) * 4;
      const lens = clamp(1 - depth / opticalDepth, 0, 1);
      const shift = opticalDepth * 0.55 * refraction * lens ** 1.5;
      // Bend the ray toward the aperture, with a monotonic profile for edge magnification.
      vectorMap.data[offset] = 127.5 - (nx * shift * 255) / 64;
      vectorMap.data[offset + 1] = 127.5 - (ny * shift * 255) / 64;
      vectorMap.data[offset + 2] = 128;
      vectorMap.data[offset + 3] = 255;
      const tint = 0.34 + 0.66 * eased(0, opticalDepth * 1.14, depth);
      tintMap.data[offset] = tintMap.data[offset + 1] = tintMap.data[offset + 2] = 255;
      tintMap.data[offset + 3] = 255 * tint;

      // These angled Fresnel lobes only tint the sampled scene. They are not an edge stroke.
      const topLight = Math.max(0, -0.66 * nx - 0.75 * ny) ** 3;
      const bottomLight = Math.max(0, 0.84 * nx + 0.54 * ny) ** 5;
      const sweep = 0.76 + 0.24 * Math.cos(2.2 * (x / halfW - y / halfH));
      const strength = (0.49 * topLight + 0.29 * bottomLight) * sweep;
      const shape = lens ** 1.8 * eased(0, 2.6, depth);
      lightMap.data[offset] = lightMap.data[offset + 1] = lightMap.data[offset + 2] = 255;
      lightMap.data[offset + 3] = 255 * strength * shape;
    }
  }
  const encode = (image: ImageData) => {
    context.putImageData(image, 0, 0);
    return canvas.toDataURL();
  };
  return { vector: encode(vectorMap), tint: encode(tintMap), light: encode(lightMap) };
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

/** Native dialog owns focus, clipping and close semantics; these layers are paint-only. */
export function attachGlass(dialog: HTMLDialogElement, blocking: boolean) {
  const scene = dialog.closest<HTMLElement>('.app-shell.ui-v1');
  const canvas = document.createElement('canvas');
  const context = scene && supportsRefraction() ? canvas.getContext('2d') : null;
  if (!scene || !context) return;
  const layer = document.createElement('div');
  layer.className = 'cm-glass-layer';
  layer.dataset.kind = blocking ? 'blocking' : 'floating';
  layer.ariaHidden = 'true';
  layer.inert = true;
  layer.hidden = true;
  layer.innerHTML =
    lensSource +
    '<div class="cm-glass-optic"><i></i><b></b></div>' +
    (blocking ? '<div class="cm-glass-scene"><div class="cm-glass-copy"></div></div>' : '');
  const lens = layer.querySelector('filter')!;
  const [warp, mask] = lens.querySelectorAll('feImage');
  const [roughness, centre] = lens.querySelectorAll('feGaussianBlur');
  lens.id = 'cm-glass-' + ++serial;
  roughness.setAttribute('stdDeviation', String(material.roughness));
  centre.setAttribute('stdDeviation', String(material.roughness * 2.8));
  layer.style.setProperty('--cm-glass-filter', 'url("#' + lens.id + '")');
  layer.style.setProperty('--cm-glass-opacity', String(material.opacity));
  const mirror = layer.querySelector<HTMLElement>('.cm-glass-copy');
  document.body.append(layer);
  active.add(dialog);
  let generation = 0;
  let frame = 0;
  let size = '';
  let ready = false;
  let dirty = true;
  let disposed = false;

  function hide() {
    layer.hidden = true;
    delete dialog.dataset.cmGlass;
  }
  function show() {
    if (mirror) {
      if (dirty) {
        // Bound clone work for unusually large workspaces; the ordinary glass stays available.
        if (scene!.getElementsByTagName('*').length > 4500) {
          hide();
          return;
        }
        const copy = scene!.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('dialog, .notifications, [popover]').forEach((node) => node.remove());
        copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
        mirror.replaceChildren(copy);
        dirty = false;
      }
      layer.hidden = false;
      mirror.scrollTop = scrollY;
      mirror.scrollLeft = scrollX;
    } else layer.hidden = false;
    dialog.dataset.cmGlass = 'liquid';
  }
  function usable() {
    const top = [...active]
      .filter((candidate) => candidate.open && candidate.matches(':modal'))
      .at(-1);
    return desktopV1Enabled() && !reduced.matches && dialog.open && (!top || top === dialog);
  }
  function paint() {
    frame = 0;
    if (!usable()) {
      hide();
      return;
    }
    const rect = dialog.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
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
    if (blocking) layer.style.setProperty('--cm-glass-aperture', aperture(rect, radius));
    const key = [rect.width, rect.height, radius].join(':');
    if (key === size) {
      if (ready) show();
      return;
    }
    size = key;
    ready = false;
    const task = ++generation;
    try {
      let textures = textureCache.get(key);
      if (!textures) {
        textures = maps(context!, rect.width, rect.height, radius);
        if (textureCache.size >= 4) textureCache.delete(textureCache.keys().next().value!);
        textureCache.set(key, textures);
      }
      const { vector, tint, light } = textures;
      void Promise.all(
        [vector, tint].map((src) => {
          const image = new Image();
          image.src = src;
          return image.decode();
        }),
      )
        .then(() => {
          if (disposed || task !== generation) return;
          for (const element of [lens, warp, mask]) {
            element.setAttribute('width', String(rect.width));
            element.setAttribute('height', String(rect.height));
          }
          warp.setAttribute('href', vector);
          mask.setAttribute('href', tint);
          layer.style.setProperty('--cm-glass-tint', 'url("' + tint + '")');
          layer.style.setProperty('--cm-glass-light', 'url("' + light + '")');
          ready = true;
          if (usable()) show();
        })
        .catch(() => {
          if (task === generation) hide();
        });
    } catch {
      hide();
    }
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(paint);
  }
  const dimensions = new ResizeObserver(schedule);
  dimensions.observe(dialog);
  const sceneChanges = mirror
    ? new MutationObserver((changes) => {
        if (changes.some((entry) => !dialog.contains(entry.target))) {
          dirty = true;
          schedule();
        }
      })
    : null;
  sceneChanges?.observe(scene, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  reduced.addEventListener('change', schedule);
  document.addEventListener(updated, schedule);
  document.dispatchEvent(new Event(updated));
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    active.delete(dialog);
    dimensions.disconnect();
    sceneChanges?.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule);
    reduced.removeEventListener('change', schedule);
    document.removeEventListener(updated, schedule);
    hide();
    layer.remove();
    document.dispatchEvent(new Event(updated));
  };
}
