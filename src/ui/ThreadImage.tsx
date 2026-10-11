import { useEffect, useState } from "react";
import { envClient } from "../t3/environment";
import type { ImageResource } from "../t3/types";

export function ThreadImage({ envId, resource, src, alt = "Image", title, onLoad }: {
  envId: string;
  resource?: ImageResource | null;
  src?: string;
  alt?: string;
  title?: string;
  onLoad?: () => void;
}) {
  const [asset, setAsset] = useState<{ key: string; url?: string; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const resourceKey = resource ? JSON.stringify(resource) : "";
  const key = `${envId}:${resourceKey || src}:${attempt}`;

  useEffect(() => {
    if (!resourceKey) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const client = envClient(envId);
        if (!client) throw new Error("Environment is not connected");
        const result = await client.imageUrl(JSON.parse(resourceKey) as ImageResource);
        if (!active) return;
        setAsset({ key, url: result.url });
        timer = setTimeout(load, Math.max(1000, result.expiresAt - Date.now() - 60_000));
      } catch (err) {
        if (active) setAsset({ key, error: err instanceof Error ? err.message : "Image unavailable" });
      }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [envId, resourceKey, key]);

  const current = asset?.key === key ? asset : undefined;
  const url = resourceKey ? current?.url : src;
  if (current?.error || !url) {
    return (
      <span className="thread-image-status" role="status">
        {alt || "Image"} · {current?.error ? "Image unavailable" : resourceKey ? "Loading image…" : "Unsupported image source"}
        {current?.error && <button className="btn" title={current.error} onClick={() => setAttempt((n) => n + 1)}>Retry image</button>}
      </span>
    );
  }
  return (
    <a className="thread-image" href={url} target="_blank" rel="noopener noreferrer" title={title || "Open full-size image"}>
      <img src={url} alt={alt} title={title} onLoad={onLoad} onError={() => setAsset({ key, error: "Image could not be loaded" })} />
    </a>
  );
}
