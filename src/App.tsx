import { useEffect, useState } from "react";
import type { MeResponse } from "../shared/api";
import { sfx } from "./game/sfx";
import { installActiveWatches } from "./game/watch";
import { addLog, useGame } from "./store";
import { fetchJson, onUnitTransition, refreshEnvironments } from "./t3/environment";
import { BuildingPanel } from "./ui/BuildingPanel";
import { EnvManager } from "./ui/EnvManager";
import { EventLog } from "./ui/EventLog";
import { LibraryPanel } from "./ui/LibraryPanel";
import { installHotkeys } from "./ui/hotkeys";
import { MapView } from "./ui/MapView";
import { Minimap } from "./ui/Minimap";
import { NeedsYou } from "./ui/NeedsYou";
import { TopBar } from "./ui/TopBar";
import { UnitPanel } from "./ui/UnitPanel";

const ENV_REFRESH_MS = 30_000;

/** Turn unit state changes into sound effects and event-log lines. */
function announceTransitions(): () => void {
  return onUnitTransition(({ envId, thread, from, to }) => {
    const name = `"${thread.title || "Untitled"}"`;
    const at = { envId, threadId: thread.id };
    if (to === "alert") {
      sfx.alert();
      addLog({ tone: "alert", text: `${name} needs your approval`, ...at });
    } else if (to === "question") {
      sfx.alert();
      addLog({ tone: "alert", text: `${name} has a question`, ...at });
    } else if (to === "error") {
      sfx.error();
      addLog({ tone: "bad", text: `${name} was hurt — the turn failed`, ...at });
    } else if (to === "done" && from === "working") {
      sfx.done();
      addLog({ tone: "good", text: `Job's done: ${name}`, ...at });
    } else if (to === "working" && from !== "alert" && from !== "question") {
      addLog({ tone: "info", text: `${name} got to work`, ...at });
    }
  });
}

export default function App() {
  const selection = useGame((s) => s.selection);
  const showEnvManager = useGame((s) => s.showEnvManager);
  const [fatal, setFatal] = useState<string>();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        const me = await fetchJson<MeResponse>("/api/me");
        useGame.setState({ me });
        await refreshEnvironments();
        if (Object.keys(useGame.getState().envs).length === 0) useGame.setState({ showEnvManager: true });
        timer = setInterval(() => void refreshEnvironments().catch(() => {}), ENV_REFRESH_MS);
      } catch (err) {
        setFatal((err as Error).message);
      }
    })();
    const offHotkeys = installHotkeys();
    const offTransitions = announceTransitions();
    const offWatches = installActiveWatches();
    return () => {
      clearInterval(timer);
      offHotkeys();
      offTransitions();
      offWatches();
    };
  }, []);

  if (fatal) {
    return (
      <div className="fatal">
        <h1>T3 COMMAND</h1>
        <p>Can't reach the t3-command server: {fatal}</p>
      </div>
    );
  }

  return (
    <div className="game">
      <MapView />
      <TopBar />
      <NeedsYou />
      <Minimap />
      <EventLog />
      {selection?.kind === "unit" && <UnitPanel key={`${selection.envId}:${selection.threadId}`} envId={selection.envId} threadId={selection.threadId} />}
      {selection?.kind === "library" && <LibraryPanel key={`lib:${selection.envId}:${selection.projectId}`} envId={selection.envId} projectId={selection.projectId} />}
      {selection?.kind === "building" && <BuildingPanel key={`${selection.envId}:${selection.projectId}`} envId={selection.envId} projectId={selection.projectId} />}
      <div className="hint">DRAG pan · SCROLL zoom · SPACE next alert · . next report · W next active · F fit fleet</div>
      {showEnvManager && <EnvManager />}
    </div>
  );
}
