import { expect, it } from 'vitest';
import { sameWorkspaceRoute, workspaceHref, workspaceRoute } from './workspace-navigation';
it('plain homepage has no project selection; only an explicit ID deep link selects a site', () => {
  expect(workspaceRoute(new URL('https://example.test/'))).toEqual({
    view: 'overview',
    projectId: '',
  });
  expect(workspaceRoute(new URL('https://example.test/?project=site-2'))).toEqual({
    view: 'overview',
    projectId: 'site-2',
  });
  expect(workspaceRoute(new URL('https://example.test/?view=people'))).toEqual({
    view: 'people',
    projectId: '',
  });
});
it('navigation keeps unrelated URL settings, replaces page/project identity and encodes IDs safely', () => {
  const link = workspaceHref(
    { view: 'overview', projectId: 'site / 同名#2' },
    new URL('https://example.test/?view=purchases&mobile=1&project=old'),
  );
  const parsed = new URL(link, 'https://example.test');
  expect(parsed.searchParams.get('mobile')).toBe('1');
  expect(parsed.searchParams.get('view')).toBe(null);
  expect(workspaceRoute(parsed).projectId).toBe('site / 同名#2');
  const home = workspaceHref({ view: 'overview', projectId: '' }, parsed);
  expect(new URL(home, parsed).searchParams.get('project')).toBe(null);
  expect(sameWorkspaceRoute(workspaceRoute(parsed), workspaceRoute(new URL(home, parsed)))).toBe(
    false,
  );
});
