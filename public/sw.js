// =========================================================
// Service Worker — Anak Requests
// Gère la réception des notifications push et le clic dessus.
// Ce fichier doit être servi à la RACINE du site
// (ex: https://tondomaine.com/sw.js) pour pouvoir contrôler
// toutes les pages de l'app.
// =========================================================

self.addEventListener('install', (event) => {
  // Active immédiatement la nouvelle version sans attendre
  // la fermeture des onglets ouverts.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------
// RÉCEPTION D'UNE NOTIFICATION PUSH
// ---------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Anak Requests', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Anak Requests';
  const options = {
    body: data.body || '',
    icon: data.icon || '/favicon_io/apple-touch-icon.png',
    badge: data.badge || '/favicon_io/favicon-32x32.png',
    tag: data.tag || 'anak-request',       // regroupe les notifs sur la même demande
    renotify: true,
    data: {
      url: data.url || '/index.html'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ---------------------------------------------------------
// CLIC SUR LA NOTIFICATION → ouvre/focus l'app
// ---------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) || '/index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      // Si un onglet de l'app est déjà ouvert, on le réutilise et on le focus
      const existing = clientsArr.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        existing.navigate(targetUrl);
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
