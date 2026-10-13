// Disk usage per machine, collected by the Command server: free space on the disks holding each
// machine's checkouts, and how much T3 worktrees take up.

export interface DiskVolume {
  /** Mount point (POSIX) or drive letter (Windows). */
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface WorktreeUsage {
  measuredAt: number;
  totalBytes: number;
  /** Each T3 worktree (~/.t3/worktrees/<project>/<worktree>), largest first. */
  entries: Array<{ path: string; project: string; bytes: number }>;
  /** T3's scratch folder for threads without a project (~/.t3/scratch), when it exists. */
  scratchBytes?: number;
}

export interface StorageReading {
  sampledAt: number;
  volumes: DiskVolume[];
  worktrees?: WorktreeUsage;
  error?: string;
}

export interface StorageView {
  envId: string;
  latest?: StorageReading;
  /** Fullest volume's used fraction over time, oldest first (one point per sample). */
  trend: Array<{ at: number; usedFraction: number }>;
}

export const BEGIN = "__T3C_BEGIN__";
export const WORKTREES = "__T3C_WT__";
export const END = "__T3C_END__";

/**
 * Low space is about what's left, not a percentage alone: a 2 TB disk at 92% still has room,
 * a 120 GB disk at 92% has days. Critical below 5 GB or 3%; low below 15 GB or 10%.
 */
export function diskLevel(volume: DiskVolume): "ok" | "high" | "critical" {
  const gb = volume.availableBytes / 1024 ** 3;
  const free = volume.totalBytes > 0 ? volume.availableBytes / volume.totalBytes : 1;
  if (gb < 5 || free < 0.03) return "critical";
  if (gb < 15 || free < 0.1) return "high";
  return "ok";
}

/** The volume closest to running out, which is the one worth showing. */
export function tightestVolume(volumes: DiskVolume[]): DiskVolume | undefined {
  return [...volumes].sort((a, b) => a.availableBytes / Math.max(1, a.totalBytes) - b.availableBytes / Math.max(1, b.totalBytes) || a.availableBytes - b.availableBytes)[0];
}

/** Shell-quoted for POSIX sh. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Quoted for PowerShell single-quoted strings. */
const pq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** One line of shell to run in a remote terminal; markers delimit the output to parse. */
export function storageCommand(paths: string[], withWorktrees: boolean, windows: boolean): string {
  if (windows) {
    const drives = `foreach ($p in @(${paths.map(pq).join(",")})) { $d = (Get-Item -LiteralPath $p -ErrorAction SilentlyContinue).PSDrive; if ($d) { Write-Output ("PSDRIVE {0} {1} {2}" -f $d.Name, [int64]$d.Used, [int64]$d.Free) } }`;
    const worktrees = withWorktrees
      ? `@(Get-ChildItem -Directory -LiteralPath "$env:USERPROFILE\\.t3\\worktrees" -ErrorAction SilentlyContinue | Get-ChildItem -Directory -ErrorAction SilentlyContinue) + @(Get-Item -LiteralPath "$env:USERPROFILE\\.t3\\scratch" -ErrorAction SilentlyContinue) | ForEach-Object { $s = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; Write-Output ("WT {0} {1}" -f [int64]$s, $_.FullName) }; `
      : "";
    return `Write-Output '${BEGIN}'; ${drives}; Write-Output '${WORKTREES}'; ${worktrees}Write-Output '${END}'`;
  }
  const worktrees = withWorktrees ? `nice -n 19 du -sk "$HOME"/.t3/worktrees/*/* "$HOME"/.t3/scratch 2>/dev/null; ` : "";
  return `printf '%s\\n' ${BEGIN}; df -Pk ${paths.map(sq).join(" ")} 2>/dev/null; printf '%s\\n' ${WORKTREES}; ${worktrees}printf '%s\\n' ${END}`;
}

/**
 * Terminal output as plain lines. Windows' ConPTY may repaint with cursor moves instead of
 * newlines, so a cursor jump to a row (`ESC[r;cH`, `ESC[nE`) starts a new line.
 */
export function terminalLines(raw: string): string[] {
  /* eslint-disable no-control-regex -- terminal escape codes are what's being stripped */
  return raw
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*[HfE]/g, "\n")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\r/g, "").trim());
  /* eslint-enable no-control-regex */
}

/** Whether a storage command has finished printing. */
export const storageDone = (raw: string) => terminalLines(raw).includes(END);

/** Parse what a storage command printed (terminal echo, prompts and ANSI codes included). */
export function parseStorageOutput(raw: string, now: number, withWorktrees: boolean): StorageReading | undefined {
  const lines = terminalLines(raw);
  const begin = lines.lastIndexOf(BEGIN);
  const end = lines.lastIndexOf(END);
  if (begin < 0 || end < begin) return undefined;
  const body = lines.slice(begin + 1, end);
  const split = body.indexOf(WORKTREES);
  const diskLines = split < 0 ? body : body.slice(0, split);
  const worktreeLines = split < 0 ? [] : body.slice(split + 1);
  const volumes = new Map<string, DiskVolume>();
  for (const line of diskLines) {
    const ps = /^PSDRIVE (\S+) (\d+) (\d+)$/.exec(line);
    if (ps) {
      const used = Number(ps[2]), free = Number(ps[3]);
      volumes.set(`${ps[1]}:`, { mount: `${ps[1]}:`, totalBytes: used + free, usedBytes: used, availableBytes: free });
      continue;
    }
    // POSIX df -Pk: Filesystem 1024-blocks Used Available Capacity Mounted-on (mount may contain spaces).
    const df = /^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line);
    if (df) volumes.set(df[4], { mount: df[4], totalBytes: Number(df[1]) * 1024, usedBytes: Number(df[2]) * 1024, availableBytes: Number(df[3]) * 1024 });
  }
  const entries: Array<{ path: string; project: string; bytes: number }> = [];
  let scratchBytes: number | undefined;
  const entry = (raw: string, bytes: number) => {
    const p = raw.replace(/[\\/]+$/, "");
    const parts = p.split(/[\\/]/);
    // Worktrees are two levels into ~/.t3/worktrees, so ~/.t3/scratch can't be mistaken for one.
    if (parts.at(-1) === "scratch" && parts.at(-2) === ".t3") scratchBytes = (scratchBytes ?? 0) + bytes;
    else entries.push({ path: p, project: parts.slice(-2, -1)[0] ?? "", bytes });
  };
  for (const line of worktreeLines) {
    const wt = /^WT (\d+) (.+)$/.exec(line);
    if (wt) { entry(wt[2], Number(wt[1])); continue; }
    const du = /^(\d+)\s+(\/.+)$/.exec(line);
    if (du) entry(du[2], Number(du[1]) * 1024);
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  return {
    sampledAt: now,
    volumes: [...volumes.values()],
    ...(withWorktrees ? { worktrees: { measuredAt: now, totalBytes: entries.reduce((n, p) => n + p.bytes, 0), entries, ...(scratchBytes === undefined ? {} : { scratchBytes }) } } : {}),
  };
}

export const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;
