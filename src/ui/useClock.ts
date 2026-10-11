import { useSyncExternalStore } from "react";

function clock(intervalMs: number) {
  const listeners = new Set<() => void>();
  let now = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function refresh() {
    clearTimeout(timer);
    now = Date.now();
    for (const listener of listeners) listener();
    if (listeners.size && !document.hidden) timer = setTimeout(refresh, intervalMs);
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
      document.addEventListener("visibilitychange", refresh);
      refresh();
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", refresh);
      }
    };
  }

  return { subscribe, snapshot: () => now };
}

// All crew share one second timer; resource panels retain their slower refresh.
const clocks = { 1000: clock(1000), 10000: clock(10000) };
const noop = () => () => {};
const zero = () => 0;
export function useClock(enabled = true, intervalMs: 1000 | 10000 = 10000) {
  const selected = clocks[intervalMs];
  return useSyncExternalStore(enabled ? selected.subscribe : noop, enabled ? selected.snapshot : zero, zero);
}
