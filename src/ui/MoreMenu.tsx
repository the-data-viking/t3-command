import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The top bar's less-used views (log, history, machines) behind one button on desktop, so the bar
 * holds two rows whatever the fleet's state. On phones they sit in the bar's own menu instead.
 */
export function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  return (
    <div className="theme-menu more-menu" ref={root}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} title="Log, history and machines" onClick={() => setOpen(!open)}>More ▾</button>
      {open && (
        <div className="theme-list more-list hud-frame" role="menu" onClick={(e) => { if ((e.target as HTMLElement).closest("button")) setOpen(false); }}>
          {children}
        </div>
      )}
    </div>
  );
}
