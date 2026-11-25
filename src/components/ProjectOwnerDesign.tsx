import { useEffect, useState } from 'react';
import { CloudError, cloudApi } from '../lib/cloud';
import { designUrl } from '../lib/owner-design';

type Design = { rendering: string; panorama: string; version: number; origins: string[] };
const fields = [
  ['rendering', '效果图'],
  ['panorama', '全景图'],
] as const;

export function ProjectOwnerDesign({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const url = '/projects/' + encodeURIComponent(projectId) + '/owner-design';
  const [saved, setSaved] = useState<Design>();
  const [draft, setDraft] = useState({ rendering: '', panorama: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    cloudApi<Design>(url).then(
      (value) => {
        if (active) {
          setSaved(value);
          setDraft(value);
        }
      },
      (e) => {
        if (active && (!(e instanceof CloudError) || e.status !== 404)) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [url]);
  async function save() {
    if (!saved || busy) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const value = await cloudApi<Design>(url, 'PUT', {
        rendering: draft.rendering,
        panorama: draft.panorama,
        version: saved.version,
      });
      setSaved(value);
      setDraft(value);
      setNotice('设计成果已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : '设计成果保存失败');
    } finally {
      setBusy(false);
    }
  }
  if (!saved) return error ? <p role="alert">{error}</p> : null;
  const changed = fields.some(([key]) => draft[key] !== saved[key]);
  const invalid = fields.some(
    ([key]) => draft[key].trim() && !designUrl(draft[key].trim(), saved.origins),
  );
  return (
    <details
      className="form-field owner-access owner-design"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
      }}
    >
      <summary>业主设计成果</summary>
      <div className="form-grid">
        <p className="span2 owner-design-copy">所属项目 {projectName}</p>
        {fields.map(([key, label]) => {
          const preview = designUrl(draft[key].trim(), saved.origins);
          return (
            <div key={key} className="form-field span2 owner-design-field">
              <label htmlFor={'owner-design-' + key}>{label}链接</label>
              <div className="owner-design-input">
                <input
                  id={'owner-design-' + key}
                  type="url"
                  maxLength={1500}
                  placeholder={'粘贴 HTTPS ' + label + '链接'}
                  value={draft[key]}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
                {preview && (
                  <a href={preview} target="_blank" rel="noopener noreferrer">
                    预览{label}
                  </a>
                )}
                {draft[key] && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={'清空' + label}
                    onClick={() => setDraft({ ...draft, [key]: '' })}
                  >
                    清空
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <p className="span2 owner-design-copy">同一住宅的已授权家庭成员共享设计成果。</p>
        {(!saved.origins.length || invalid) && (
          <p className="span2 owner-design-copy">
            {saved.origins.length
              ? '请输入已配置微信业务域名下的 HTTPS 链接。'
              : '尚未配置微信业务域名。'}
          </p>
        )}
        <div className="span2 owner-design-actions">
          {notice && <span role="status">{notice}</span>}
          <button
            type="button"
            disabled={!changed || busy}
            onClick={() => {
              setDraft(saved);
              setError('');
              setNotice('');
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={!changed || invalid || busy}
            onClick={() => void save()}
          >
            保存设计成果
          </button>
        </div>
        {error && (
          <p className="span2" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
