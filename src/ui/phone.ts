// Phone layout: one compact top bar with a menu, a crew dock along the bottom, and full-screen
// panels. Matches the `max-width: 700px` breakpoint in index.css.

import { useSyncExternalStore } from "react";

export const PHONE_QUERY = "(max-width: 700px)";

const media = () => (typeof matchMedia === "undefined" ? undefined : matchMedia(PHONE_QUERY));

export function isPhone(): boolean {
  return media()?.matches ?? false;
}

/** Touch screens get finger-sized hit areas on the map. */
export function isCoarsePointer(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
}

export function usePhone(): boolean {
  return useSyncExternalStore(
    (change) => {
      const m = media();
      m?.addEventListener("change", change);
      return () => m?.removeEventListener("change", change);
    },
    isPhone,
    () => false,
  );
}
