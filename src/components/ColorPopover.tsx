import { useEffect, useRef, useState } from 'react';
import Wheel from '@uiw/react-color-wheel';
import { hexToHsva, hsvaToHex } from '@uiw/color-convert';
import { Modal, type Anchor } from './Modal';
import { palette, type Trade } from '../lib/model';
export function ColorControls({
  color,
  defaultColor,
  recent,
  onChange,
  compact = false,
}: {
  color: string;
  defaultColor: string;
  recent: string[];
  onChange: (color: string) => void;
  compact?: boolean;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(color);
  const hsva = hexToHsva(valid ? color : defaultColor);
  return (
    <div className="color-controls">
      <div className="color-wheel">
        <Wheel
          color={hsva}
          width={compact ? 100 : 104}
          height={compact ? 100 : 104}
          onChange={(c) => onChange(c.hex)}
        />
      </div>
      <div className="color-settings">
        <label>
          自定义颜色
          <input
            aria-label="自定义颜色"
            value={color}
            pattern="#[0-9a-fA-F]{6}"
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        <label>
          饱和度 <output>{Math.round(hsva.s)}%</output>
          <input
            aria-label="饱和度"
            type="range"
            min={0}
            max={100}
            value={hsva.s}
            onChange={(e) => onChange(hsvaToHex({ ...hsva, s: Number(e.target.value) }))}
          />
        </label>
        <label>
          明度 <output>{Math.round(hsva.v)}%</output>
          <input
            aria-label="明度"
            type="range"
            min={0}
            max={100}
            value={hsva.v}
            onChange={(e) => onChange(hsvaToHex({ ...hsva, v: Number(e.target.value) }))}
          />
        </label>
        <div className="color-current">
          <i style={{ background: valid ? color : defaultColor }} />
          当前颜色 {color}
        </div>
      </div>
      <div className="span2">
        <p>品牌推荐与常用配色</p>
        <div className="swatches">
          {['#244e42', '#8fa979', ...palette].map((c) => (
            <button
              type="button"
              key={c}
              aria-label={`选择颜色 ${c}`}
              className={color === c ? 'selected' : ''}
              style={{ background: c }}
              onClick={() => onChange(c)}
            />
          ))}
        </div>
        {recent.length > 0 && (
          <>
            <p>最近使用</p>
            <div className="swatches">
              {recent.map((c) => (
                <button
                  type="button"
                  key={c}
                  aria-label={`最近颜色 ${c}`}
                  style={{ background: c }}
                  onClick={() => onChange(c)}
                />
              ))}
            </div>
          </>
        )}
        <button className="text-btn" type="button" onClick={() => onChange(defaultColor)}>
          恢复默认颜色
        </button>
      </div>
    </div>
  );
}
export function ColorPopover({
  trade,
  recent,
  anchor,
  onChange,
  onClose,
}: {
  trade: Trade;
  recent: string[];
  anchor: Anchor;
  onChange: (color: string) => void;
  onClose: () => void;
}) {
  const initial = useRef(trade.color);
  const [draft, setDraft] = useState(trade.color);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flush = () => {
    clearTimeout(timer.current);
    if (/^#[0-9a-fA-F]{6}$/.test(draft) && draft !== trade.color) onChange(draft);
  };
  const close = () => {
    flush();
    onClose();
  };
  return (
    <Modal
      title={`${trade.name} · 工种颜色`}
      className="color-panel"
      subtitle="项目统一色相 · 即时保存工种深浅"
      anchor={anchor}
      onClose={close}
    >
      <div className="modal-body">
        <ColorControls
          compact
          color={draft}
          defaultColor={trade.defaultColor}
          recent={recent}
          onChange={(color) => {
            setDraft(color);
            clearTimeout(timer.current);
            if (/^#[0-9a-fA-F]{6}$/.test(color))
              timer.current = setTimeout(() => onChange(color), 400);
          }}
        />
      </div>
      <footer className="modal-foot">
        <button
          onClick={() => {
            clearTimeout(timer.current);
            onChange(initial.current);
            onClose();
          }}
        >
          取消并恢复
        </button>
        <button className="primary" onClick={close}>
          完成
        </button>
      </footer>
    </Modal>
  );
}
