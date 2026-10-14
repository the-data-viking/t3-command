import type { ParsedDiff } from "../t3/diff";

/** A parsed unified diff as collapsible files (the first few open), shared by turn diffs and reviews. */
export function DiffFiles({ parsed, open = 3, empty = "No file changes." }: { parsed: ParsedDiff; open?: number; empty?: string }) {
  if (parsed.files.length === 0) return <p className="muted">{empty}</p>;
  return <>
    {parsed.files.map((file, index) => (
      <details key={file.path} className="diff-file" open={index < open}>
        <summary><span className="file-path">{file.path}</span> <span className="diff-add">+{file.additions}</span> <span className="diff-del">−{file.deletions}</span></summary>
        {file.binary ? <p className="muted small">Binary file</p> : (
          <pre className="diff-body">{file.lines.map((line, i) => (
            <span key={i} className={`diff-line diff-${line.kind}`}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "ctx" ? " " : ""}{line.text}{"\n"}</span>
          ))}</pre>
        )}
      </details>
    ))}
    {parsed.truncated && <p className="muted small">Long diff: only the first lines are shown.</p>}
  </>;
}
