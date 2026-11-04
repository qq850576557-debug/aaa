import { useState } from 'react';
import { primaryPerson, duplicatePeople } from '../lib/person-links';
import { type Data, type Person } from '../lib/model';
import { Confirm } from './Modal';
export function PersonIdentityReview({
  data,
  onChange,
}: {
  data: Data;
  onChange: (fn: (d: Data) => Data) => void;
}) {
  const people = data.people ?? [];
  const [source, setSource] = useState(''),
    [target, setTarget] = useState(''),
    [confirm, setConfirm] = useState(false);
  const a = people.find((p) => p.id === source),
    b = people.find((p) => p.id === target);
  const candidates = people.filter((p) => !p.identityLink && duplicatePeople(people, p).length);
  const label = (p: Person) =>
    `${p.name} · ${p.notes || p.trade || '无备注'}${p.deleted ? '（已移出）' : ''}`;
  return (
    <details className="person-identity-review">
      <summary>重复人员待核对（{candidates.length}个候选档案）</summary>
      <p>
        仅凭同名同工种不会自动合并。确认同一真人后只建立可撤销主档案映射，保留原ID、项目分配、工期、考核来源及历史；统计按主档案去重。生产批量改ID/永久删除须另审批。
      </p>
      <label>
        原档案
        <select aria-label="原档案" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">选择待核对档案</option>
          {people
            .filter((p) => !p.identityLink)
            .map((p) => (
              <option value={p.id} key={p.id}>
                {label(p)}
              </option>
            ))}
        </select>
      </label>
      <label>
        当前有效主档案
        <select
          aria-label="当前有效主档案"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">选择主档案</option>
          {people
            .filter((p) => !p.deleted && p.active && !p.identityLink && p.id !== source)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {label(p)}
              </option>
            ))}
        </select>
      </label>
      <button disabled={!a || !b} onClick={() => setConfirm(true)}>
        核对关联影响
      </button>
      {a && (
        <p>
          原关联：项目{data.projects.filter((p) => p.staffIds?.includes(a.id)).length}、工种
          {data.trades.filter((p) => p.staffIds?.includes(a.id)).length}、任务
          {data.tasks.filter((p) => p.staffIds?.includes(a.id)).length}
          。私有考核原始记录保持不变，在考核历史中核对后再确认。
        </p>
      )}
      {people
        .filter((p) => p.identityLink)
        .map((p) => (
          <p key={p.id}>
            {label(p)} → {people.find((x) => x.id === primaryPerson(people, p.id))?.name}
            <button
              onClick={() =>
                onChange((d) => ({
                  ...d,
                  people: d.people!.map((x) =>
                    x.id === p.id ? { ...x, identityLink: undefined } : x,
                  ),
                }))
              }
            >
              撤销关联
            </button>
          </p>
        ))}
      {people
        .filter((p) => p.name === '阿萨德官方' && !p.hiddenFromSelectors)
        .map((p) => (
          <button
            key={p.id}
            onClick={() =>
              onChange((d) => ({
                ...d,
                people: d.people!.map((x) =>
                  x.id === p.id ? { ...x, hiddenFromSelectors: true, active: false } : x,
                ),
              }))
            }
          >
            确认停用测试候选：{label(p)}（保留历史）
          </button>
        ))}
      {confirm && a && b && (
        <Confirm
          danger={false}
          title="确认属于同一真实人员？"
          message={`${label(a)} → ${label(b)}。仅建立主档案关联，保留原始记录。不同真人请选择取消；误关联可撤销。`}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            onChange((d) => ({
              ...d,
              people: d.people!.map((p) =>
                p.id === source
                  ? {
                      ...p,
                      identityLink: { personId: target, reason: '人员管理中人工核实同一真实人员' },
                    }
                  : p,
              ),
            }));
            setConfirm(false);
            setSource('');
          }}
        />
      )}
    </details>
  );
}
