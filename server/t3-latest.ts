// The newest T3 release on npm (the `t3` package), for offering remote updates to machines.
// Fetched on demand and cached for an hour; a failed check keeps the last answer.

import type { T3Latest } from "../shared/api.ts";

const TTL_MS = 60 * 60_000;
const TIMEOUT_MS = 8_000;
const EXACT = /^\d+\.\d+\.\d+$/;

export class T3LatestVersion {
  private cached: T3Latest = { version: null, checkedAt: 0 };
  /** When to look again: never-checked looks now. */
  private nextCheck = -Infinity;
  private inFlight?: Promise<T3Latest>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async get(): Promise<T3Latest> {
    if (this.now() < this.nextCheck) return this.cached;
    this.inFlight ??= this.check().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async check(): Promise<T3Latest> {
    try {
      const res = await this.fetchImpl("https://registry.npmjs.org/t3/latest", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`npm returned ${res.status}`);
      const version = ((await res.json()) as { version?: unknown }).version;
      // Only exact releases: T3's self-update refuses dist-tags and ranges.
      if (typeof version !== "string" || !EXACT.test(version)) throw new Error("npm returned no exact version");
      this.cached = { version, checkedAt: this.now() };
      this.nextCheck = this.now() + TTL_MS;
    } catch (err) {
      console.warn("[t3-latest] check failed", (err as Error).message);
      // Keep the last good version, but try again sooner than the full TTL.
      this.nextCheck = this.now() + 5 * 60_000;
    }
    return this.cached;
  }
}
