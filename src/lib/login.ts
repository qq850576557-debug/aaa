import { z } from 'zod';
export const LOGIN_MIN = 3;
export const LOGIN_MAX = 80;
export const LOGIN_HELP =
  '3–80个字符，支持中文、英文字母、数字及 _ . @ -；不含空格，分隔符不能连续或位于首尾。';
export const normalizeLogin = (value: string) =>
  value.normalize('NFKC').replace(/[A-Z]/g, (c) => c.toLowerCase());
// Latin/Greek/Cyrillic lookalikes, combining marks, invisible and bidi characters
// are excluded. Compatibility-width forms normalize to the same identity.
const allowed =
  /^[a-z0-9\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{323af}]+(?:[_.@-][a-z0-9\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{323af}]+)*$/u;
export const loginInputSchema = z
  .string()
  .max(160)
  .refine((value) => !/[\s\p{Cc}\p{Cf}]/u.test(value), '登录账号不能包含空格、控制或不可见字符')
  .transform(normalizeLogin)
  .refine(
    (value) => Array.from(value).length >= LOGIN_MIN && Array.from(value).length <= LOGIN_MAX,
    '登录账号长度需为3–80个字符',
  )
  .refine(
    (value) => /^[a-z0-9\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{323af}_.@-]+$/u.test(value),
    LOGIN_HELP,
  );
// Existing ASCII identities may have legacy separator placement. Login keeps
// them usable; all new accounts/renames follow the stricter creation policy.
export const loginSchema = loginInputSchema.refine((value) => allowed.test(value), LOGIN_HELP);
