import { Component, Suspense, type ReactNode } from 'react';

// A failed optional chunk must not hide the navigation or discard a mounted draft.
export class ModuleBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="panel" role="alert">
          <p>
            页面资源暂时无法加载，未修改业务数据。请检查网络后刷新重试；未保存内容仍受草稿保护。
          </p>
          <button onClick={() => window.location.reload()}>刷新重试</button>
        </div>
      );
    return this.props.children;
  }
}
export function DeferredPanel({ children }: { children: ReactNode }) {
  return (
    <ModuleBoundary>
      <Suspense
        fallback={
          <div className="loading" role="status">
            正在打开模块…
          </div>
        }
      >
        {children}
      </Suspense>
    </ModuleBoundary>
  );
}
