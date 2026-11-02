import { it, expect, vi, afterEach } from 'vitest';
import { cloudApi, WORKSPACE_SAVE_TIMEOUT } from './cloud';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('bounds a hung workspace request without declaring it rejected or changing its receipt/body', async () => {
  vi.useFakeTimers();
  const request = { requestId: 'original-receipt', data: { notes: ['must retain'] } };
  const fetcher = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal!.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const result = expect(cloudApi('/workspace', 'PUT', request)).rejects.toMatchObject({
    status: 0,
  });
  await vi.advanceTimersByTimeAsync(WORKSPACE_SAVE_TIMEOUT);
  await result;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].body).toBe(JSON.stringify(request));
  expect(vi.getTimerCount()).toBe(0);
});
it('cleans up the timeout after an acknowledged request and keeps normal credential/CSRF handling', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal('fetch', fetcher);
  expect(await cloudApi('/workspace', 'PUT', { requestId: 'one' })).toEqual({ ok: true });
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    credentials: 'same-origin',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(vi.getTimerCount()).toBe(0);
});
it('an opaque proxy error remains ambiguous, whereas a structured API rejection keeps its status and safe field diagnostics', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('<html>gateway</html>', { status: 400 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: '资料无效',
          issues: [
            { path: ['data', 'people', 0, 'name'], code: 'too_small', message: '请输入姓名' },
          ],
        }),
        { status: 400, headers: { 'X-Chunmo-Workspace-Protocol': '2' } },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  await expect(cloudApi('/workspace', 'PUT', { requestId: 'same' })).rejects.toMatchObject({
    status: 0,
  });
  await expect(cloudApi('/workspace', 'PUT', { requestId: 'same' })).rejects.toMatchObject({
    status: 400,
    details: { protocolVersion: '2', issues: [{ path: ['data', 'people', 0, 'name'] }] },
  });
});

it('keeps gateway status diagnostics without treating an ambiguous write as rejected or exposing HTML', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response('<html>private upstream detail</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  await expect(cloudApi('/workspace', 'PUT', { requestId: 'retain' })).rejects.toMatchObject({
    status: 0,
    details: { code: 'INVALID_API_RESPONSE', httpStatus: 502, contentType: 'text/html' },
  });
});
it('null JSON is an invalid response rather than an invented successful acknowledgement', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', { status: 200 })));
  await expect(cloudApi('/workspace', 'PUT', {})).rejects.toMatchObject({
    status: 0,
    details: { code: 'INVALID_API_RESPONSE' },
  });
});
