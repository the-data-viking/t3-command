import { useRef } from 'react';
import { bounds, DEFAULT_WIDTH } from './usePanelWidth';

export function PanelResize({ width, setWidth }: { width: number; setWidth: (value: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const { min, max } = bounds();
  return <div
    className="panel-resize"
    role="separator"
    tabIndex={0}
    aria-label="Resize thread chat panel"
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={width}
    aria-valuetext={`${width} pixels wide`}
    title="Drag to resize. Arrow keys adjust width; double-click to reset."
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width };
    }}
    onPointerMove={event => {
      if (drag.current) setWidth(drag.current.width + drag.current.x - event.clientX);
    }}
    onPointerUp={event => {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
    onKeyDown={event => {
      const next = event.key === 'ArrowLeft' ? width + (event.shiftKey ? 80 : 20)
        : event.key === 'ArrowRight' ? width - (event.shiftKey ? 80 : 20)
        : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
      if (next === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      setWidth(next);
    }}
  ><span aria-hidden="true">⋮</span></div>;
}
