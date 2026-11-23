"use strict";
// Golf's service worker: it shows the notifications the server pushes while
// the game is in the background ("your turn", and "someone joined the Ranked
// queue"), and brings the game back to the front when one is tapped.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {}
  const url = new URL(message.url || "./", self.registration.scope).href;
  event.waitUntil(
    self.registration.showNotification(message.title || "Your turn in Golf", {
      body: message.body || "It's your move.",
      tag: message.tag || "golf-turn",
      renotify: true, // a new turn buzzes again, even over the last one
      vibrate: [90, 70, 90], // two knocks, like the in-game "your turn" haptic
      icon: new URL("static/assets/icon.png", self.registration.scope).href,
      badge: new URL("static/assets/icon.png", self.registration.scope).href,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // an open Golf tab comes forward (on the table) rather than opening another
      const open = windows.find((client) => client.url.startsWith(self.registration.scope));
      if (open) {
        await open.focus();
        if (!open.url.startsWith(url)) await open.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
