import { useState } from "react";
import type { AddEnvRequest, EnvSummary, ImportDesktopResponse } from "../../shared/api";
import { sfx } from "../game/sfx";
import { useGame } from "../store";
import { fetchJson, refreshEnvironments } from "../t3/environment";
import { timeAgo } from "./util";

export function EnvManager() {
  const envs = useGame((s) => s.envs);
  const [mode, setMode] = useState<"ssh" | "link" | "hermes">("ssh");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [sshTarget, setSshTarget] = useState("");
  const [sshPort, setSshPort] = useState("");
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
        body: JSON.stringify(
          (mode === "hermes"
            ? { hermes: { workspaceRoot }, label: label || undefined }
            : mode === "ssh"
            ? { ssh: { target: sshTarget, ...(sshPort ? { port: Number(sshPort) } : {}) }, label: label || undefined }
            : { url, credential, label: label || undefined }) satisfies AddEnvRequest,
        ),
      });
      sfx.recruit();
      setCredential("");
      setSshTarget("");
      setSshPort("");
      setLabel("");
      await refreshEnvironments();
    } catch (err) {
      sfx.error();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const [imported, setImported] = useState<string>();
  const importDesktop = async () => {
    setBusy(true);
    setError(undefined);
    setImported(undefined);
    try {
      const result = await fetchJson<ImportDesktopResponse>("/api/envs/import-desktop", { method: "POST" });
      sfx.recruit();
      setImported(
        [
          result.linked.length ? `Linked: ${result.linked.join(", ")}` : "No new connections to link.",
          result.skipped.length ? `Skipped: ${result.skipped.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      await refreshEnvironments();
    } catch (err) {
      sfx.error();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (env: EnvSummary) => {
    const message = env.kind === "hermes"
      ? `Remove "${env.label}"?\n\nThis stops its Hermes sessions and removes their T3 Command transcripts. Hermes keeps its own saved sessions.`
      : env.linked
      ? `Unlink "${env.label}" from t3-command?\n\nT3 desktop keeps its connection; you can link it again with "Import from T3 desktop".`
      : `Remove "${env.label}" from t3-command?\n\nThis forgets its token here. To fully revoke access, also remove "t3-command" under Settings → Connections in that T3.`;
    if (!confirm(message)) return;
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

        {list.length === 0 && <p className="muted">No bases yet. Connect a T3 environment or local Hermes workspace below.</p>}
        <ul className="env-list">
          {list.map((env) => (
            <li key={env.summary.id}>
              <span className={`base-chip conn-${env.connection}`}>●</span>
              <div className="env-info">
                <strong>{env.summary.label}</strong>{" "}
                {env.summary.kind === "hermes" && <span className="linked-badge">Hermes · local</span>}{" "}
                {env.summary.linked && (
                  <span className="linked-badge" title="Uses T3 desktop's saved connection on the t3-command host">
                    linked
                  </span>
                )}{" "}
                <span className="muted small">{env.summary.url}</span>
                <div className="muted small">
                  {env.connection}
                  {env.error ? ` — ${env.error}` : ""}
                  {env.summary.serverVersion ? env.summary.kind === "hermes" ? ` · Hermes ${env.summary.serverVersion}` : ` · T3 ${env.summary.serverVersion} (protocol v${env.summary.protocolVersion})` : ""}
                  {env.summary.tokenExpiresAt ? ` · token expires ${new Date(env.summary.tokenExpiresAt).toLocaleDateString()}` : ""}
                  {` · added ${timeAgo(env.summary.addedAt)}`}
                </div>
              </div>
              <button className="btn danger" onClick={() => void remove(env.summary)}>
                {env.summary.linked ? "Unlink" : "Remove"}
              </button>
            </li>
          ))}
        </ul>

        <h3>Import from T3 desktop</h3>
        <p className="muted small">
          Link every connection T3 desktop has saved on the t3-command host. t3-command uses T3 desktop's own logins, read from its encrypted storage when
          needed and never copied, so re-pairing or removing a connection in T3 desktop carries over automatically.
        </p>
        <button className="btn primary" disabled={busy} onClick={() => void importDesktop()}>
          {busy ? "Working…" : "⇩ Import from T3 desktop"}
        </button>
        {imported && <p className="small">{imported}</p>}

        <h3>Connect a base</h3>
        <div className="tabs">
          <button className={`tab ${mode === "ssh" ? "active" : ""}`} onClick={() => setMode("ssh")}>
            SSH host
          </button>
          <button className={`tab ${mode === "link" ? "active" : ""}`} onClick={() => setMode("link")}>
            Pairing link
          </button>
          <button className={`tab ${mode === "hermes" ? "active" : ""}`} onClick={() => setMode("hermes")}>
            Local Hermes
          </button>
        </div>
        {mode === "ssh" ? (
          <>
            <ol className="muted small steps">
              <li>Use the same host you connected to from T3 desktop (it must have connected at least once, so T3 is installed there).</li>
              <li>
                The t3-command host needs working key-based SSH to it (no password prompts). t3-command finds the T3 server, opens its own tunnel, and
                pairs automatically.
              </li>
            </ol>
            <div className="form-grid">
              <label>
                SSH destination
                <input value={sshTarget} onChange={(e) => setSshTarget(e.target.value)} placeholder="user@host or an ~/.ssh/config alias" />
              </label>
              <label>
                SSH port <span className="muted">(optional)</span>
                <input value={sshPort} onChange={(e) => setSshPort(e.target.value.replace(/D/g, ""))} placeholder="22" inputMode="numeric" />
              </label>
              <label>
                Name (optional)
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Workstation" />
              </label>
            </div>
          </>
        ) : mode === "hermes" ? (
          <>
            <p className="muted small">
              Use Hermes installed on the T3 Command host. Run <code>hermes setup</code> and <code>hermes acp --check</code> there first.
              Each recruited worker gets a local session using Hermes’s configured model, tools, and memory. Sessions keep running when you close the browser.
            </p>
            <div className="form-grid">
              <label>
                Workspace directory on this host
                <input value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} placeholder="/absolute/path/to/project" />
              </label>
              <label>
                Name (optional)
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Hermes workstation" />
              </label>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy || (mode === "hermes" ? !workspaceRoot.trim() : mode === "ssh" ? !sshTarget.trim() : !credential)} onClick={() => void add()}>
          {busy ? (mode === "hermes" ? "Checking Hermes…" : mode === "ssh" ? "Connecting over SSH…" : "Pairing…") : mode === "hermes" ? "Connect Hermes" : "Pair base"}
        </button>
      </div>
    </div>
  );
}
