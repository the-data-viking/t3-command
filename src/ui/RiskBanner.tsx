import type { Risk } from "./risk";

/** The risk lens's warning over a flagged approval: how serious, and why. */
export function RiskBanner({ risk }: { risk: Risk }) {
  const danger = risk.level === "danger";
  return (
    <div className={`risk-banner risk-${risk.level}`} role="note">
      <span className="risk-mark" aria-hidden>⚠</span>
      <span>
        <strong>{danger ? "Dangerous" : "Careful"}:</strong> {risk.reasons.join(" · ")}.
        {danger && <span className="muted"> Approve each one on its own; read the command first.</span>}
      </span>
    </div>
  );
}
