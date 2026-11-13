import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const { Api } = require('../../miniprogram/chunmo-photo/lib/api.js');
export const {
  WorkbenchClient,
} = require('../../miniprogram/chunmo-photo/lib/workbench-client.js');
/** HTTP transport harness only. wx.login exchange is a test fixture, never a
 * claim of real WeChat/device execution. Uses the actual client API class. */
export function miniRuntime(base: string, appId: string) {
  const previous = (globalThis as any).wx;
  (globalThis as any).wx = {
    login: (o: any) => o.success({ code: 'test-one-use-code' }),
    request: async (o: any) => {
      try {
        const r = await fetch(base + new URL(o.url).pathname, {
          method: o.method,
          headers: { ...o.header, referer: `https://servicewechat.com/${appId}/0/page-frame.html` },
          ...(o.data === undefined ? {} : { body: JSON.stringify(o.data) }),
        });
        o.success({
          statusCode: r.status,
          data: await r.json(),
          header: Object.fromEntries(r.headers),
          cookies: r.headers.getSetCookie(),
        });
      } catch (e) {
        o.fail(e);
      }
    },
  };
  return () => {
    (globalThis as any).wx = previous;
  };
}
