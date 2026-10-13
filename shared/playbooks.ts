// Saved orders ("playbooks"): named order texts you type as /name in any order box, shared by
// every device through the Command server.

export interface Playbook {
  /** Typed as /name; lowercase letters, digits and dashes. */
  name: string;
  text: string;
}

export const DEFAULT_PLAYBOOKS: Playbook[] = [
  { name: "wrapup", text: "Wrap up: commit your work, push the branch, open a PR, and summarize what changed and how you verified it." },
  { name: "status", text: "Give me a short status: where you are, what's left, and anything blocking you or needing my decision." },
  { name: "rebase", text: "Rebase on the latest main, resolve any conflicts, rerun the tests, and push." },
  { name: "explain", text: "Explain the changes you've made so far, file by file, and why." },
  { name: "tests", text: "Run the full test suite, fix anything failing, and tell me what you ran and the result." },
];

export const PLAYBOOK_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Validate playbooks from a client: bad names and empty texts dropped, names unique, at most 50. */
export function sanitizePlaybooks(input: unknown): Playbook[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const seen = new Set<string>();
  const out: Playbook[] = [];
  for (const p of input) {
    if (!p || typeof p !== "object") continue;
    const name = String((p as Playbook).name ?? "").trim().toLowerCase();
    const text = String((p as Playbook).text ?? "").trim();
    if (!PLAYBOOK_NAME.test(name) || !text || text.length > 8_000 || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, text });
    if (out.length >= 50) break;
  }
  return out;
}

/** Expand a leading "/name" in an order to its playbook text (anything after the name is kept). */
export function expandPlaybook(order: string, playbooks: Playbook[]): string {
  const m = /^\/([a-z0-9-]+)(\s[\s\S]*)?$/.exec(order.trim());
  const book = m && playbooks.find((p) => p.name === m[1]);
  return book ? `${book.text}${m[2] ? `\n\n${m[2].trim()}` : ""}` : order;
}
