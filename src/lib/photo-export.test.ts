import { expect, it } from 'vitest';
import { shareFailure, validPhotoFiles } from './photo-share';
it('distinguishes Android share failures and validates actual JPEG files', () => {
  for (const name of [
    'NotAllowedError',
    'DataError',
    'TypeError',
    'AbortError',
    'InvalidStateError',
  ]) {
    const error = new Error('test');
    error.name = name;
    expect(shareFailure(error).message).toContain(name);
    expect(shareFailure(error).message).not.toContain('成功');
    expect(shareFailure(error).message).not.toContain('ZIP');
    expect(shareFailure(error).message).toContain('仍保留');
  }
  expect(
    validPhotoFiles([new File([new Uint8Array([1])], 'photo.jpg', { type: 'image/jpeg' })]),
  ).toBe(true);
  expect(validPhotoFiles([new File([], 'photo.jpg', { type: 'image/jpeg' })])).toBe(false);
  expect(validPhotoFiles([new File(['x'], 'photo.jpg', { type: 'text/plain' })])).toBe(false);
});
