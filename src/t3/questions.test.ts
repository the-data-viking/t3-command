import assert from "node:assert/strict";
import test from "node:test";
import { questionAnswers, requestQuestions } from "./questions";

const questions = requestQuestions({ questions: [
  { id: "route", question: "Which route?", options: [{ label: "Fast", value: "fast", description: "Less time" }] },
  { id: "kits", question: "Which kits?", multiSelect: true, options: [{ label: "Repair" }, { label: "Mining" }] },
  { id: "notes", question: "Any notes?" },
] });

test("question payload preserves option values, descriptions, and selection rules", () => {
  assert.deepEqual(questions[0].options, [{ label: "Fast", value: "fast", description: "Less time" }]);
  assert.equal(questions[1].multiSelect, true);
  assert.equal(questions[2].allowCustomAnswer, true);
  assert.deepEqual(questions[2].options, []);
  assert.deepEqual(requestQuestions({ questions: [null, {}, "bad"] }), []);
});

test("answers require every question and are keyed by the original IDs", () => {
  assert.equal(questionAnswers(questions, {}), undefined);
  assert.equal(questionAnswers(questions, { route: { selected: ["fast"], custom: "", useCustom: false } }), undefined);
  assert.deepEqual(questionAnswers(questions, {
    route: { selected: ["fast"], custom: "old custom answer", useCustom: false },
    kits: { selected: ["Repair", "Mining"], custom: "", useCustom: false },
    notes: { selected: [], custom: "  Meet at the core.  ", useCustom: true },
  }), { route: "fast", kits: "Repair, Mining", notes: "Meet at the core." });
});

test("custom answers replace selections and respect questions that forbid custom answers", () => {
  const draft = { selected: ["fast"], custom: "  Scenic  ", useCustom: true };
  assert.deepEqual(questionAnswers([questions[0]], { route: draft }), { route: "Scenic" });
  assert.equal(questionAnswers([{ ...questions[0], allowCustomAnswer: false }], { route: draft }), undefined);
  assert.equal(questionAnswers([questions[0]], { route: { ...draft, custom: "  " } }), undefined);
  assert.equal(questionAnswers([], {}), undefined);
});
