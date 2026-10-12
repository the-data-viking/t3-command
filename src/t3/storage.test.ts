import assert from "node:assert/strict";
import test from "node:test";
import { announceStorage, freeLabel, storageSummary } from "./storage";
import { useGame } from "../store";
import { GAUGE } from "../game/theme";
import type { StorageView } from "../../shared/storage";

const GB = 1024 ** 3;
const view = (availableGb: number, sampledAt = 1_000, totalGb = 120): StorageView => ({
  envId: "e1",
  latest: { sampledAt, volumes: [{ mount: "/", totalBytes: totalGb * GB, usedBytes: (totalGb - availableGb) * GB, availableBytes: availableGb * GB }] },
  trend: [],
});

test("the summary judges the fullest volume and greys out stale readings", () => {
  const s = storageSummary(view(2.2), 2_000);
  assert.equal(s.level, "critical");
  assert.equal(s.color, GAUGE.critical);
  assert.ok(Math.abs(s.usedFraction! - (1 - 2.2 / 120)) < 1e-9);
  const old = storageSummary(view(2.2), 1_000 + 17 * 60_000);
  assert.equal(old.stale, true);
  assert.equal(old.color, GAUGE.unknown);
  assert.equal(storageSummary(undefined).level, "unknown");
});

test("free space reads short on the deck plate", () => {
  assert.equal(freeLabel(2.2 * GB), "2.2G");
  assert.equal(freeLabel(31.4 * GB), "31G");
  assert.equal(freeLabel(1400 * GB), "1.4T");
});

test("only a machine getting worse is announced, and never on first load", () => {
  useGame.setState({ log: [] });
  const now = Date.now();
  const fresh = (gb: number) => view(gb, now);
  announceStorage({}, [fresh(2)], true);
  assert.equal(useGame.getState().log.length, 0);
  announceStorage({ e1: fresh(50) }, [fresh(12)], false);
  announceStorage({ e1: fresh(12) }, [fresh(11)], false);
  announceStorage({ e1: fresh(11) }, [fresh(3)], false);
  announceStorage({ e1: fresh(3) }, [fresh(40)], false);
  announceStorage({ e1: fresh(40) }, [view(3)], false);
  assert.deepEqual(useGame.getState().log.map((l) => l.text), [
    "A machine disk running low: 12GB free on /",
    "A machine disk nearly full: 3.0GB free on /",
  ]);
});
