import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth';
import { ApiError } from './store';
import { accountPermissions, type AccountPermission } from '../src/lib/account-permissions';
export function requireAccountPermission(permission: AccountPermission) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(new ApiError(401, '请登录'));
    if (!accountPermissions(req.actor.owner)[permission])
      return next(new ApiError(403, '此账号无权执行该操作'));
    next();
  };
}
