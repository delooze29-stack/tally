/* Tally background script: install, offline start, and notifications.
   Always tries the network first so updates show straight away; the saved copy is
   only used when offline. Firebase and fonts are never cached here. */
const CACHE = 'tally-beta-v2';
const ICONS = '../icons/';
const SHELL = ['./', './index.html', './manifest.webmanifest', ICONS + 'icon-192.png', ICONS + 'badge-96.png'];
const abs = p => new URL(p, self.location).href;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

/* Notifications. The big picture is the Tally icon; the small status-bar icon (badge)
   is a white shape on a clear background, which is what Android needs to avoid a white block.
   Reads every message layout Firebase can use, so the text always shows. */
function readPush(e) {
  let j = {};
  try { j = e.data ? e.data.json() : {}; } catch (x) { return { body: e.data ? e.data.text() : '' }; }
  const parts = [j, j.data, j.notification, j.message && j.message.data, j.message && j.message.notification,
                 j.webpush && j.webpush.notification, j.data && j.data.notification];
  const out = {};
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    for (const k of ['title', 'body', 'tag', 'url']) if (p[k] && !out[k]) out[k] = p[k];
  }
  if (!out.url && j.fcmOptions && j.fcmOptions.link) out.url = j.fcmOptions.link;
  return out;
}
self.addEventListener('push', e => {
  const d = readPush(e);
  e.waitUntil(self.registration.showNotification(d.title || 'Tally', {
    body: d.body || 'A new Tally code is ready.',
    icon: abs(ICONS + 'icon-192.png'),
    badge: abs(ICONS + 'badge-96.png'),
    tag: d.tag || 'tally',
    renotify: true,
    data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        if ('navigate' in c) c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return clients.openWindow(url);
  }));
});
