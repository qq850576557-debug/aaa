import { z } from 'zod';
import { amount } from './materials';
export const transferCreate = z
  .object({
    requestId: z.string().uuid(),
    projectId: z.string().min(1),
    targetProjectId: z.string().min(1),
    materialId: z.string().min(1),
    quantity: amount,
    handlerId: z.string().min(1),
    transportCost: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const transferAction = z
  .object({
    requestId: z.string().uuid(),
    version: z.number().int().positive(),
    action: z.enum(['approve', 'dispatch', 'receive', 'return', 'loss', 'cancel']),
    quantity: amount,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type Transfer = {
  id: string;
  version: number;
  projectId: string;
  targetProjectId: string;
  materialId: string;
  quantity: string;
  handlerId: string;
  handlerName: string;
  projectName?: string;
  targetProjectName?: string;
  materialName?: string;
  specification?: string;
  unit?: string;
  transportCost: string;
  reason: string;
  status: '申请' | '待发出' | '交接中' | '部分接收' | '已接收' | '已取消' | '差异关闭';
  sent: string;
  received: string;
  returned: string;
  lost: string;
  createdBy: string;
  createdName: string;
  createdAt: string;
  updatedAt: string;
  receiverId?: string;
  receiverName?: string;
  receivedAt?: string;
};
