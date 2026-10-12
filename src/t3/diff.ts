// Unified git diffs (from orchestration.getTurnDiff) split into files for the diff viewer.

export type DiffLineKind = "hunk" | "add" | "del" | "ctx" | "meta";
export interface DiffLine { kind: DiffLineKind; text: string }
export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  lines: DiffLine[];
}
export interface ParsedDiff {
  files: DiffFile[];
  /** Lines beyond the render budget were dropped. */
  truncated: boolean;
}

/** Enough to review a turn without freezing the panel on a vendored dependency bump. */
export const DIFF_LINE_BUDGET = 4000;

export function parseDiff(diff: string, budget = DIFF_LINE_BUDGET): ParsedDiff {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let rendered = 0;
  let truncated = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      file = { path: match?.[2] ?? raw.slice(11), additions: 0, deletions: 0, binary: false, lines: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+++ ")) { if (raw !== "+++ /dev/null") file.path = raw.replace(/^\+\+\+ (b\/)?/, ""); continue; }
    if (raw.startsWith("--- ") || raw.startsWith("index ") || /^(new|deleted) file mode|^(old|new) mode|^similarity index|^rename (from|to)/.test(raw)) continue;
    if (raw.startsWith("Binary files ")) { file.binary = true; continue; }
    let kind: DiffLineKind;
    if (raw.startsWith("@@")) kind = "hunk";
    else if (raw.startsWith("+")) { kind = "add"; file.additions++; }
    else if (raw.startsWith("-")) { kind = "del"; file.deletions++; }
    else if (raw.startsWith("\\")) kind = "meta";
    else if (raw.startsWith(" ")) kind = "ctx";
    else continue;
    if (rendered >= budget) { truncated = true; continue; }
    file.lines.push({ kind, text: kind === "hunk" || kind === "meta" ? raw : raw.slice(1) });
    rendered++;
  }
  return { files, truncated };
}
