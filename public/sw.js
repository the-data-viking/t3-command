// T3 Command service worker: shows push notifications from the Command server and opens the app
// at the right crew member when one is tapped. No offline caching: the app needs the live server.

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
    data: { url: data.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
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
