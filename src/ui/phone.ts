// Phone layout: one compact top bar with a menu, a crew dock along the bottom, and full-screen
// panels. Matches the `max-width: 700px` breakpoint in index.css.

import { useSyncExternalStore } from "react";

export const PHONE_QUERY = "(max-width: 700px)";

const media = (query = PHONE_QUERY) => (typeof matchMedia === "undefined" ? undefined : matchMedia(query));

export function isPhone(): boolean {
  return media()?.matches ?? false;
}

/** Touch screens get finger-sized hit areas on the map. */
export function isCoarsePointer(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
}

export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** Laptops use the same secondary navigation disclosure as phones. */
export function useCompactToolbar(): boolean {
  return useMediaQuery("(max-width: 1439px)");
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (change) => {
      const m = media(query);
      m?.addEventListener("change", change);
      return () => m?.removeEventListener("change", change);
    },
    () => media(query)?.matches ?? false,
    () => false,
  );
}
