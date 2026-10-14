import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** How far a card must travel to count as a swipe. */
const THRESHOLD = 90;

/**
 * A horizontal swipe on a card: it follows the finger, and past the threshold calls `left` or
 * `right` (either may be absent, and then the card springs back). Touch and pen only; a mouse
 * drag never swipes. Vertical scrolling inside the card is left alone.
 */
export function useSwipe(enabled: boolean, left?: () => void, right?: () => void) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number; horizontal?: boolean }>(undefined);
  const reset = () => { start.current = undefined; setDx(0); };
  const handlers = enabled ? {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === "mouse") return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      const mx = e.clientX - s.x, my = e.clientY - s.y;
      if (s.horizontal === undefined && Math.hypot(mx, my) > 10) s.horizontal = Math.abs(mx) > Math.abs(my) * 1.5;
      if (!s.horizontal) return;
      // Resist the direction that does nothing.
      setDx((mx < 0 && !left) || (mx > 0 && !right) ? mx / 4 : mx);
    },
    onPointerUp: () => {
      const d = dx;
      reset();
      if (d <= -THRESHOLD && left) left();
      else if (d >= THRESHOLD && right) right();
    },
    onPointerCancel: reset,
  } : {};
  const style = dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.5, 1 - Math.abs(dx) / 400), transition: "none" } : undefined;
  /** -1 or 1 once the swipe will fire, for a hint under the finger; 0 otherwise. */
  const armed = dx <= -THRESHOLD && left ? -1 : dx >= THRESHOLD && right ? 1 : 0;
  return { handlers, style, armed, dx };
}
