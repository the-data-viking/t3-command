import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeMission } from "../../shared/dispatches";
import { missionBrief } from "./mission";

test("a mission brief names the mission, the goal, the others on it, and this crew member's part", () => {
  const plan = { name: " Ship the renderer ", goal: " Tiles render top-down at 60 fps. ", parts: {} };
  const brief = missionBrief(plan, ["Renderer", "Importer", "Lighting"], "Importer", "Port the map importer to the tile format");
  assert.match(brief, /^Mission "Ship the renderer": 3 crew working on one goal\./);
  assert.match(brief, /\nGoal: Tiles render top-down at 60 fps\.\n/);
  assert.match(brief, /\nYour part: Port the map importer to the tile format\n/);
  assert.match(brief, /Also on it: Renderer; Lighting\./);
  assert.doesNotMatch(brief, /Also on it:.*Importer/);
  assert.match(brief, /report what you did, how you verified it, and anything the others on this mission need to know\.$/);
  assert.doesNotMatch(brief, /\n\n\n/, "no stacked blank lines");
  assert.match(missionBrief(plan, ["A", "B"], "A"), /Your part: whatever of the goal fits/);
});

test("a mission needs both a name and a goal; anything else is an ordinary squad order", () => {
  assert.deepEqual(sanitizeMission({ name: "  Ship  ", goal: " Done. " }), { name: "Ship", goal: "Done." });
  assert.equal(sanitizeMission({ name: "Ship" }), undefined);
  assert.equal(sanitizeMission({ name: " ", goal: "x" }), undefined);
  assert.equal(sanitizeMission(null), undefined);
  assert.equal(sanitizeMission({ name: "x".repeat(80), goal: "g" })!.name.length, 60);
});
