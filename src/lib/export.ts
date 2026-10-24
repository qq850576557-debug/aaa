import {
  days,
  distance,
  duration,
  lanes,
  projectRange,
  projectStatus,
  weekday,
  type Data,
  type Project,
} from './model';
import type { History } from './history';
import { BRAND_LOGO_SRC, BRAND_NAME, BRAND_INITIALS, BRAND_SLOGAN } from './brand';
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function backupJSON(data: Data, history?: History) {
  downloadBlob(
    new Blob(
      [
        JSON.stringify(
          history ? { format: 'chunmo-history-backup', version: 1, data, history } : data,
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    ),
    `春茉空间-完整备份-${new Date().toISOString().slice(0, 10)}.json`,
  );
}
export const exportFilename = (name: string) =>
  `${name.replace(/[\\/:*?"<>|]/g, '-')}-施工工期.png`;
export type PNGOptions = { scale?: 1 | 2; start?: string; end?: string };
export function monthRanges(start: string, end: string) {
  const result: { start: string; end: string }[] = [];
  for (const d of days(start, end)) {
    const last = result.at(-1);
    if (last && last.start.slice(0, 7) === d.slice(0, 7)) last.end = d;
    else result.push({ start: d, end: d });
  }
  return result;
}
// No viewport capture or downscaling: every day has a fixed readable 64px column.
// Month exports call this same renderer with a date subset and retain consistent row heights.
export async function schedulePNG(
  data: Data,
  project: Project,
  options: PNGOptions = {},
): Promise<Blob> {
  await document.fonts.load('24px ChunmoBrand', BRAND_NAME);
  await document.fonts.ready;
  const range = projectRange(data, project),
    start = options.start ?? range[0],
    end = options.end ?? range[1];
  const dates = days(start, end);
  if (!dates.length) throw new Error('导出日期范围无效');
  const scale = options.scale ?? 2,
    cell = 64,
    label = 260,
    margin = 40,
    width = Math.max(1000, margin * 2 + label + dates.length * cell);
  const temp = document.createElement('canvas').getContext('2d');
  if (!temp) throw new Error('浏览器不支持图片生成');
  temp.font = '16px "PingFang SC", "Microsoft YaHei", sans-serif';
  const wrap = (s: string, max: number) => {
    const out: string[] = [];
    let line = '';
    for (const ch of s.replace(/\r/g, '')) {
      if (ch === '\n') {
        out.push(line);
        line = '';
        continue;
      }
      if (temp.measureText(line + ch).width > max) {
        out.push(line);
        line = ch;
      } else line += ch;
    }
    if (line || !out.length) out.push(line);
    return out;
  };
  const trades = data.trades
      .filter((g) => g.projectId === project.id)
      .sort((a, b) => a.order - b.order),
    tasks = data.tasks.filter((t) => t.projectId === project.id);
  const groups = trades.map((g) => ({
    g,
    rows: lanes(tasks.filter((t) => t.tradeId === g.id)),
    lines: wrap(g.name, label - 50),
  }));
  const rowHeights = groups.map((g) =>
    Math.max(82, g.rows.length * 48 + 24, g.lines.length * 24 + 30),
  );
  const chartHeight = 100 + rowHeights.reduce((a, b) => a + b, 0);
  const notes = data.notes
    .filter((n) => n.projectId === project.id && (!n.date || (n.date >= start && n.date <= end)))
    .sort((a, b) => a.date.localeCompare(b.date))
    .flatMap((n) =>
      wrap(
        `${n.done ? '✓' : '○'} ${n.date || '项目备忘'} · ${n.kind} · ${n.title}${n.owner ? ' / ' + n.owner : ''}${n.content ? '：' + n.content : ''}`,
        width - margin * 2,
      ),
    );
  const details = tasks
    .filter((t) => t.start <= end && t.end >= start)
    .flatMap((t) =>
      wrap(
        `T${tasks.findIndex((x) => x.id === t.id) + 1} · ${trades.find((g) => g.id === t.tradeId)?.name} / ${t.name} · ${t.start} — ${t.end} · ${duration(t.start, t.end)}天 · ${t.status}${t.owner ? ' · ' + t.owner : ''}${t.notes ? ' · ' + t.notes : ''}`,
        width - margin * 2,
      ),
    );
  const projectNotes = project.notes ? wrap(`项目备注：${project.notes}`, width - margin * 2) : [];
  const columns = Math.max(1, Math.floor((width - margin * 2) / 240)),
    legendRows = Math.max(1, Math.ceil(trades.length / columns)),
    header = 240 + legendRows * 32;
  const height =
    header + chartHeight + 130 + (details.length + notes.length + projectNotes.length) * 27;
  if (width * scale > 32000 || height * scale > 32000 || width * height * scale * scale > 60000000)
    throw new Error(
      '当前范围超出浏览器安全画布尺寸。请改用按月份分段或 1 倍清晰度；不会缩小字体或遗漏日期。',
    );
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fafbf6';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  const text = (
    s: string,
    x: number,
    y: number,
    size = 16,
    color = '#304c35',
    bold = false,
    max?: number,
  ) => {
    ctx.fillStyle = color;
    ctx.font = `${bold ? '600' : '400'} ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    if (max && ctx.measureText(s).width > max) {
      while (s && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
      s += '…';
    }
    ctx.fillText(s, x, y);
  };
  const rect = (x: number, y: number, w: number, h: number, color = '#e2e8db') => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  let brandX = margin;
  if (BRAND_LOGO_SRC) {
    const img = new Image();
    img.src = BRAND_LOGO_SRC;
    await img.decode();
    const ratio = Math.min(68 / img.naturalWidth, 68 / img.naturalHeight);
    ctx.drawImage(img, margin, 25, img.naturalWidth * ratio, img.naturalHeight * ratio);
    brandX += img.naturalWidth * ratio + 20;
  }
  ctx.font = '32px ChunmoBrand';
  ctx.fillStyle = '#244e42';
  ctx.fillText(BRAND_NAME, brandX, 46);
  text(BRAND_INITIALS, brandX + ctx.measureText(BRAND_NAME).width + 18, 46, 20, '#244e42');
  text(BRAND_SLOGAN, brandX, 78, 15, '#68835e');
  if (!BRAND_LOGO_SRC)
    text('原始品牌 Logo 尚未提供 · 此处为项目名称文字', brandX, 104, 12, '#74846b');
  text(project.name, margin, 144, 28, '#244e42', true, width - margin * 2);
  text(
    `计划 ${project.start} — ${project.end}  /  ${duration(project.start, project.end)} 天（自然日，含首尾）  /  ${projectStatus(project.status)}`,
    margin,
    181,
    17,
  );
  text(
    `本图日期 ${start} — ${end}  ·  ${dates.length} 天  ·  ${scale}× 清晰度`,
    margin,
    212,
    15,
    '#687f5f',
  );
  trades.forEach((g, i) => {
    const x = margin + ((i % columns) * (width - margin * 2)) / columns,
      y = 244 + Math.floor(i / columns) * 32;
    rect(x, y - 6, 12, 12, g.color);
    text(g.name, x + 22, y, 15, '#4e6b43', false, (width - margin * 2) / columns - 30);
  });
  const y = header;
  rect(margin, y, width - margin * 2, chartHeight, '#fff');
  text('施工工种 / 日期', margin + 16, y + 50, 16, '#4e6b43', true);
  const months: { start: number; count: number; label: string }[] = [];
  dates.forEach((d, i) => {
    if (months.at(-1)?.label === d.slice(0, 7)) months.at(-1)!.count++;
    else months.push({ start: i, count: 1, label: d.slice(0, 7) });
  });
  months.forEach((m) => {
    const x = margin + label + m.start * cell;
    rect(x, y, m.count * cell, 30, '#eef3e6');
    text(m.label, x + 8, y + 15, 14);
  });
  dates.forEach((d, i) => {
    const x = margin + label + i * cell;
    if (['六', '日'].includes(weekday(d))) rect(x, y + 30, cell, chartHeight - 30, '#f3f6ed');
    rect(x, y + 30, 1, chartHeight - 30);
    text(d.slice(5).replace('-', '/'), x + 9, y + 52, 15);
    text('周' + weekday(d), x + 14, y + 79, 14, '#6e8464');
  });
  rect(margin, y + 99, width - margin * 2, 1);
  let rowY = y + 100;
  groups.forEach(({ g, rows, lines }, ri) => {
    const rh = rowHeights[ri];
    rect(margin + 16, rowY + 28, 10, 10, g.color);
    lines.forEach((s, i) => text(s, margin + 36, rowY + 34 + i * 24, 16, '#39572d', true));
    rows.forEach((row, lane) =>
      row.forEach((t) => {
        if (t.start > end || t.end < start) return;
        const a = t.start < start ? start : t.start,
          b = t.end > end ? end : t.end,
          x = margin + label + distance(start, a) * cell + 4,
          w = duration(a, b) * cell - 8,
          ty = rowY + 14 + lane * 48;
        ctx.fillStyle = g.color + '38';
        ctx.strokeStyle = g.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, ty, w, 34, 5);
        ctx.fill();
        ctx.stroke();
        const index = tasks.findIndex((x) => x.id === t.id) + 1;
        const title = `${t.start < start ? '← ' : ''}${t.name}${t.end > end ? ' →' : ''}`;
        const fontSize = 15;
        ctx.font = `400 ${fontSize}px sans-serif`;
        text(
          ctx.measureText(title).width <= w - 14 ? title : `T${index}${t.end > end ? ' →' : ''}`,
          x + 7,
          ty + 17,
          fontSize,
          '#2c472b',
          false,
          w - 14,
        );
      }),
    );
    rowY += rh;
    rect(margin, rowY - 1, width - margin * 2, 1);
  });
  let noteY = y + chartHeight + 31;
  text('任务明细与事项', margin, noteY, 18, '#244e42', true);
  noteY += 31;
  for (const line of [...details, ...projectNotes, ...notes]) {
    text(line, margin, noteY, 16);
    noteY += 27;
  }
  text(
    `SJD · 导出于 ${new Date().toLocaleString('zh-CN')} · 完整记录以 JSON 备份为准`,
    margin,
    height - 28,
    13,
    '#718366',
  );
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 生成失败'))), 'image/png'),
  );
}
