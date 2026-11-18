import { mobileRequested } from '../mobile/mode';

// Evaluated again on a full reload. Workspace navigation preserves URL options.
const legacy = new URLSearchParams(location.search).get('ui') === 'legacy';

export function desktopV1Enabled() {
  return !legacy && !mobileRequested();
}
