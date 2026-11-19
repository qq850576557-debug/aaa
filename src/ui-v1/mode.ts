import { mobileRequested } from '../mobile/mode';

// Evaluated again on a full reload. Workspace navigation preserves URL options.
const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

export function desktopV1Enabled() {
  return !legacy && !mobileRequested();
}

export function enhancedGlassEnabled() {
  if (new URLSearchParams(location.search).get('glass') !== 'enhanced') return false;
  const client = navigator as Navigator & { deviceMemory?: number };
  return (
    /(?:Chrome|Edg)\//.test(client.userAgent) &&
    (client.deviceMemory ?? 4) > 2 &&
    !matchMedia('(prefers-reduced-transparency: reduce)').matches &&
    CSS.supports('backdrop-filter', 'url("#glass")')
  );
}
