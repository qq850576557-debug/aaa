import { z } from 'zod';
import { dateOK } from './model';
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), '不能包含控制字符');
export const cardEdit = z
  .object({
    displayName: text(80).min(1),
    englishName: text(80),
    joinedOn: z.string().refine((v) => v === '' || dateOK(v), '入职日期无效'),
  })
  .strict();
export const managedCardEdit = cardEdit
  .extend({ departmentId: z.string().max(100).nullable() })
  .strict();
export const departmentEdit = z
  .object({ name: text(60).min(1), englishName: text(100), active: z.boolean() })
  .strict();
export type Department = {
  id: string;
  name: string;
  englishName: string;
  active: boolean;
  members: number;
};
export type MemberCard = {
  id: string;
  login: string;
  displayName: string;
  active: boolean;
  owner: boolean;
  avatarVersion: string | null;
  englishName: string;
  departmentId: string | null;
  departmentName: string | null;
  departmentEnglishName: string | null;
  joinedOn?: string | null;
};
