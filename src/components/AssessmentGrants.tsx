import { useState } from 'react';
import { cloudApi } from '../lib/cloud';
import { Confirm, Modal } from './Modal';
export type AssessmentAccess = { allowed: boolean; owner: boolean; recorders?: string[] };
export function AssessmentGrants({
  access,
  onChanged,
  onError,
}: {
  access: AssessmentAccess;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<
    { id: string; displayName: string; login: string; owner: boolean; active: boolean }[]
  >([]);
  const [grant, setGrant] = useState<{ id: string; enabled: boolean; name: string } | null>(null);
  if (!access.owner) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          void cloudApi<{ accounts: typeof accounts }>('/directory')
            .then((r) => setAccounts(r.accounts))
            .catch(onError);
        }}
      >
        考核记录人授权
      </button>
      {open && (
        <Modal title="考核记录人授权" onClose={() => setOpen(false)}>
          <div className="modal-body recorder-grants">
            <p>
              获授权账号可查看、记录及导出本工作室全部考核。普通员工默认不可读取。负责人始终可操作。
            </p>
            {accounts
              .filter((a) => !a.owner && a.active)
              .map((a) => (
                <label className="recorder-grant-row" key={a.id}>
                  <input
                    type="checkbox"
                    aria-label={`${a.displayName || a.login}（${a.login}）`}
                    checked={access.recorders?.includes(a.id) ?? false}
                    onChange={(e) =>
                      setGrant({
                        id: a.id,
                        enabled: e.target.checked,
                        name: a.displayName || a.login,
                      })
                    }
                  />
                  <span>
                    <strong>{a.displayName || a.login}</strong>
                    <small>（{a.login}）</small>
                  </span>
                </label>
              ))}
          </div>
          <footer className="modal-foot">
            <button onClick={() => setOpen(false)}>关闭</button>
          </footer>
        </Modal>
      )}
      {grant && (
        <Confirm
          title="修改考核授权？"
          message={`${grant.enabled ? '授权' : '撤销'}「${grant.name}」查看、记录及导出本工作室全部考核的权限。不改变其他账号权限。`}
          onCancel={() => setGrant(null)}
          onConfirm={() => {
            void cloudApi(`/assessments/recorders/${encodeURIComponent(grant.id)}`, 'PUT', {
              enabled: grant.enabled,
            })
              .then(() => {
                setGrant(null);
                onChanged();
              })
              .catch(onError);
          }}
        />
      )}
    </>
  );
}
