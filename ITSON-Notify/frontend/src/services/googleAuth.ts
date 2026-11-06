// ITN-41 - Acceso compartido al flujo OAuth desde Onboarding y Configuración.
const backendUrl = (import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')

export function connectGoogle(from: 'onboarding' | 'settings') {
  window.location.assign(`${backendUrl}/auth/google?from=${from}`)
}

export async function googleSession(): Promise<{ connected: boolean; email?: string }> {
  const response = await fetch(`${backendUrl}/auth/google/session`, { credentials: 'include' })
  if (response.status === 401) return { connected: false }
  if (!response.ok) throw new Error('No se pudo consultar la autorización')
  return response.json()
}

export async function disconnectGoogle(): Promise<void> {
  const response = await fetch(`${backendUrl}/auth/google/session`, {
    method: 'DELETE', credentials: 'include',
  })
  if (!response.ok) throw new Error('No se pudo desconectar Classroom')
}

export async function logoutGoogle(): Promise<void> {
  const response = await fetch(`${backendUrl}/auth/google/logout`, {
    method: 'POST', credentials: 'include',
  })
  if (!response.ok) throw new Error('No se pudo cerrar la sesión')
}
