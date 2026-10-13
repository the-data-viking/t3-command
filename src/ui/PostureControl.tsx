import { useState } from "react";
import { sfx } from "../game/sfx";
import { useGame } from "../store";
import { envClient, logError } from "../t3/environment";
import type { RuntimeMode, ThreadShell } from "../t3/types";
import { BUILD_THE_PLAN, needsConfirm, RUNTIME_MODES } from "./posture";

/**
 * A crew member's posture in its panel: what it may do without asking, and Plan (propose before
 * building). Raising it to full access asks first. Changes go to T3 and apply from the next step.
 */
export function PostureControl({ envId, thread }: { envId: string; thread: ThreadShell }) {
  const provider = useGame((s) => s.envs[envId]?.providers?.find((p) => p.instanceId === thread.modelSelection.instanceId));
  const modes = provider?.runtimeModes?.length ? provider.runtimeModes : RUNTIME_MODES;
  const [busy, setBusy] = useState(false);
  const client = envClient(envId);
  const plan = thread.interactionMode === "plan";

  const run = async (change: () => Promise<unknown>) => {
    setBusy(true);
    try { await change(); sfx.select(); } catch (err) { sfx.error(); logError("Couldn't change posture", err); } finally { setBusy(false); }
  };
  const setMode = (to: RuntimeMode) => {
    if (needsConfirm(thread.runtimeMode, to)
      && !window.confirm(`Give "${thread.title || "this crew member"}" full access? It will run any command and change any file without asking.`)) return;
    void run(() => client!.setRuntimeMode(thread.id, to));
  };

  return (
    <span className="posture">
      <select className="posture-mode" value={thread.runtimeMode} disabled={busy || !client} aria-label="Permissions" title="What this crew member may do without asking you"
        onChange={(e) => setMode(e.target.value as RuntimeMode)}>
        {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      <button className={`btn small posture-plan ${plan ? "active" : ""}`} aria-pressed={plan} disabled={busy || !client}
        title={plan ? "Plan mode: it proposes a plan and waits for your approval before building. Click to let it build." : "Have it propose a plan before building"}
        onClick={() => void run(() => client!.setInteractionMode(thread.id, plan ? "default" : "plan"))}>
        {plan ? "Planning" : "Plan first"}
      </button>
    </span>
  );
}

/** A plan-mode crew member whose turn finished has a plan for you: approve it to start building. */
export function PlanReady({ envId, thread }: { envId: string; thread: ThreadShell }) {
  const [busy, setBusy] = useState(false);
  const client = envClient(envId);
  const approve = async () => {
    setBusy(true);
    try {
      await client!.setInteractionMode(thread.id, "default");
      await client!.order(thread.id, BUILD_THE_PLAN, { interactionMode: "default" });
      sfx.order();
    } catch (err) {
      sfx.error();
      logError("Couldn't start building", err);
      setBusy(false);
    }
  };
  return (
    <div className="plan-ready" role="note">
      <span><strong>Plan ready.</strong> Read it above, then approve it to start building, or reply with changes to revise it.</span>
      <button className="btn primary" disabled={busy || !client} onClick={() => void approve()}>{busy ? "Starting…" : "Approve plan and build"}</button>
    </div>
  );
}
