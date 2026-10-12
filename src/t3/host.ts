import { GAUGE, loadLevel } from "../game/theme";

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

// Host load uses the gauge ramp, never the approval/question status colors.
const utilizationColor = (fraction: number | undefined) => fraction === undefined ? GAUGE.unknown : GAUGE[loadLevel(fraction)];

export function hostView(state: HostState | undefined, connection: string, now = Date.now()) {
  const s = state?.snapshot;
  const stale = !!s && (connection !== "live" || !!state?.error || now - s.sampledAt > 35_000);
  const cpu = s?.cpuUtilization;
  const cpuFraction = typeof cpu === "number" && Number.isFinite(cpu) && cpu >= 0 && cpu <= 1 ? cpu : undefined;
  const memoryFraction = s && Number.isFinite(s.totalMemoryBytes) && Number.isFinite(s.availableMemoryBytes) && s.totalMemoryBytes > 0 && s.availableMemoryBytes >= 0 && s.availableMemoryBytes <= s.totalMemoryBytes
    ? (s.totalMemoryBytes - s.availableMemoryBytes) / s.totalMemoryBytes : undefined;
  return { snapshot: s, stale, cpuFraction, memoryFraction,
    cpuColor: utilizationColor(cpuFraction), memoryColor: utilizationColor(memoryFraction) };
}

export const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
