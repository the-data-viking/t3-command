import type { ImageResource } from "./types";

/** Keep asset requests on the selected environment's relay, never the browser's host. */
export function assetProxyUrl(envId: string, relativeUrl: string): string {
  if (!relativeUrl.startsWith("/api/assets/") || /[\\\r\n]/.test(relativeUrl)) {
    throw new Error("T3 returned an invalid asset URL");
  }
  const url = new URL(relativeUrl, "http://asset.invalid");
  if (url.origin !== "http://asset.invalid" || !url.pathname.startsWith("/api/assets/")) {
    throw new Error("T3 returned an invalid asset URL");
  }
  return `/env/${encodeURIComponent(envId)}${url.pathname.slice(4)}${url.search}${url.hash}`;
}

/** Markdown paths are files on the T3 environment (including captures outside its workspace). */
export function imageResource(src: string, threadId: string): ImageResource | null {
  let path = src.trim();
  if (!path || path.startsWith("//")) return null;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = url.pathname;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch { return null; }
  } else {
    // HTTP(S), data URLs and other schemes are not environment file paths.
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
    path = path.split(/[?#]/, 1)[0];
  }
  try { path = decodeURIComponent(path); } catch { return null; }
  return path ? { _tag: "media-file", threadId, path } : null;
}
