// Guards against deciding an approval by accident. The event card pops up by itself and its
// choices answer to 1–9, which are also the control-group keys: a card appearing just before you
// press 1 must not turn that keypress into "Approve".

/** Choices on a newly shown request ignore keys and clicks for this long. */
export const ARM_MS = 450;
/** A card doesn't pop up by itself within this long of a digit keypress. */
export const DIGIT_GUARD_MS = 600;

let lastDigitAt = -Infinity;

/** Note keypresses (call from a capture listener) so a pop-up can tell a digit was just pressed. */
export function noteKey(e: KeyboardEvent, now = performance.now()): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[0-9]$/.test(e.key)) lastDigitAt = now;
}

/** May the event card open by itself right now? Not just after a digit was pressed. */
export function mayAutoOpen(now = performance.now(), last = lastDigitAt): boolean {
  return now - last >= DIGIT_GUARD_MS;
}

/** Is a request first shown at `shownAt` ready to take a choice? */
export function armed(shownAt: number, now = performance.now()): boolean {
  return now - shownAt >= ARM_MS;
}
