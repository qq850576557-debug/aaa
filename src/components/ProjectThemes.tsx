import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import {
  allocateProjectHues,
  projectTheme,
  readProjectHues,
  type ProjectHues,
} from '../lib/project-themes';
const Themes = createContext<ProjectHues>({});
export function ProjectThemeProvider({
  projects,
  scope,
  children,
}: {
  projects: { id: string }[];
  scope: string;
  children: ReactNode;
}) {
  const key = 'chunmo-project-hues:' + scope;
  const [stored, setStored] = useState<ProjectHues>(() => {
    try {
      return readProjectHues(localStorage.getItem(key));
    } catch {
      return {};
    }
  });
  const hues = useMemo(() => allocateProjectHues(projects, stored), [projects, stored]);
  useEffect(() => {
    if (JSON.stringify(stored) === JSON.stringify(hues)) return;
    setStored(hues);
    try {
      localStorage.setItem(key, JSON.stringify(hues));
    } catch {
      /* Appearance remains available for this session. */
    }
  }, [hues, stored, key]);
  return <Themes.Provider value={hues}>{children}</Themes.Provider>;
}
export function useProjectTheme(id?: string) {
  return projectTheme(useContext(Themes)[id || '']);
}
export function useProjectThemeStyles() {
  const hues = useContext(Themes);
  return (id?: string) => projectThemeStyle(projectTheme(hues[id || '']));
}
export function projectThemeStyle(theme: ReturnType<typeof projectTheme>): CSSProperties {
  return {
    '--project-hue': theme.hue,
    '--project-base': theme.base,
    '--project-ink': theme.ink,
    '--project-border': theme.border,
    '--project-surface': theme.surface,
    '--project-tag': theme.tag,
    '--project-selected': theme.selected,
    '--project-selected-hover': theme.selectedHover,
  } as CSSProperties;
}
export function ProjectSurface({
  projectId,
  ...props
}: HTMLAttributes<HTMLDivElement> & { projectId?: string }) {
  const theme = useProjectTheme(projectId);
  return (
    <div
      {...props}
      style={{ ...projectThemeStyle(theme), ...props.style }}
      data-project-hue={theme.hue}
    />
  );
}
export function ThemedWorkspace({
  projects,
  scope,
  projectId,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  projects: { id: string }[];
  scope: string;
  projectId?: string;
}) {
  return (
    <ProjectThemeProvider key={scope} projects={projects} scope={scope}>
      <ProjectSurface {...props} projectId={projectId} />
    </ProjectThemeProvider>
  );
}
