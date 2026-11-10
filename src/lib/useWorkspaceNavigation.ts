import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  sameWorkspaceRoute,
  workspaceHref,
  workspaceRoute,
  type WorkspaceRoute,
} from './workspace-navigation';

type Entry = { index: number; scroll: number };
const entry = (): Entry =>
  window.history.state?.chunmoWorkspace || { index: 0, scroll: window.scrollY };
export function useWorkspaceNavigation(
  enabled: boolean,
  canLeave: (resume: () => void) => boolean,
  onApply: (route: WorkspaceRoute) => void,
) {
  const [route, setRoute] = useState(() => workspaceRoute(new URL(location.href)));
  const current = useRef({ route, entry: entry() });
  const callbacks = useRef({ canLeave, onApply });
  callbacks.current = { canLeave, onApply };
  const scroll = useRef<number | null>(null);
  const positions = useRef(new Map<number, number>());
  const apply = (next: WorkspaceRoute, nextEntry: Entry) => {
    current.current = { route: next, entry: nextEntry };
    scroll.current = positions.current.get(nextEntry.index) ?? nextEntry.scroll;
    callbacks.current.onApply(next);
    setRoute(next);
  };
  const rememberScroll = () => {
    const e = { ...current.current.entry, scroll: window.scrollY };
    current.current.entry = e;
    positions.current.set(e.index, e.scroll);
    history.replaceState({ ...history.state, chunmoWorkspace: e }, '');
  };
  const rollback = useRef<{ target: number; delta: number; resume: boolean } | null>(null);
  const approved = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    history.replaceState({ ...history.state, chunmoWorkspace: current.current.entry }, '');
    const restoreMode = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    const pop = () => {
      const targetEntry = entry();
      if (rollback.current) {
        const blocked = rollback.current;
        rollback.current = null;
        if (blocked.resume) {
          approved.current = blocked.target;
          history.go(blocked.delta);
        }
        return;
      }
      const target = workspaceRoute(new URL(location.href));
      const delta = targetEntry.index - current.current.entry.index;
      const resume = () => {
        if (rollback.current) rollback.current.resume = true;
        else {
          approved.current = targetEntry.index;
          history.go(delta);
        }
      };
      const accepted = approved.current === targetEntry.index;
      approved.current = null;
      if (!accepted && !callbacks.current.canLeave(resume)) {
        rollback.current = { target: targetEntry.index, delta, resume: false };
        history.go(-delta || 1);
        return;
      }
      apply(target, targetEntry);
    };
    const moved = () => {
      current.current.entry.scroll = window.scrollY;
      positions.current.set(current.current.entry.index, window.scrollY);
    };
    // Save each entry's position before browser Back/Forward changes the active entry.
    const save = () => rememberScroll();
    window.addEventListener('popstate', pop);
    window.addEventListener('scroll', moved, { passive: true });
    window.addEventListener('pagehide', save);
    return () => {
      history.scrollRestoration = restoreMode;
      window.removeEventListener('popstate', pop);
      window.removeEventListener('scroll', moved);
      window.removeEventListener('pagehide', save);
    };
  }, [enabled]);
  useLayoutEffect(() => {
    if (scroll.current !== null) {
      window.scrollTo(0, scroll.current);
      scroll.current = null;
    }
  }, [route]);
  function navigate(next: WorkspaceRoute, options: { replace?: boolean; guard?: boolean } = {}) {
    if (sameWorkspaceRoute(next, current.current.route)) return;
    const run = () => {
      const targetEntry = {
        index: current.current.entry.index + (options.replace ? 0 : 1),
        scroll: window.scrollY,
      };
      positions.current.set(targetEntry.index, targetEntry.scroll);
      if (enabled) {
        rememberScroll();
        const state = { ...history.state, chunmoWorkspace: targetEntry };
        const href = workspaceHref(next, new URL(location.href));
        if (options.replace) history.replaceState(state, '', href);
        else history.pushState(state, '', href);
      }
      apply(next, targetEntry);
    };
    if (options.guard === false || callbacks.current.canLeave(run)) run();
  }
  return { route, navigate };
}
