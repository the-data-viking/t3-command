// While the map is being panned or pinched (and just after), taps on map objects are ignored, so
// lifting a finger over a crew member or module doesn't select it.

let until = 0;

export function gesturing(): boolean {
  return performance.now() < until;
}

/** Hold taps off until `ms` from now, or indefinitely (`Infinity`) until `endGesture`. */
export function holdTaps(ms: number): void {
  until = ms === Infinity ? Infinity : Math.max(until, performance.now() + ms);
}

export function endGesture(): void {
  if (until === Infinity) until = performance.now() + 250;
}
