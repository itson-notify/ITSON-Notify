// ITN-41 - Acceso compartido al flujo OAuth desde Onboarding y Configuración.
import { backendUrl } from '@/services/backend'

export function connectGoogle(from: 'onboarding' | 'settings') {
  window.location.assign(`${backendUrl}/auth/google?from=${from}`)
}

// ITN-43c - Autorización incremental solo del permiso de tareas. El backend exige la
// sesión y decide el resultado; al volver, la URL trae ?tareas=<resultado>.
export function activateClassroomTasks() {
  window.location.assign(`${backendUrl}/auth/google/tasks`)
}

// Texto del aviso según ?tareas=. El parámetro solo elige el mensaje: el estado real se
// vuelve a leer del backend.
export function tasksResultMessage(result: string): string {
  if (result === 'ok') return 'Tareas de Classroom activadas'
  if (result === 'rechazada') return 'No se activaron las tareas: no se concedió el permiso. Puedes intentarlo otra vez.'
  if (result === 'cuenta_distinta') return 'Elige la misma cuenta de Google con la que entraste para activar las tareas'
  return 'No se pudieron activar las tareas de Classroom'
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
