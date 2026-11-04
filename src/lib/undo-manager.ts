export type UndoCommand = {
  label: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
  discard?: () => Promise<void>;
  mergeKey?: string;
  merge?: (next: UndoCommand) => UndoCommand;
};
export class UndoManager {
  past: UndoCommand[] = [];
  future: UndoCommand[] = [];
  busy = false;
  replaying = false;
  message = '';
  scope = '';
  failedDirection: '' | 'undo' | 'redo' = '';
  generation = 0;
  private at = 0;
  private deferred: UndoCommand[] = [];
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  emit = () => {
    for (const fn of this.listeners) fn();
  };
  reset(scope = this.scope) {
    this.scope = scope;
    ++this.generation;
    this.past = [];
    this.future = [];
    this.message = '';
    this.failedDirection = '';
    this.at = 0;
    this.deferred = [];
    this.emit();
  }
  withoutCapture<T>(fn: () => T): T {
    const old = this.replaying;
    this.replaying = true;
    try {
      return fn();
    } finally {
      this.replaying = old;
    }
  }
  push(command: UndoCommand, _acknowledged = false) {
    if (this.replaying) return;
    if (this.busy) {
      this.deferred = [...this.deferred, command].slice(-50);
      return;
    }
    const last = this.past.at(-1),
      time = Date.now();
    if (
      command.mergeKey &&
      last?.mergeKey === command.mergeKey &&
      time - this.at < 750 &&
      !this.future.length
    ) {
      // Text edits share the earliest inverse and latest forward application.
      this.past[this.past.length - 1] = last.merge
        ? last.merge(command)
        : {
            ...command,
            undo: async () => {
              await command.undo();
              await last.undo();
            },
            redo: async () => {
              await last.redo();
              await command.redo();
            },
          };
    } else this.past = [...this.past, command].slice(-50);
    this.future = [];
    this.at = time;
    this.message = '';
    this.failedDirection = '';
    this.emit();
  }
  get canDiscard() {
    const stack = this.failedDirection === 'undo' ? this.past : this.future;
    return !!this.failedDirection && !!stack.at(-1)?.discard && !this.busy;
  }
  async discardFailed() {
    if (!this.canDiscard) return;
    const stack = this.failedDirection === 'undo' ? this.past : this.future,
      command = stack.at(-1)!;
    const generation = this.generation;
    this.busy = true;
    this.emit();
    try {
      await command.discard!();
      if (generation !== this.generation) return;
      stack.pop();
      this.future = [];
      this.failedDirection = '';
      this.message = '已保留当前资料，放弃本次逆向变更。';
    } catch (e) {
      this.message = '未放弃：' + String(e);
    } finally {
      this.busy = false;
      for (const item of this.deferred.splice(0)) this.push(item);
      this.emit();
    }
  }
  async run(direction: 'undo' | 'redo') {
    if (this.busy) return;
    const source = direction === 'undo' ? this.past : this.future,
      command = source.at(-1);
    if (!command) return;
    const scope = this.scope,
      generation = this.generation;
    this.busy = true;
    this.failedDirection = '';
    this.message = '正在处理' + (direction === 'undo' ? '撤销' : '重做');
    this.emit();
    try {
      await command[direction]();
      if (scope !== this.scope || generation !== this.generation) return;
      source.pop();
      (direction === 'undo' ? this.future : this.past).push(command);
      this.at = 0;
      this.message =
        (direction === 'undo' ? '撤销变更已记录：' : '重做变更已记录：') +
        command.label +
        '（保存状态见左下角）';
    } catch (e) {
      if (scope === this.scope && generation === this.generation) {
        this.failedDirection = direction;
        this.message = '未执行：' + (e instanceof Error ? e.message : String(e));
      }
    } finally {
      this.busy = false;
      this.replaying = false;
      const queued = this.deferred.splice(0);
      for (const entry of queued) this.push(entry);
      this.emit();
    }
  }
}
export const businessUndo = new UndoManager();
