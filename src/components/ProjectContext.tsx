import type { Project } from '../lib/model';
import { projectThemeStyle, useProjectTheme } from './ProjectThemes';
export function ProjectContext({
  project,
  label = '当前工地：',
}: {
  project: Pick<Project, 'id' | 'name'>;
  label?: string;
}) {
  return (
    <div
      className="project-context"
      style={projectThemeStyle(useProjectTheme(project.id))}
      data-context-project-id={project.id}
      aria-label={`当前操作工地：${project.name}`}
    >
      <span>{label}</span>
      <strong className="current-project-name">{project.name}</strong>
    </div>
  );
}
