import { expect, it } from 'vitest';
import {
  normalizeWorkspaceRoute,
  sameWorkspaceRoute,
  workspaceHref,
  workspaceRoute,
} from './workspace-navigation';
it('plain homepage has no project selection; only an explicit ID deep link selects a site', () => {
  expect(workspaceRoute(new URL('https://example.test/'))).toEqual({
    view: 'overview',
    projectId: '',
  });
  expect(workspaceRoute(new URL('https://example.test/?project=site-2'))).toEqual({
    view: 'project-detail',
    projectId: 'site-2',
  });
  expect(workspaceRoute(new URL('https://example.test/?view=people'))).toEqual({
    view: 'people',
    projectId: '',
  });
});
it('navigation keeps unrelated URL settings, replaces page/project identity and encodes IDs safely', () => {
  const link = workspaceHref(
    { view: 'project-detail', projectId: 'site / 同名#2' },
    new URL('https://example.test/?view=purchases&mobile=1&project=old'),
  );
  const parsed = new URL(link, 'https://example.test');
  expect(parsed.searchParams.get('mobile')).toBe('1');
  expect(parsed.searchParams.get('view')).toBe('project-detail');
  expect(workspaceRoute(parsed).projectId).toBe('site / 同名#2');
  const home = workspaceHref({ view: 'overview', projectId: '' }, parsed);
  expect(new URL(home, parsed).searchParams.get('project')).toBe(null);
  expect(sameWorkspaceRoute(workspaceRoute(parsed), workspaceRoute(new URL(home, parsed)))).toBe(
    false,
  );
});
it('legacy site links and new detail links resolve to the same explicit detail state', () => {
  for (const query of [
    '?project=one',
    '?view=overview&project=one',
    '?view=project-detail&project=one',
  ])
    expect(workspaceRoute(new URL('https://example.test/' + query))).toEqual({
      view: 'project-detail',
      projectId: 'one',
    });
  expect(normalizeWorkspaceRoute({ view: 'overview', projectId: 'one' })).toEqual({
    view: 'project-detail',
    projectId: 'one',
  });
  expect(workspaceRoute(new URL('https://example.test/?view=project-detail'))).toEqual({
    view: 'overview',
    projectId: '',
  });
});
it('overview and a detail are different routes; business-page project filters remain filters', () => {
  expect(
    sameWorkspaceRoute(
      { view: 'overview', projectId: '' },
      { view: 'project-detail', projectId: 'one' },
    ),
  ).toBe(false);
  expect(workspaceRoute(new URL('https://example.test/?view=reminders&project=one'))).toEqual({
    view: 'reminders',
    projectId: 'one',
  });
});
