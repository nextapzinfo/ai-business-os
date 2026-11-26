/* AI Business OS service worker (2026-11-26): phone notifications for new
   customer messages. Tapping a notification opens that conversation. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "AI Business OS", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "New message";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || undefined,
      renotify: true,
      vibrate: [120, 60, 120],
      data: { url: data.url || "/dashboard/conversations" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/dashboard/conversations", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w && w.url.startsWith(self.location.origin)) {
          return w.navigate(url).then((c) => (c || w).focus());
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
