// Saved orders ("playbooks"): named order texts you type as /name in any order box, shared by
// every device through the Command server.

export interface Playbook {
  /** Typed as /name; lowercase letters, digits and dashes. */
  name: string;
  text: string;
}

/** The spec agents get from /widget (docs/WIDGETS.md has the long form). */
const WIDGET_PLAYBOOK = `Build me a T3 Command widget: a small live dashboard I can watch in T3 Command instead of asking you for updates. What it should show is below.

How widgets work:
- Put one self-contained page at .t3/widgets/<id>.html in your current working directory (<id>: lowercase letters, digits and dashes, up to 40 characters). A workspace can have several widgets. Keep .t3/ out of git: add it to .git/info/exclude.
- Put its data at .t3/widgets/<id>.json (at most 1 MB). T3 Command re-reads it every few seconds while the widget is on screen and hands it to the page without reloading it. Write it atomically (write <id>.json.tmp, then mv), with a top-level "updatedAt" (ISO 8601) so Command can flag the widget when updates stop.
- Feed the data from a live process that keeps running after your turn ends: a small script started with nohup ... & (or tmux/launchd) that recomputes the JSON every 30-60 s from logs, files or commands. Keep it cheap and idempotent, log to .t3/widgets/<id>.log, write its PID to .t3/widgets/<id>.pid, and have it write a final JSON and exit once what it watches is finished. Check the feeder is running and the JSON updates before you report back.
- In the page, read data with t3widget.onData((data, updatedAt) => render(data)): it's called with the current data (if any) and on every change. t3widget.data holds the latest.
- The page runs in a sandboxed iframe. Inline <script> and <style> work, as do scripts, styles, fonts and images from https URLs (a charting library from a CDN, say). Network requests (fetch, XHR, WebSocket), cookies, localStorage, popups and navigation are blocked: every piece of data comes through the JSON file.
- <title> is the widget's name. Optional: <meta name="t3-widget-size" content="420x260"> (its size in px when pinned) and <meta name="t3-widget-stale-after" content="300"> (seconds without an update before it's flagged stale; default 600).
- Style it with Command's colours, so it matches wherever it's shown (a station module in the crew panel, HUD chrome when pinned) and follows the map's theme: var(--t3-bg) is the page's default background, then var(--t3-surface) for cards, var(--t3-text) and var(--t3-muted) for text, var(--t3-line) for borders, var(--t3-accent), and var(--t3-ok), var(--t3-warn), var(--t3-bad) for good, needs-attention and failed; var(--t3-font) is a monospace stack. They change live, so don't hard-code colours.
- Design for a small window (about 360-480 px wide, 200-320 px tall): compact, the most important numbers first, readable at a glance. Handle missing or partial data gracefully.
- To change the page, rewrite the HTML; Command picks it up within 30 s. To remove the widget, stop its feeder and delete its files.

When it's up, tell me the widget's id, what it shows, and how its feeder runs and stops.`;

export const DEFAULT_PLAYBOOKS: Playbook[] = [
  { name: "wrapup", text: "Wrap up: commit your work, push the branch, open a PR, and summarize what changed and how you verified it." },
  { name: "status", text: "Give me a short status: where you are, what's left, and anything blocking you or needing my decision." },
  { name: "rebase", text: "Rebase on the latest main, resolve any conflicts, rerun the tests, and push." },
  { name: "explain", text: "Explain the changes you've made so far, file by file, and why." },
  { name: "tests", text: "Run the full test suite, fix anything failing, and tell me what you ran and the result." },
  { name: "widget", text: WIDGET_PLAYBOOK },
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
