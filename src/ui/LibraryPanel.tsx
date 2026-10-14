import { useMemo } from "react";
import { sfx } from "../game/sfx";
import { groupFor } from "../game/layout";
import { setSelection, useGame } from "../store";
import { isHistory } from "../t3/derive";
import type { ThreadShell } from "../t3/types";
import { timeAgo } from "./util";
import { PixelLabel } from "./PixelArt";

interface Volume {
  title: string;
  /** Imports of the same conversation, newest first. */
  copies: ThreadShell[];
}

/** The project's archive: imported CLI history that never ran as T3 turns. Read-only. */
export function LibraryPanel({ envId, projectId }: { envId: string; projectId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const project = env?.projects[projectId];

  // The station's archive holds history from every environment docked at this project.
  const envs = useGame((s) => s.envs);
  const { volumes, owners } = useMemo(() => {
    const owners = new Map<string, string>();
    if (!env) return { volumes: [] as Volume[], owners };
    const members = groupFor(useGame.getState(), envId, projectId)?.members ?? [];
    const byTitle = new Map<string, ThreadShell[]>();
    for (const m of members) {
      for (const t of Object.values(m.env.threads)) {
        if (t.projectId !== m.project.id || !isHistory(t)) continue;
        const key = (t.title || "Untitled").trim();
        byTitle.set(key, [...(byTitle.get(key) ?? []), t]);
        owners.set(t.id, m.env.summary.id);
      }
    }
    const volumes = [...byTitle.entries()]
      .map(([title, copies]) => ({ title, copies: copies.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
      .sort((a, b) => b.copies[0].updatedAt.localeCompare(a.copies[0].updatedAt));
    return { volumes, owners };
  }, [env, envId, projectId, envs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!env || !project) {
    return (
      <aside className="panel">
        <p className="muted">This archive is gone.</p>
      </aside>
    );
  }

  const total = volumes.reduce((n, v) => n + v.copies.length, 0);
  const open = (thread: ThreadShell) => {
    sfx.select();
    setSelection({ kind: "unit", envId: owners.get(thread.id) ?? envId, threadId: thread.id });
  };

  return (
    <aside className="panel library-panel">
      <header className="panel-head">
        <div className="portrait library" />
        <div className="panel-title">
          <span className="title-tab panel-kind"><PixelLabel text="Archive" /></span>
          <h2>{project.title} archive</h2>
          <div className="muted small">
            {total} imported conversation{total === 1 ? "" : "s"} · {volumes.length} unique
          </div>
          <div className="muted small">CLI session history imported into T3. It never ran as T3 turns, so it stays out of the workforce.</div>
        </div>
        <button className="icon-btn" onClick={() => setSelection(null)} title="Close (Esc)">
          ✕
        </button>
      </header>
      <div className="roster">
        {volumes.map((v) => (
          <div key={v.title} className="volume">
            <button className="roster-row" onClick={() => open(v.copies[0])} title="Read the most recent import">
              <span className="book" />
              <span className="roster-name">{v.title}</span>
              {v.copies.length > 1 && <span className="copies">×{v.copies.length}</span>}
              <span className="muted small">{timeAgo(v.copies[0].createdAt)}</span>
            </button>
            {v.copies.length > 1 && (
              <div className="copy-list">
                {v.copies.map((c, i) => (
                  <button key={c.id} className="copy-link" onClick={() => open(c)}>
                    copy {i + 1} · {timeAgo(c.createdAt)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {volumes.length === 0 && <p className="muted">Nothing archived here.</p>}
      </div>
    </aside>
  );
}
