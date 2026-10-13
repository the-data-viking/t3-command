// Whole-host CPU and RAM history recorded by the Command server.

export interface HostPoint {
  at: number;
  /** Average CPU utilization (0–1) over the point's span, if reported. */
  cpu: number | null;
  /** Highest single CPU sample in the span. */
  cpuPeak: number | null;
  /** Average RAM used (0–1). */
  mem: number | null;
}

export interface HostHistory {
  envId: string;
  from: number;
  to: number;
  points: HostPoint[];
}

export const HOST_RANGES = [{ hours: 1, label: "1h" }, { hours: 24, label: "24h" }, { hours: 168, label: "7d" }] as const;
