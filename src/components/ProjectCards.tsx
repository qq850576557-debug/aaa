import { remainingSchedule, scheduleForecast } from '../lib/readiness';
import { useCurrentDate } from '../lib/useCurrentDate';
import { useRef, useState } from 'react';
import { useReorderMotion } from '../lib/useReorderMotion';
import { ArrowRight, GripVertical } from 'lucide-react';
import { shortDate, projectStatus, type Data, type Project } from '../lib/model';

export function ProjectCards({
  data,
  projects,
  selected,
  onSelect,
  onReorder,
}: {
  data: Data;
  projects: Project[];
  selected: string;
  onSelect: (id: string) => void;
  onReorder: (source: string, before: string | null) => void;
}) {
  const now = useCurrentDate();
  const [drag, setDrag] = useState<string | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useReorderMotion(root, '.project-card', projects.map((p) => p.id).join('|'));
  return (
    <div ref={root} className="project-cards" aria-label="项目列表">
      {projects.map((p, index) => {
        return (
          <button
            key={p.id}
            data-project-id={p.id}
            draggable
            className={`project-card ${p.id === selected ? 'chosen' : ''} ${drag === p.id ? 'sorting' : ''} ${drag && before === p.id ? 'drop-before' : ''} ${drag && before === null && index === projects.length - 1 ? 'drop-after' : ''}`}
            aria-label={`切换项目${p.name}`}
            aria-pressed={p.id === selected}
            title="点击切换项目；拖放排序；Alt + 左右方向键排序"
            onClick={() => onSelect(p.id)}
            onDragStart={(e) => {
              setDrag(p.id);
              setBefore(p.id);
              e.dataTransfer.setData('text/plain', p.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setBefore(
                e.clientY < r.top + r.height / 2 ? p.id : (projects[index + 1]?.id ?? null),
              );
            }}
            onDrop={(e) => {
              e.preventDefault();
              const source = e.dataTransfer.getData('text/plain');
              const r = e.currentTarget.getBoundingClientRect();
              const target =
                e.clientY < r.top + r.height / 2 ? p.id : (projects[index + 1]?.id ?? null);
              if (source === drag) onReorder(source, target);
              setDrag(null);
            }}
            onDragEnd={() => {
              setDrag(null);
              setBefore(null);
            }}
            onKeyDown={(e) => {
              if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                if (e.key === 'ArrowLeft' && index > 0) onReorder(p.id, projects[index - 1].id);
                if (e.key === 'ArrowRight' && index < projects.length - 1)
                  onReorder(p.id, projects[index + 2]?.id ?? null);
              }
            }}
          >
            <div>
              <span className="project-status">{projectStatus(p.status)}</span>
              <GripVertical size={16} />
              <ArrowRight size={17} />
            </div>
            <h3>{p.name}</h3>
            <small>{remainingSchedule(p, now)}</small>
            <small className="card-forecast">
              {scheduleForecast(data, p).label.split(' · ').at(-1)}
            </small>
            <footer>
              <span>
                {shortDate(p.start)} — {shortDate(p.end)}
              </span>
            </footer>
          </button>
        );
      })}
    </div>
  );
}
