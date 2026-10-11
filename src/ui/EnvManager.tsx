import { useState } from "react";
import type { AddEnvRequest, EnvSummary } from "../../shared/api";
import { sfx } from "../game/sfx";
import { useGame } from "../store";
import { fetchJson, refreshEnvironments } from "../t3/environment";
import { timeAgo } from "./util";

export function EnvManager() {
  const envs = useGame((s) => s.envs);
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => useGame.setState({ showEnvManager: false });

  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await fetchJson<EnvSummary>("/api/envs", {
        method: "POST",
        body: JSON.stringify({ url, credential, label: label || undefined } satisfies AddEnvRequest),
      });
      sfx.recruit();
      setCredential("");
      setLabel("");
      await refreshEnvironments();
    } catch (err) {
      sfx.error();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (env: EnvSummary) => {
    if (!confirm(`Remove "${env.label}" from t3-command?\n\nThis forgets its token here. To fully revoke access, also remove "t3-command" under Settings → Connections in that T3.`)) return;
    try {
      await fetchJson(`/api/envs/${encodeURIComponent(env.id)}`, { method: "DELETE" });
      await refreshEnvironments();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const list = Object.values(envs);
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>Bases</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={close}>
            ✕
          </button>
        </header>

        {list.length === 0 && <p className="muted">No bases yet. Pair your first T3 environment below.</p>}
        <ul className="env-list">
          {list.map((env) => (
            <li key={env.summary.id}>
              <span className={`base-chip conn-${env.connection}`}>●</span>
              <div className="env-info">
                <strong>{env.summary.label}</strong> <span className="muted small">{env.summary.url}</span>
                <div className="muted small">
                  {env.connection}
                  {env.error ? ` — ${env.error}` : ""}
                  {env.summary.serverVersion ? ` · T3 ${env.summary.serverVersion} (protocol v${env.summary.protocolVersion})` : ""}
                  {env.summary.tokenExpiresAt ? ` · token expires ${new Date(env.summary.tokenExpiresAt).toLocaleDateString()}` : ""}
                  {` · added ${timeAgo(env.summary.addedAt)}`}
                </div>
              </div>
              <button className="btn danger" onClick={() => void remove(env.summary)}>
                Remove
              </button>
            </li>
          ))}
        </ul>

        <h3>Pair a base</h3>
        <ol className="muted small steps">
          <li>
            In that T3 Code, open <strong>Settings → Connections</strong> and create a pairing link. (On this machine you can also run{" "}
            <code>npm run pair:local</code>.)
          </li>
          <li>Paste the pairing link. If the t3-command host reaches that T3 at a different address (e.g. <code>http://127.0.0.1:3773</code> for its own T3), enter that too.</li>
        </ol>
        <div className="form-grid">
          <label>
            Pairing link or token
            <input value={credential} onChange={(e) => setCredential(e.target.value)} type="password" autoComplete="off" placeholder="https://…/pair#token=…" />
          </label>
          <label>
            T3 server URL <span className="muted">(optional with a link)</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://machine.tailnet.ts.net:3773" />
          </label>
          <label>
            Name (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Workstation" />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy || !credential} onClick={() => void add()}>
          {busy ? "Pairing…" : "Pair base"}
        </button>
      </div>
    </div>
  );
}
