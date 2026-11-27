import { useEffect, useId } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { CloudError, cloudApi } from '../lib/cloud';
import { designUrl } from '../lib/owner-design';

export type ProjectDesign = { rendering: string; panorama: string; version: number };
export type DesignSettings = ProjectDesign & { origins: string[] };

const fields = [
  ['rendering', '效果图'],
  ['panorama', '全景图'],
] as const;

export function ProjectOwnerDesign({
  projectId,
  draft,
  onLoad,
  onChange,
  onError,
}: {
  projectId: string;
  draft?: DesignSettings;
  onLoad: (value?: DesignSettings) => void;
  onChange: (value: DesignSettings) => void;
  onError: (message: string) => void;
}) {
  const id = useId();
  useEffect(() => {
    let active = true;
    cloudApi<DesignSettings>('/projects/' + encodeURIComponent(projectId) + '/owner-design').then(
      (settings) => {
        if (active) onLoad(settings);
      },
      (error) => {
        if (!active) return;
        if (error instanceof CloudError && error.status === 404) onLoad();
        else onError('无法读取设计成果，请关闭弹窗后重试。');
      },
    );
    return () => {
      active = false;
    };
  }, [projectId]);
  if (!draft) return null;
  return (
    <section className="project-owner-section owner-design" aria-label="设计成果">
      <h3>设计成果</h3>
      {fields.map(([key, label]) => {
        const preview = designUrl(draft[key].trim());
        return (
          <div key={key} className="form-field">
            <label htmlFor={id + key}>{label}链接</label>
            <div className="owner-design-input">
              <input
                id={id + key}
                type="url"
                maxLength={1500}
                placeholder="粘贴 HTTPS 链接"
                value={draft[key]}
                onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
              />
              {preview && (
                <a
                  aria-label={'预览' + label}
                  href={preview}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={15} />
                </a>
              )}
              {draft[key] && (
                <button
                  type="button"
                  aria-label={'清空' + label}
                  onClick={() => onChange({ ...draft, [key]: '' })}
                >
                  <X size={15} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
