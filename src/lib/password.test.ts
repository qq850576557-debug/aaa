import { describe, it, expect } from 'vitest';
import { passwordSchema } from './password';
describe('shared password policy', () => {
  it('accepts 8–128 characters without composition rules or trimming passwords', () => {
    for (const password of [
      'aaaaaaaa',
      '12345678',
      '中文密码中文密码',
      'x'.repeat(128),
      '  abcdef  ',
    ])
      expect(passwordSchema.parse(password)).toBe(password);
  });
  it('rejects empty, short, overlong and blank passwords', () => {
    for (const password of ['', 'a'.repeat(7), 'a'.repeat(129), ' '.repeat(8)])
      expect(passwordSchema.safeParse(password).success).toBe(false);
  });
});
