import assert from "node:assert/strict";
import test from "node:test";
import { FLIGHT_KIT } from "../art/flightdeck";
import { consoleScreen, terminalScreen } from "./screens";

test("screens keep the fixture's shape and change only screen cells", () => {
  for (const grid of [consoleScreen("working", 7, true), consoleScreen("alert", 0, true)]) {
    assert.equal(grid.length, FLIGHT_KIT.CONSOLE.length);
    grid.forEach((row, y) => [...row].forEach((ch, x) => {
      const base = FLIGHT_KIT.CONSOLE[y][x];
      if (base !== "S" && base !== "x") assert.equal(ch, base, `(${x},${y}) outside the screen`);
    }));
  }
  assert.equal(terminalScreen(3).length, FLIGHT_KIT.TERMINAL.length);
});

test("screens animate while writing, hold a status shape, and memoize", () => {
  assert.notDeepEqual(consoleScreen("working", 1, true), consoleScreen("working", 6, true));
  assert.equal(consoleScreen("working", 6, true), consoleScreen("working", 46, true), "the same frame is the same grid object");
  assert.equal(consoleScreen("alert", 1, true), consoleScreen("alert", 2, true));
  assert.ok(consoleScreen("error", 0, false).some((row) => row.includes("k")));
  assert.equal(consoleScreen("idle", 0, false), FLIGHT_KIT.CONSOLE);
  assert.notEqual(terminalScreen(1), terminalScreen(2));
});
