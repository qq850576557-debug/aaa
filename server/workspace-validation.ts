import { dataSchema, prepareWorkspace } from '../src/lib/model';
import type { ValidationIssue } from '../src/lib/workspace-save-plan';
import { ApiError } from './store';

export class WorkspaceValidationError extends ApiError {
  constructor(public issues: ValidationIssue[]) {
    super(400, '数据校验失败；未覆盖已保存数据');
  }
}
/** Return paths and validation rules, never submitted values or private records. */
export function parseWorkspaceInput(input: unknown, part: 'data' | 'base') {
  const parsed = dataSchema.safeParse(input);
  if (!parsed.success)
    throw new WorkspaceValidationError(
      parsed.error.issues.slice(0, 12).map((issue) => ({
        path: [
          part,
          ...issue.path.map((key) => (typeof key === 'number' ? key : String(key).slice(0, 100))),
        ],
        code: issue.code,
        message:
          issue.code === 'unrecognized_keys'
            ? '包含当前服务端不支持的字段，请核对前后端版本'
            : issue.message,
      })),
    );
  return prepareWorkspace(parsed.data);
}
