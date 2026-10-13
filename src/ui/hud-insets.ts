// How much of the map the HUD covers on each side, measured from the DOM, so the camera frames
// things in the part of the map you can actually see (not under the roster, a panel or the top bar).

import { isPhone } from "./phone";

export interface Insets { top: number; right: number; bottom: number; left: number }

const visible = (el: Element | null): DOMRect | undefined => {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : undefined;
};

export function hudInsets(): Insets {
  if (typeof document === "undefined") return { top: 64, right: 0, bottom: 0, left: 0 };
  const width = window.innerWidth;
  const top = (visible(document.querySelector(".topbar"))?.bottom ?? 56) + 8;
  if (isPhone()) {
    // Panels cover the whole map on phones; only the bar and the crew dock frame it.
    const dock = visible(document.querySelector(".crew-roster"));
    return { top, right: 0, left: 0, bottom: dock ? window.innerHeight - dock.top : 56 };
  }
  const roster = visible(document.querySelector(".crew-roster:not(.collapsed)"));
  const panel = visible(document.querySelector(".panel"));
  return {
    top,
    left: roster ? roster.right + 8 : 0,
    right: panel ? width - panel.left + 8 : 0,
    bottom: 30, // The hint bar.
  };
}
