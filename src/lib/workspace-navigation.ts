export const workspaceViews = [
  'overview',
  'schedule',
  'purchases',
  'reminders',
  'completed',
  'people',
  'records',
] as const;
export type WorkspaceView = (typeof workspaceViews)[number];
export type WorkspaceRoute = {
  view: WorkspaceView;
  projectId: string;
  metric?: string;
  projects?: 'all' | 'ongoing';
};
export function workspaceRoute(url: URL): WorkspaceRoute {
  const view = url.searchParams.get('view');
  const projectId = url.searchParams.get('project') || '';
  const metric = url.searchParams.get('metric') || undefined;
  const projects = url.searchParams.get('projects');
  return {
    view: workspaceViews.includes(view as WorkspaceView) ? (view as WorkspaceView) : 'overview',
    projectId: projectId.length <= 100 ? projectId : '',
    ...(metric ? { metric } : {}),
    ...(projects === 'all' || projects === 'ongoing' ? { projects } : {}),
  };
}
export function workspaceHref(route: WorkspaceRoute, current: URL) {
  const url = new URL(current);
  for (const name of ['view', 'project', 'metric', 'projects']) url.searchParams.delete(name);
  if (route.view !== 'overview') url.searchParams.set('view', route.view);
  if (route.projectId) url.searchParams.set('project', route.projectId);
  if (route.metric) url.searchParams.set('metric', route.metric);
  if (route.projects) url.searchParams.set('projects', route.projects);
  return url.pathname + url.search + url.hash;
}
export function sameWorkspaceRoute(a: WorkspaceRoute, b: WorkspaceRoute) {
  return (
    a.view === b.view &&
    a.projectId === b.projectId &&
    a.metric === b.metric &&
    a.projects === b.projects
  );
}
