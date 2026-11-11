export function shareFailure(error: unknown): { code: string; message: string } {
  const code = error instanceof Error ? error.name : 'UnknownError';
  const reasons: Record<string, string> = {
    AbortError: '系统分享已取消，或没有可用的分享目标',
    NotAllowedError: '浏览器拒绝分享，可能是权限、用户手势或安全策略限制',
    DataError: '系统无法接受这批文件，可能是图片数量、大小或分享目标限制',
    TypeError: '当前浏览器不支持这些文件参数或文件分享方式',
    InvalidStateError: '已有系统分享尚未结束，请先关闭原分享面板',
    SecurityError: '当前页面安全策略不允许系统分享',
  };
  return {
    code,
    message: `${reasons[code] || '系统分享失败'}（${code}）。照片仍保留，可重试或下载ZIP。`,
  };
}
export function validPhotoFiles(files: File[]) {
  return (
    !!files.length &&
    files.every((f) => f.size > 0 && f.type === 'image/jpeg' && /\.jpe?g$/i.test(f.name))
  );
}
