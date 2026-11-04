import { useProjectTheme, projectThemeStyle } from './ProjectThemes';
import {
  assessmentStats,
  checkFields,
  dailyAssessments,
  statusLabel,
  type Assessment,
  type CheckField,
} from '../lib/assessments';
const shortLabels: Record<CheckField, string> = {
  attendance: '签到',
  photo: '拍照',
  cleaning: '卫生',
};
export function ProjectAssessmentSummary({
  projectId,
  projectName,
  records,
  onClose,
  onHistory,
}: {
  projectId: string;
  projectName: string;
  records: Assessment[];
  onClose: () => void;
  onHistory?: (personId: string) => void;
}) {
  const theme = useProjectTheme(projectId);
  const siteRecords = records.filter((r) => r.projectId === projectId);
  const rows = assessmentStats(siteRecords);
  for (const r of siteRecords)
    if (!rows.some((s) => s.personId === r.personId))
      rows.push({
        personId: r.personId,
        personName: r.personName,
        projectId: r.projectId,
        projectName: r.projectName,
        total: 0,
        counts: Object.fromEntries(checkFields.map((f) => [f, { yes: 0, no: 0, pending: 0 }])),
      } as (typeof rows)[number]);
  return (
    <aside
      className="assessment-summary"
      style={projectThemeStyle(theme)}
      aria-label={`${projectName}工地数据小结`}
    >
      <header>
        <div>
          <strong>{projectName}</strong>
          <small>工地累计 · 仅云端确认记录，按天去重</small>
        </div>
        <button type="button" onClick={onClose} aria-label={`收起${projectName}数据小结`}>
          收起
        </button>
      </header>
      <table>
        <thead>
          <tr>
            <th>姓名</th>
            <th>签到/天</th>
            <th>拍照/天</th>
            <th>卫生/天</th>
            <th>记录</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.personId} data-person-id={r.personId}>
              <th>{r.personName}</th>
              {checkFields.map((f) => (
                <td key={f}>{r.counts[f].yes}天</td>
              ))}
              <td>
                <button
                  type="button"
                  className="assessment-summary-history"
                  onClick={() => onHistory?.(r.personId)}
                  aria-label={`查看${r.personName}打卡历史`}
                >
                  历史
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="assessment-empty">此工地尚无已保存打卡</p>}
    </aside>
  );
}
export function PersonAssessmentStats({
  personId,
  name,
  records,
}: {
  personId: string;
  name: string;
  records: Assessment[];
}) {
  const daily = dailyAssessments(records.filter((r) => r.personId === personId));
  const summaries = assessmentStats(records.filter((r) => r.personId === personId));
  const total = (f: CheckField) => summaries.reduce((n, r) => n + r.counts[f].yes, 0);
  return (
    <section className="assessment-person-stats" aria-label={`${name}跨工地统计`}>
      <header>
        <h3>{name} · 跨工地考核</h3>
        <small>全部工地历史，不受当前工地筛选限制</small>
      </header>
      <p className="assessment-person-total">
        全公司累计：签到 {total('attendance')}、拍照 {total('photo')}、卫生 {total('cleaning')}{' '}
        工地天次；覆盖 {new Set(daily.map((r) => r.date)).size} 个自然日。
      </p>
      <div className="assessment-person-projects">
        {summaries.map((s) => {
          const rows = daily
            .filter((r) => r.projectId === s.projectId)
            .sort((a, b) => b.date.localeCompare(a.date));
          const dates = rows.map((r) => r.date).sort();
          return (
            <article key={s.projectId}>
              <strong>{s.projectName}</strong>
              <small>
                {dates[0]} — {dates.at(-1)}
              </small>
              <p>
                签到 {s.counts.attendance.yes}天 · 拍照 {s.counts.photo.yes}天 · 卫生{' '}
                {s.counts.cleaning.yes}天
              </p>
              <details>
                <summary>每日明细 · {rows.length}天</summary>
                <table>
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>签到</th>
                      <th>拍照</th>
                      <th>卫生</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.date}>
                        <th>{r.date}</th>
                        {checkFields.map((f) => (
                          <td
                            key={f}
                            className={`assessment-detail-${r[f]}`}
                            title={
                              r.differences.includes(f)
                                ? '同日旧工种记录存在差异，请核对来源'
                                : statusLabel(f, r[f])
                            }
                          >
                            {r.differences.includes(f)
                              ? '待核对'
                              : r[f] === 'yes'
                                ? '✓'
                                : r[f] === 'no'
                                  ? '×'
                                  : '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.map((r) => (
                  <details className="assessment-source-detail" key={r.date}>
                    <summary>
                      {r.date} · 录入信息
                      {r.sources.length > 1 ? `与${r.sources.length}条旧工种来源` : ''}
                    </summary>
                    {r.sources.map((source) => (
                      <p key={source.id}>
                        {source.tradeName} ·{' '}
                        {checkFields
                          .map((f) => `${shortLabels[f]} ${statusLabel(f, source[f])}`)
                          .join(' · ')}
                        <br />
                        实际录入：{source.createdName} ·{' '}
                        {new Date(source.createdAt).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                        })}
                        <br />
                        最后修改：{source.updatedName} ·{' '}
                        {new Date(source.updatedAt).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                        })}
                      </p>
                    ))}
                  </details>
                ))}
              </details>
            </article>
          );
        })}
      </div>
      {!summaries.length && <p className="assessment-empty">这位师傅暂无已保存考核</p>}
    </section>
  );
}
