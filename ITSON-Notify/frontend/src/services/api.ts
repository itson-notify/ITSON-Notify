// ITN-53 - Datos del alumno desde /api. La sesión va en la cookie HttpOnly: aquí no
// se guarda nada ni se usa la llave interna del worker.
import { backendUrl } from '@/services/backend'
import type { Notif, SourceStatus } from '@/types'

export interface Me {
  email: string
  classroomConnected: boolean
  itsonStatus: SourceStatus
}

export class ApiError extends Error {
  status: number
  constructor(status: number) {
    super(`La API respondió ${status}`)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
  const response = await fetch(`${backendUrl}/api${path}`, { method, credentials: 'include' })
  if (!response.ok) throw new ApiError(response.status)
  return response
}

export async function getMe(): Promise<Me> {
  return (await request('/me')).json()
}

export async function getNotifications(): Promise<Notif[]> {
  return (await request('/notifications')).json()
}

export async function markRead(id: string): Promise<void> {
  await request(`/notifications/${encodeURIComponent(id)}/read`, 'POST')
}

export async function markAllRead(): Promise<void> {
  await request('/notifications/read-all', 'POST')
}
