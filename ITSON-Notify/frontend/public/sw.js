// Service Worker para mostrar avisos Web Push en el dispositivo.
self.addEventListener('push', (event) => {
  if (!event.data) return
  const payload = event.data.json()
  const title = payload.title || 'ITSON Notify'
  const options = {
    body: payload.body || '',
    icon: '/favicon.ico',
    tag: payload.tag || 'itson-notify',
    renotify: true,
    data: { url: payload.url || '/notifications' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/notifications'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus()
      }
      if (clients.openWindow) return clients.openWindow(targetUrl)
    }),
  )
})