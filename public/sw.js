// T3 Command service worker: shows push notifications from the Command server and opens the app
// at the right crew member when one is tapped. An unflagged approval carries Approve and Deny
// (where the platform shows actions): they decide it through the server, with a single-use token,
// and say how it went. No offline caching: the app needs the live server.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "T3 Command", body: "", url: "/", tag: "t3c" };
  try { data = { ...data, ...event.data.json() }; } catch { /* A bare push: show the defaults. */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    renotify: true,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url, token: data.token },
    ...(Array.isArray(data.actions) && data.token ? { actions: data.actions } : {}),
  }));
});

/** Approve or deny from the notification; a short notification says whether it went through. */
async function decide(notification, decision) {
  const say = (title, body) => self.registration.showNotification(title, { body, tag: `${notification.tag}:decided`, icon: "/icons/icon-192.png", data: { url: notification.data?.url ?? "/" } });
  try {
    const res = await fetch("/api/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: notification.data?.token, decision }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return say("Not decided", `${out.error ?? `HTTP ${res.status}`}. Tap to open T3 Command.`);
    return say(decision === "accept" ? "Approved" : "Denied", `${out.title ?? "Crew"}: ${out.what ?? ""}`);
  } catch {
    return say("Not decided", "Couldn't reach the Command server. Tap to open T3 Command.");
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "accept" || event.action === "decline") { event.waitUntil(decide(event.notification, event.action)); return; }
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Reuse an open T3 Command window: point it at the crew member and bring it forward.
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.navigate(url).catch(() => {});
      return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});
