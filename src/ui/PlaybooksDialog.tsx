import { useState } from "react";
import { PLAYBOOK_NAME, type Playbook } from "../../shared/playbooks";
import { useGame } from "../store";
import { logError } from "../t3/environment";
import { savePlaybooks } from "../t3/playbooks";

/** Saved orders: name, text, add and remove. Shared by every device through the Command server. */
export function PlaybooksDialog() {
  const [books, setBooks] = useState<Playbook[]>(() => useGame.getState().playbooks.map((p) => ({ ...p })));
  const [saving, setSaving] = useState(false);
  const close = () => useGame.setState({ showPlaybooks: false });
  const set = (i: number, change: Partial<Playbook>) => setBooks((b) => b.map((p, k) => (k === i ? { ...p, ...change } : p)));
  const invalid = books.some((p) => !PLAYBOOK_NAME.test(p.name) || !p.text.trim()) || new Set(books.map((p) => p.name)).size !== books.length;

  const save = async () => {
    setSaving(true);
    try { await savePlaybooks(books); close(); } catch (err) { logError("Couldn't save the saved orders", err); setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal playbooks-modal" role="dialog" aria-label="Saved orders" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>Saved orders</h2><span className="spacer" />
          <button className="icon-btn" aria-label="Close" onClick={close}>✕</button>
        </header>
        <p className="muted small">Type <strong>/name</strong> at the start of any order box (or a squad order) to use one. Shared by every device.</p>
        <ol className="playbooks">
          {books.map((p, i) => (
            <li key={i}>
              <label className="playbook-name">/<input value={p.name} aria-label="Name" onChange={(e) => set(i, { name: e.target.value.toLowerCase() })} aria-invalid={!PLAYBOOK_NAME.test(p.name)} /></label>
              <textarea value={p.text} rows={3} aria-label={`Text of /${p.name}`} onChange={(e) => set(i, { text: e.target.value })} />
              <button className="icon-btn" aria-label={`Remove /${p.name}`} onClick={() => setBooks((b) => b.filter((_, k) => k !== i))}>✕</button>
            </li>
          ))}
        </ol>
        <div className="playbooks-actions">
          <button className="btn" onClick={() => setBooks((b) => [...b, { name: `order-${b.length + 1}`, text: "" }])}>Add</button>
          <span className="spacer" />
          {invalid && <span className="small orange">Names are lowercase letters, digits and dashes, unique; texts can't be empty.</span>}
          <button className="btn primary" disabled={invalid || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
