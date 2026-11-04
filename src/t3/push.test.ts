import assert from "node:assert/strict";
import test from "node:test";
import { sameKey } from "./push.ts";

test("a browser subscription only counts as made with this server key when the bytes match", () => {
  const key = "BAEC_w";
  const bytes = new Uint8Array([4, 1, 2, 255]).buffer;
  assert.equal(sameKey(bytes, key), true);
  assert.equal(sameKey(new Uint8Array([4, 1, 2, 254]).buffer, key), false);
  assert.equal(sameKey(new Uint8Array([4, 1, 2]).buffer, key), false);
  assert.equal(sameKey(null, key), false, "a browser that doesn't say counts as another key: subscribe again");
  assert.equal(sameKey(bytes, ""), false);
});
