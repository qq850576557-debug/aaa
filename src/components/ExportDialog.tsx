import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Modal } from './Modal';
import { DateField } from './DateField';
import { dateOK, projectRange, type Data, type Project } from '../lib/model';
import { downloadBlob, exportFilename, monthRanges, schedulePNG } from '../lib/export';
export function ExportDialog({
  data,
  project,
  onClose,
  onNotice,
}: {
  data: Data;
  project: Project;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [a, b] = projectRange(data, project);
  const [start, setStart] = useState(a),
    [end, setEnd] = useState(b),
    [scale, setScale] = useState<1 | 2>(2),
    [mode, setMode] = useState('full'),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [error, setError] = useState(''),
    [files, setFiles] = useState<{ blob: Blob; name: string }[]>([]);
  async function generate() {
    if (!dateOK(start) || !dateOK(end) || start > end || start < a || end > b) {
      setError('请选择项目完整日期范围内的有效起止日期。');
      return;
    }
    setBusy(true);
    setError('');
    setFiles([]);
    try {
      const ranges = mode === 'month' ? monthRanges(start, end) : [{ start, end }],
        result: { blob: Blob; name: string }[] = [];
      for (let i = 0; i < ranges.length; i++) {
        setProgress(`正在生成 ${i + 1} / ${ranges.length}`);
        await new Promise(requestAnimationFrame);
        const r = ranges[i],
          blob = await schedulePNG(data, project, { ...r, scale });
        result.push({
          blob,
          name:
            mode === 'month'
              ? exportFilename(`${project.name}-${r.start.slice(0, 7)}`)
              : exportFilename(project.name),
        });
      }
      if (mode === 'full') {
        downloadBlob(result[0].blob, result[0].name);
        onNotice('长图已导出');
        onClose();
      } else {
        setFiles(result);
        onNotice(`已生成 ${result.length} 张月度长图，请逐张下载。`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      onNotice(`导出失败：${message}`);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }
  return (
    <Modal
      title="导出施工工期长图"
      subtitle="完整日期与任务按实际数据绘制，不截取当前屏幕。"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="modal-body">
        <div className="form-grid">
          <DateField
            label="导出开始日期"
            value={start}
            required
            onChange={setStart}
            rangeStart={start}
            rangeEnd={end}
          />
          <DateField
            label="导出结束日期"
            value={end}
            required
            onChange={setEnd}
            rangeStart={start}
            rangeEnd={end}
          />
          <label>
            导出方式
            <select
              aria-label="导出方式"
              disabled={busy}
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="full">完整长图 · 连续宽图</option>
              <option value="month">按月份分段导出</option>
            </select>
          </label>
          <label>
            清晰度
            <select
              aria-label="清晰度"
              disabled={busy}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value) as 1 | 2)}
            >
              <option value="2">2 倍 · 推荐</option>
              <option value="1">1 倍 · 标准</option>
            </select>
          </label>
        </div>
        <p className="form-info">
          每日固定 64px，不缩小字体。短任务条以 T
          编号对应完整明细。较长项目可选月份分段，超出浏览器尺寸时会明确提示。
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p className="export-progress" role="status">
            <Loader2 className="spin" size={18} />
            {progress}
          </p>
        )}
        {files.length > 0 && (
          <div className="export-files">
            {files.map((file) => (
              <button
                key={file.name}
                onClick={() => {
                  downloadBlob(file.blob, file.name);
                  onNotice('月度长图已导出');
                }}
              >
                <Download size={17} />
                {file.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <footer className="modal-foot">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="primary" disabled={busy} onClick={() => void generate()}>
          {busy ? '正在生成…' : '生成并导出'}
        </button>
      </footer>
    </Modal>
  );
}
