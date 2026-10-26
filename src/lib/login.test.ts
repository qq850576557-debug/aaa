import { describe, it, expect } from 'vitest';
import { loginSchema, loginInputSchema } from './login';
describe('canonical login identities', () => {
  it('normalizes Chinese compatibility forms, width and ASCII case consistently', () => {
    for (const value of ['春茉_ＭＡ', '春茉_ma', '春茉_Ma'])
      expect(loginSchema.parse(value)).toBe('春茉_ma');
    expect(loginInputSchema.parse('_LEGACY..ACCOUNT')).toBe('_legacy..account');
    expect(loginSchema.safeParse('_LEGACY..ACCOUNT').success).toBe(false);
    expect(loginSchema.parse('神田_账号')).toBe(loginSchema.parse('神田_账号'));
    for (const value of ['马春旭', 'studio_owner', 'a-b.c@d_e', 'a'.repeat(80), '𠮷'.repeat(80)])
      expect(loginSchema.parse(value)).toBe(value);
  });
  it('rejects whitespace, invisible/control/bidi characters, other-script lookalikes and ambiguous punctuation', () => {
    for (const value of [
      '',
      'ab',
      'a'.repeat(81),
      ' 员工甲',
      '员工甲 ',
      '员\u3000工甲',
      '员工\n甲',
      '员工\u200b甲',
      '员工\u202e甲',
      'аdmin',
      '员工🙂甲',
      '_员工甲',
      '员工甲.',
      'a..bc',
      'a/bc',
      'a+bc',
    ])
      expect(loginSchema.safeParse(value).success, value).toBe(false);
  });
});
