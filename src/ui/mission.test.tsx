import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeMission } from "../../shared/dispatches";
import { debriefMarkdown, followUpBrief, missionBrief } from "./mission";

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

test("a follow-up keeps the mission and the crew member's part, and can pass on what the others said", () => {
  const mission = { name: "Ship it", goal: "Tiles at 60 fps." };
  const others = [{ title: "Importer", reply: "Map import done; tiles are 16 px.", status: "reported", part: "Importer" }, { title: "Lighting", status: "working" }];
  const brief = followUpBrief({ mission, text: " Now wire the importer into the renderer. ", part: "Renderer", others });
  assert.match(brief, /^Mission "Ship it", follow-up\.\nGoal: Tiles at 60 fps\.\nYour part: Renderer\n\nNow wire the importer into the renderer\.\n/);
  assert.match(brief, /What the others on this mission reported last time:\n\n--- Importer \(part: Importer\) ---\nMap import done; tiles are 16 px\./);
  assert.doesNotMatch(brief, /Lighting/, "no reply, nothing to pass on");
  assert.match(brief, /report what you did, how you verified it, and anything the others need to know\.$/);
  const long = followUpBrief({ text: "Next.", others: [{ title: "A", reply: "x".repeat(5_000), status: "reported" }] });
  assert.ok(long.length < 1_700, "each shared reply is clipped");
  assert.equal(followUpBrief({ text: "Next." }), "Next.", "a plain squad follow-up is just the order");
});

test("a debrief is one markdown document: the goal, then each crew member's reply or status", () => {
  const md = debriefMarkdown({ mission: { name: "Ship it", goal: "Tiles at 60 fps." }, order: "x", replies: [
    { title: "Renderer", reply: "Done.", status: "reported", part: "Tiles" }, { title: "Lighting", status: "turn failed" }] });
  assert.equal(md, "# Mission: Ship it\n\n**Goal:** Tiles at 60 fps.\n\n## Renderer — reported (part: Tiles)\n\nDone.\n\n## Lighting — turn failed\n\n_No reply._\n");
  assert.match(debriefMarkdown({ order: "Status?\nmore", replies: [] }), /^# Squad order\n\n\*\*Order:\*\* Status\?\n$/);
});
