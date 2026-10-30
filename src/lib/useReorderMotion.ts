import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Animate only a committed reorder; cancelling a drag never mutates persisted order. */
export function useReorderMotion(
  root: RefObject<HTMLElement | null>,
  selector: string,
  order: string,
) {
  const positions = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const next = new Map<string, { x: number; y: number }>();
    root.current?.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const key = element.dataset.projectId ?? element.dataset.tradeId ?? element.dataset.personId!;
      const point = { x: element.offsetLeft, y: element.offsetTop };
      const previous = positions.current.get(key);
      next.set(key, point);
      if (
        previous &&
        (previous.x !== point.x || previous.y !== point.y) &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        element.animate(
          [
            { transform: `translate(${previous.x - point.x}px, ${previous.y - point.y}px)` },
            { transform: 'translate(0, 0)' },
          ],
          { duration: 180, easing: 'ease-out' },
        );
      }
    });
    positions.current = next;
  }, [root, selector, order]);
}
