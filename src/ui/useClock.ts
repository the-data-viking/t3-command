import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;

function refresh() {
  clearTimeout(timer);
  now = Date.now();
  for (const listener of listeners) listener();
  if (listeners.size && !document.hidden) timer = setTimeout(refresh, 10_000);
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

const noop = () => () => {};
const zero = () => 0;
export function useClock(enabled = true) {
  return useSyncExternalStore(enabled ? subscribe : noop, enabled ? () => now : zero, zero);
}
