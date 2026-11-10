import { ArrowRight } from 'lucide-react';
import { isHistorical, projectStatus, shortDate, type Project } from '../lib/model';
import { remainingSchedule } from '../lib/readiness';
import { ProjectSurface } from './ProjectThemes';

export function OngoingProjects({
  projects,
  date,
  onSelect,
}: {
  projects: Project[];
  date: string;
  onSelect: (id: string) => void;
}) {
  const ongoing = projects.filter(
    (project) => !isHistorical(project) && projectStatus(project.status) === '施工中',
  );
  return (
    <section className="ongoing-projects" aria-labelledby="ongoing-projects-title">
      <h2 id="ongoing-projects-title">在施工工地</h2>
      <div className="ongoing-project-grid">
        {ongoing.map((project) => (
          <ProjectSurface
            key={project.id}
            projectId={project.id}
            data-project-id={project.id}
            className="ongoing-project-card"
          >
            <button
              className="ongoing-project-link"
              aria-label={`打开工地：${project.name}`}
              onClick={() => onSelect(project.id)}
            >
              <strong>{project.name}</strong>
              <ArrowRight size={16} aria-hidden="true" />
              <span className="ongoing-project-progress">
                <span>{projectStatus(project.status)}</span>
                <span>{remainingSchedule(project, date)}</span>
              </span>
              <span className="ongoing-project-dates">
                {shortDate(project.start)} — {shortDate(project.end)}
              </span>
            </button>
          </ProjectSurface>
        ))}
      </div>
      {!ongoing.length && <p className="ongoing-project-empty">暂无在施工工地</p>}
    </section>
  );
}
