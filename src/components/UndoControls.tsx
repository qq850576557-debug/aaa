import { useEffect, useReducer } from 'react';
import { Undo2, Redo2 } from 'lucide-react';
import { businessUndo } from '../lib/undo-manager';
const session = crypto.randomUUID();
export function UndoControls({ scope }: { scope: string }) {
  const [, render] = useReducer((n) => n + 1, 0);
  useEffect(() => businessUndo.subscribe(render), []);
  useEffect(() => {
    businessUndo.reset(session + scope);
  }, [scope]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.defaultPrevented ||
        e.altKey ||
        !(e.ctrlKey || e.metaKey) ||
        target?.closest(
          'input,textarea,[contenteditable]:not([contenteditable=false]),[role=textbox]',
        )
      )
        return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      e.preventDefault();
      void businessUndo.run(k === 'y' || e.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <div className="business-undo-controls">
      <button
        className="icon-btn"
        disabled={businessUndo.busy || !businessUndo.past.length}
        title={`撤销（Ctrl+Z） · ${businessUndo.past.length}/50`}
        aria-label="撤销"
        onClick={() => void businessUndo.run('undo')}
      >
        <Undo2 size={17} />
      </button>
      <button
        className="icon-btn"
        disabled={businessUndo.busy || !businessUndo.future.length}
        title="重做（Ctrl+Y / Ctrl+Shift+Z）"
        aria-label="重做"
        onClick={() => void businessUndo.run('redo')}
      >
        <Redo2 size={17} />
      </button>
      {businessUndo.message && (
        <div className="undo-operation-message" role="status">
          {businessUndo.message}
          {businessUndo.canDiscard && (
            <button onClick={() => void businessUndo.discardFailed()}>保留当前并放弃此步</button>
          )}
        </div>
      )}
    </div>
  );
}
