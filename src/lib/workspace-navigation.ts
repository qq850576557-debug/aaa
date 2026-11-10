export const workspaceViews = [
  'overview',
  'project-detail',
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
export function normalizeWorkspaceRoute(route: WorkspaceRoute): WorkspaceRoute {
  // Legacy /?project= links still open a detail, but overview never selects a site.
  if (route.view === 'overview' && route.projectId) return { ...route, view: 'project-detail' };
  if (route.view === 'project-detail' && !route.projectId)
    return { view: 'overview', projectId: '' };
  return route;
}
export function workspaceRoute(url: URL): WorkspaceRoute {
  const view = url.searchParams.get('view');
  const projectId = url.searchParams.get('project') || '';
  const metric = url.searchParams.get('metric') || undefined;
  const projects = url.searchParams.get('projects');
  return normalizeWorkspaceRoute({
    view: workspaceViews.includes(view as WorkspaceView) ? (view as WorkspaceView) : 'overview',
    projectId: projectId.length <= 100 ? projectId : '',
    ...(metric ? { metric } : {}),
    ...(projects === 'all' || projects === 'ongoing' ? { projects } : {}),
  });
}
export function workspaceHref(input: WorkspaceRoute, current: URL) {
  const route = normalizeWorkspaceRoute(input);
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
