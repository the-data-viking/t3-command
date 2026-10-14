// Unsent text survives reloads, crashes and new releases: every message box keeps its draft in
// this browser's storage as you type, and clears it once the message is sent.

import { useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "t3c:draft:";
/** Drafts nobody came back to are dropped after this long. */
const MAX_AGE_MS = 14 * 86_400_000;

interface Stored { text: string; at: number }

export function readDraft(key: string): string {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return "";
    const d = JSON.parse(raw) as Stored;
    return typeof d.text === "string" && Date.now() - d.at < MAX_AGE_MS ? d.text : "";
  } catch {
    return "";
  }
}

export function writeDraft(key: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(PREFIX + key, JSON.stringify({ text, at: Date.now() } satisfies Stored));
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // Storage full or blocked: the draft just won't outlive the page.
  }
}

/** Drop drafts past their age, once per page load. */
export function pruneDrafts(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        const d = JSON.parse(localStorage.getItem(k) ?? "") as Stored;
        if (!(Date.now() - d.at < MAX_AGE_MS)) localStorage.removeItem(k);
      } catch { localStorage.removeItem(k); }
    }
  } catch { /* Per-browser convenience only. */ }
}

/**
 * State for a message box that persists as a draft under `key` (e.g. "order:env:thread"). The
 * setter saves as you type; `clear` empties the box and forgets the draft (call it after sending).
 */
export function useDraft(key: string): [string, (text: string) => void, () => void] {
  const [text, setText] = useState(() => readDraft(key));
  const current = useRef(key);
  useEffect(() => {
    if (current.current === key) return;
    current.current = key;
    setText(readDraft(key));
  }, [key]);
  const set = useCallback((next: string) => { setText(next); writeDraft(key, next); }, [key]);
  const clear = useCallback(() => { setText(""); writeDraft(key, ""); }, [key]);
  return [text, set, clear];
}
