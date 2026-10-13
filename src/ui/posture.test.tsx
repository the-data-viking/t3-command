import assert from "node:assert/strict";
import test from "node:test";
import { needsConfirm } from "./posture";

test("only a step up to full access asks first", () => {
  assert.equal(needsConfirm("approval-required", "full-access"), true);
  assert.equal(needsConfirm("auto", "full-access"), true);
  assert.equal(needsConfirm("full-access", "full-access"), false);
  assert.equal(needsConfirm("full-access", "approval-required"), false);
  assert.equal(needsConfirm("approval-required", "auto"), false);
});
