import { z } from 'zod';
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, '密码至少8位')
  .max(PASSWORD_MAX, '密码最多128位')
  .refine((value) => value.trim().length > 0, '密码不能为空白');
