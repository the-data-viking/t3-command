export interface HostResources {
  sampledAt: number;
  cpuUtilization: number | null;
  cpuCount: number;
  availableMemoryBytes: number;
  totalMemoryBytes: number;
}

export interface HostState {
  snapshot?: HostResources;
  error?: string;
  /** Whole-host samples observed by this browser, capped to the last 20 minutes. */
  history: HostResources[];
}

export function hostView(state: HostState | undefined, connection: string, now = Date.now()) {
  const s = state?.snapshot;
  const stale = !!s && (connection !== "live" || !!state?.error || now - s.sampledAt > 35_000);
  const cpu = s?.cpuUtilization;
  const cpuFraction = typeof cpu === "number" && Number.isFinite(cpu) && cpu >= 0 && cpu <= 1 ? cpu : undefined;
  const freeFraction = s && Number.isFinite(s.totalMemoryBytes) && Number.isFinite(s.availableMemoryBytes) && s.totalMemoryBytes > 0 && s.availableMemoryBytes >= 0 && s.availableMemoryBytes <= s.totalMemoryBytes
    ? s.availableMemoryBytes / s.totalMemoryBytes : undefined;
  return { snapshot: s, stale, cpuFraction, freeFraction,
    cpuColor: cpuFraction === undefined ? 0x59626c : cpuFraction >= 0.95 ? 0xff4655 : cpuFraction >= 0.85 ? 0xffd23f : 0x59e1ff,
    memoryColor: freeFraction === undefined ? 0x59626c : freeFraction <= 0.1 ? 0xff4655 : freeFraction <= 0.2 ? 0xffd23f : 0x6fe37a };
}

export const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
