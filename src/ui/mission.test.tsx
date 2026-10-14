import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeMission } from "../../shared/dispatches";
import { debriefMarkdown, followUpBrief, missionBrief } from "./mission";

test("a mission brief leads with this crew member's part, then the goal, every teammate's part and place, and the conventions", () => {
  const plan = { name: " Ship the renderer ", goal: " Tiles render top-down at 60 fps. ", parts: {} };
  const crew = [
    { key: "r", title: "Renderer", part: "The tile renderer", where: "Mac mini, branch t3/r" },
    { key: "i", title: "Importer", part: "The map importer" },
    { key: "l", title: "Lighting" },
  ];
  const brief = missionBrief(plan, crew, "i", "Port the map importer to the tile format");
  assert.match(brief, /^Mission "Ship the renderer": 3 crew working on one goal\.\n\nYour part: Port the map importer to the tile format\n\nGoal: Tiles render top-down at 60 fps\.\n/);
  assert.match(brief, /The others on it:\n- Renderer — part: The tile renderer \(Mac mini, branch t3\/r\)\n- Lighting\n/);
  assert.doesNotMatch(brief, /- Importer/, "not listed among the others");
  assert.match(brief, /start your reply with "BLOCKED:"/);
  assert.match(brief, /put "\[Ship the renderer\]" at the start of its title/);
  assert.match(brief, /End your report with one line: STATUS: done \| partial \| blocked/);
  assert.doesNotMatch(brief, /\n\n\n/, "no stacked blank lines");
  assert.match(missionBrief(plan, [{ key: "a", title: "A" }, { key: "b", title: "B" }], "a"), /Your part: whatever of the goal fits/);
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
  const brief = followUpBrief({ mission, text: " Now wire the importer into the renderer. ", part: "Renderer", others, round: 2 });
  assert.match(brief, /^Mission "Ship it", round 2\.\nGoal: Tiles at 60 fps\.\nYour part: Renderer\n\nNow wire the importer into the renderer\.\n/);
  assert.match(brief, /What the others on this mission reported last time:\n\n--- Importer \(part: Importer\) ---\nMap import done; tiles are 16 px\./);
  assert.doesNotMatch(brief, /Lighting/, "no reply, nothing to pass on");
  assert.match(brief, /report what you did, how you verified it, and anything the others need to know\.\n\nHow to work on it:/, "every round restates the rules");
  assert.match(brief, /End your report with one line: STATUS: done \| partial \| blocked/);
  const long = followUpBrief({ text: "Next.", others: [{ title: "A", reply: `${"x".repeat(5_000)}\nSTATUS: partial · FILES: a.ts · PR: none`, status: "reported" }] });
  assert.ok(long.length < 1_700, "each shared reply is clipped");
  assert.match(long, /\n…\n[\s\S]*STATUS: partial · FILES: a\.ts · PR: none$/, "from the middle, so its STATUS line survives");
  assert.equal(followUpBrief({ text: "Next." }), "Next.", "a plain squad follow-up is just the order");
});

test("a debrief is one markdown document: the goal, then each crew member's reply or status", () => {
  const md = debriefMarkdown({ mission: { name: "Ship it", goal: "Tiles at 60 fps." }, order: "x", replies: [
    { title: "Renderer", reply: "Done.", status: "reported", part: "Tiles" }, { title: "Lighting", status: "turn failed" }] });
  assert.equal(md, "# Mission: Ship it\n\n**Goal:** Tiles at 60 fps.\n\n## Renderer — reported (part: Tiles)\n\nDone.\n\n## Lighting — turn failed\n\n_No reply._\n");
  assert.match(debriefMarkdown({ order: "Status?\nmore", replies: [] }), /^# Squad order\n\n\*\*Order:\*\* Status\?\n$/);
});

test("teammates who share a title still see each other, and shared replies stay inside the order limit", () => {
  const plan = { name: "Ship", goal: "Done.", parts: {} };
  assert.match(missionBrief(plan, [{ key: "a", title: "Untitled" }, { key: "b", title: "Untitled" }], "a"), /The others on it:\n- Untitled\n/);
  const others = Array.from({ length: 8 }, (_, i) => ({ title: `Crew ${i}`, reply: "x".repeat(3_000), status: "reported" }));
  assert.ok(followUpBrief({ mission: { name: "Ship", goal: "Done." }, text: "Next.", others }).length < 7_000, "8 replies share 6,000 characters");
});

test("a debrief across rounds puts each round under its own heading, with what was asked", () => {
  const md = debriefMarkdown({ mission: { name: "Ship", goal: "Done." }, order: "Done.", replies: [], rounds: [
    { round: 1, order: "Mission brief…", replies: [{ title: "A", status: "reported", reply: "First." }] },
    { round: 2, order: "Now wire it up.\nmore", replies: [{ title: "A", status: "reported", reply: "Second." }] },
  ] });
  assert.equal(md, "# Mission: Ship\n\n**Goal:** Done.\n\n## Round 1\n\n> Mission brief…\n\n### A — reported\n\nFirst.\n\n## Round 2\n\n> Now wire it up.\n\n### A — reported\n\nSecond.\n");
});
