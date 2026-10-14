// Keeps T3's open pull requests honest. T3 refreshes a PR's state on the agent's own machine, and
// one whose GitHub login can't read the PR (a fine-grained token can't read checks) never does: a
// PR merged days ago stays "open" on the map. The Command server re-reads every PR its machines'
// snapshots still call open, through its own host's GitHub login, and tells every browser.

import { prKey, prStateOf, type PrStates } from "../shared/pr-states.ts";
import type { ThreadShell } from "../src/t3/types.ts";
import type { PrDetails } from "./pr-detail.ts";

/** How often each still-open PR is read again. */
export const PR_RECHECK_MS = 5 * 60_000;
/** Reads at once, and per pass: the fleet's PRs are read gradually, not in a burst. */
const CONCURRENCY = 2;
const PER_PASS = 20;

export class PrStatesWatcher {
  private readonly details: PrDetails;
  /** PRs each machine's snapshot calls open: key → repo and number. */
  private open = new Map<string, Map<string, { repo: string; number: number }>>();
  private states: PrStates = {};
  private reading = false;
  private listeners = new Set<(states: PrStates) => void>();

  constructor(details: PrDetails) {
    this.details = details;
  }

  all(): PrStates {
    return this.states;
  }

  subscribe(listener: (states: PrStates) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A machine's latest threads: which GitHub PRs it still calls open. */
  observe(envId: string, threads: ThreadShell[]): void {
    const open = new Map<string, { repo: string; number: number }>();
    for (const t of threads) {
      if (t.archivedAt) continue;
      for (const pr of t.pullRequests ?? []) {
        if (pr.snapshot?.state !== "open" || (pr.host && pr.host !== "github.com")) continue;
        open.set(prKey(pr.repository, pr.number), { repo: pr.repository, number: pr.number });
      }
    }
    this.open.set(envId, open);
  }

  forget(envId: string): void {
    this.open.delete(envId);
  }

  /** Read the PRs that are due (never read, or not for PR_RECHECK_MS), a few at a time. */
  async tick(now = Date.now()): Promise<void> {
    if (this.reading) return;
    const wanted = new Map<string, { repo: string; number: number }>();
    for (const open of this.open.values()) for (const [key, pr] of open) wanted.set(key, pr);
    const due = [...wanted].filter(([key]) => !this.states[key] || now - this.states[key].at >= PR_RECHECK_MS).slice(0, PER_PASS);
    // What no machine calls open any more needs no correcting.
    let changed = false;
    for (const key of Object.keys(this.states)) if (!wanted.has(key)) { delete this.states[key]; changed = true; }
    if (!due.length) { if (changed) this.changed(); return; }
    this.reading = true;
    try {
      const queue = [...due];
      const next = async (): Promise<void> => {
        const item = queue.shift();
        if (!item) return;
        const [key, { repo, number }] = item;
        try {
          const before = this.states[key];
          const state = prStateOf(await this.details.get(repo, number, now), now);
          this.states[key] = state;
          if (!before || before.state !== state.state || before.checksState !== state.checksState || before.isDraft !== state.isDraft) changed = true;
        } catch { /* Unreadable here too (no gh, no access): T3's snapshot stands. */ }
        return next();
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, next));
    } finally {
      this.reading = false;
    }
    if (changed) this.changed();
  }

  private changed(): void {
    this.states = { ...this.states };
    for (const listener of this.listeners) listener(this.states);
  }
}
