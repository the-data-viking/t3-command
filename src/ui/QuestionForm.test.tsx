import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionForm } from "./QuestionForm";
import type { PendingRequest } from "../t3/types";

test("question form renders selectable options and descriptions without preselecting an answer", () => {
  const request: PendingRequest = {
    requestId: "request", kind: "user-input",
    activity: { id: "activity", kind: "user-input.requested", summary: "Question", tone: "info", turnId: null, createdAt: "2026-10-11",
      payload: { questions: [
        { id: "one", header: "Route", question: "Where next?", options: [{ label: "Core", description: "Stay close", value: "core" }] },
        { id: "many", question: "Which kits?", multiSelect: true, allowCustomAnswer: false, options: [{ label: "Repair" }, { label: "Mining" }] },
      ] } },
  };
  const html = renderToStaticMarkup(<QuestionForm request={request} envId="env" threadId="thread" />);
  assert.match(html, /Where next\?/);
  assert.match(html, /Stay close/);
  assert.match(html, /type="radio"/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /checked=""/);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
  assert.match(html, /Send answers/);
});
