import type { Project } from '../lib/model';
import { projectThemeStyle, useProjectTheme } from './ProjectThemes';
export function PurchaseProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label
      className="project-context purchase-project-picker"
      style={projectThemeStyle(useProjectTheme(value))}
    >
      <span>当前工地：</span>
      <select aria-label="选择采购工地" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">全部工地</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
