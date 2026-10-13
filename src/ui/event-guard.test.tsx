import assert from "node:assert/strict";
import test from "node:test";
import { ARM_MS, armed, DIGIT_GUARD_MS, mayAutoOpen, noteKey } from "./event-guard";

const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods }) as KeyboardEvent;

test("a card doesn't pop up under a number key just pressed (a control group could become Approve)", () => {
  noteKey(key("1"), 1000);
  assert.equal(mayAutoOpen(1000 + 100), false);
  assert.equal(mayAutoOpen(1000 + DIGIT_GUARD_MS), true);
});

test("only plain digits count: letters and shortcuts don't hold back the card", () => {
  noteKey(key("a"), 5000);
  noteKey(key("2", { ctrlKey: true }), 5000);
  assert.equal(mayAutoOpen(5000 + 10, -Infinity), true);
});

test("a request's choices arm only after it has been on screen a moment", () => {
  assert.equal(armed(0, ARM_MS - 1), false);
  assert.equal(armed(0, ARM_MS), true);
});
