// Guards against deciding an approval by accident. The event card pops up by itself and its
// choices answer to 1–9, which are also the control-group keys: a card appearing just before you
// press 1 must not turn that keypress into "Approve".

/** Choices on a newly shown request ignore keys and clicks for this long. */
export const ARM_MS = 450;
/** A card doesn't pop up by itself within this long of a digit keypress. */
export const DIGIT_GUARD_MS = 600;
/** …nor within this long of panning, dragging, scrolling or zooming: it would land under the pointer. */
export const POINTER_GUARD_MS = 1500;

let lastDigitAt = -Infinity;
let lastPointerAt = -Infinity;

/** Note the pointer at work (a press, a drag, a wheel), so a pop-up waits for a pause. */
export function notePointer(e: PointerEvent | WheelEvent, now = performance.now()): void {
  if (e.type === "pointermove" && !(e as PointerEvent).buttons) return;
  lastPointerAt = now;
}

/** Note keypresses (call from a capture listener) so a pop-up can tell a digit was just pressed. */
export function noteKey(e: KeyboardEvent, now = performance.now()): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[0-9]$/.test(e.key)) lastDigitAt = now;
}

/**
 * May the event card open by itself right now? Not just after a digit was pressed, nor while the
 * pointer is busy (it's announced instead, and Space opens it).
 */
export function mayAutoOpen(now = performance.now(), last = lastDigitAt, pointer = lastPointerAt): boolean {
  return now - last >= DIGIT_GUARD_MS && now - pointer >= POINTER_GUARD_MS;
}

/** Is a request first shown at `shownAt` ready to take a choice? */
export function armed(shownAt: number, now = performance.now()): boolean {
  return now - shownAt >= ARM_MS;
}
