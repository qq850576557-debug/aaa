// DEV test-only component mount. No production route or navigation is introduced.
import { createRoot, type Root } from 'react-dom/client';
import { MaterialsPanel } from '../src/components/MaterialsPanel';
import type { Data } from '../src/lib/model';
let mounted: Root | undefined, element: HTMLElement | undefined;
export function mountMaterialsForTest(data: Data) {
  // Isolate this retained component from the product's fixed sidebar/topbar.
  // The application itself has no way to navigate here.
  document.getElementById('root')!.style.display = 'none';
  const host = document.createElement('section');
  host.dataset.testid = 'retained-materials-harness';
  host.style.padding = '16px';
  document.body.appendChild(host);
  element = host;
  mounted = createRoot(host);
  mounted.render(<MaterialsPanel data={data} isCloud />);
}
export function unmountMaterialsForTest() {
  mounted?.unmount();
  element?.remove();
  document.getElementById('root')!.style.display = '';
}
