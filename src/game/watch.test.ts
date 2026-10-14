import assert from "node:assert/strict";
import test from "node:test";
import { saysNothingLeft } from "./watch";

test("a standing order stops only when the reply ends with NOTHING LEFT on its own line", () => {
  assert.equal(saysNothingLeft("NOTHING LEFT"), true);
  assert.equal(saysNothingLeft("Checked every module again; all done.\n\n**Nothing left.**"), true);
  assert.equal(saysNothingLeft("I'll reply NOTHING LEFT once the tests pass.\nRunning them now."), false, "quoting the instruction");
  assert.equal(saysNothingLeft("Fixed two more call sites."), false);
});
