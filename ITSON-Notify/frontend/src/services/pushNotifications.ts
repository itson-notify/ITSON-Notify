import { backendUrl } from '@/services/backend'

export function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

// Pide permiso en el navegador, registra el Service Worker y guarda la suscripción en el backend.
export async function subscribeBrowserPush(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('push_no_soportado')
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('permiso_denegado')

  const keyRes = await fetch(`${backendUrl}/push/vapid-public-key`, { credentials: 'include' })
  if (!keyRes.ok) throw new Error('sin_llave_vapid')
  const { publicKey } = await keyRes.json()

  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })

  const subRes = await fetch(`${backendUrl}/push/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  })
  if (!subRes.ok) {
    try { await subscription.unsubscribe() } catch { /* limpieza local */ }
    throw new Error('error_guardando_suscripcion')
  }
}

// Revoca la suscripción Push en el backend y en el navegador. Lanza error si
// cualquiera de los dos pasos falla para que el llamador lo maneje explícitamente.
export async function unsubscribeBrowserPush(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return

  const res = await fetch(`${backendUrl}/push/subscriptions`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  })
  if (!res.ok) {
    throw new Error('error_eliminando_suscripcion')
  }

  const unsubscribed = await subscription.unsubscribe()
  if (!unsubscribed) {
    throw new Error('error_revocando_suscripcion_navegador')
  }
}
