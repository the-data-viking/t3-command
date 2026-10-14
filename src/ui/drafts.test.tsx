import assert from "node:assert/strict";
import test from "node:test";

// A minimal localStorage for the node test runner.
const store = new Map<string, string>();
Object.assign(globalThis, { localStorage: {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; },
} });

const { pruneDrafts, readDraft, writeDraft } = await import("./drafts");

test("a draft is kept until it's sent (cleared), and blank text keeps nothing", () => {
  writeDraft("order:e:t", "Rebase on main and");
  assert.equal(readDraft("order:e:t"), "Rebase on main and");
  writeDraft("order:e:t", "   ");
  assert.equal(readDraft("order:e:t"), "");
  assert.equal(store.size, 0);
});

test("old and corrupt drafts are pruned", () => {
  store.set("t3c:draft:old", JSON.stringify({ text: "x", at: Date.now() - 30 * 86_400_000 }));
  store.set("t3c:draft:bad", "{");
  store.set("t3c:draft:new", JSON.stringify({ text: "keep", at: Date.now() }));
  store.set("t3c:theme", "pastel");
  pruneDrafts();
  assert.deepEqual([...store.keys()].sort(), ["t3c:draft:new", "t3c:theme"]);
  assert.equal(readDraft("new"), "keep");
});
