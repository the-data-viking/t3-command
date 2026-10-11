import { useEffect, useState } from 'react';

const WIDTH_KEY = 't3c:thread-panel-width';
export const DEFAULT_WIDTH = 440;
export function bounds() {
  const max = Math.min(1000, window.innerWidth - 16);
  return { min: Math.min(320, max), max };
}
function clamp(value: number) {
  const { min, max } = bounds();
  return Math.max(min, Math.min(max, value));
}

export function usePanelWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return clamp(Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_WIDTH);
    } catch { return clamp(DEFAULT_WIDTH); }
  });
  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* Storage may be unavailable. */ }
  }, [width]);
  useEffect(() => {
    const resize = () => setWidth(current => clamp(current));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return { width, setWidth: (value: number) => setWidth(clamp(value)) };
}

