export interface QuestionOption {
  label: string;
  description?: string;
  value?: string;
}

export interface UserInputQuestion {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  allowCustomAnswer?: boolean;
  multiSelect?: boolean;
}

export interface QuestionAnswer {
  selected: string[];
  custom: string;
  useCustom: boolean;
}

export type QuestionAnswers = Record<string, string>;

export function requestQuestions(payload: Record<string, unknown>): UserInputQuestion[] {
  if (!Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((q: unknown) => {
    if (!q || typeof q !== "object") return [];
    const question = q as Record<string, unknown>;
    if (typeof question.id !== "string" || typeof question.question !== "string") return [];
    return [{
      id: question.id,
      question: question.question,
      header: typeof question.header === "string" ? question.header : undefined,
      options: Array.isArray(question.options) ? question.options.filter((o): o is QuestionOption =>
        !!o && typeof o === "object" && typeof o.label === "string" &&
        (o.value === undefined || typeof o.value === "string"),
      ) : [],
      allowCustomAnswer: question.allowCustomAnswer !== false,
      multiSelect: question.multiSelect === true,
    }];
  });
}

/** T3 accepts strings keyed by question ID; providers translate them to their native format. */
export function questionAnswers(questions: UserInputQuestion[], drafts: Record<string, QuestionAnswer>): QuestionAnswers | undefined {
  if (questions.length === 0) return undefined;
  const entries: Array<[string, string]> = [];
  for (const q of questions) {
    const draft = drafts[q.id];
    const answer = draft?.useCustom ? draft.custom.trim() : draft?.selected.join(", ") ?? "";
    if (!answer || (draft?.useCustom && q.allowCustomAnswer === false)) return undefined;
    entries.push([q.id, answer]);
  }
  return Object.fromEntries(entries);
}
