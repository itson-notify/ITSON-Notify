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

// ITN-51 - Estado de la vinculación de iVirtual. Nunca trae el token.
export interface IvirtualLink {
  available: boolean
  linked: boolean
  status: 'active' | 'needs_relink' | null
  lastValidatedAt: string | null
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

// ApiError solo lleva el status: nunca el body de la petición ni el de la respuesta.
async function request(path: string, method: Method = 'GET', body?: unknown): Promise<Response> {
  const init: RequestInit = { method, credentials: 'include' }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${backendUrl}/api${path}`, init)
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

// ITN-51 - Vinculación de iVirtual. La contraseña solo viaja en el body de esta
// petición: aquí no se guarda ni se registra.
export async function getIvirtualLink(): Promise<IvirtualLink> {
  return (await request('/credentials/ivirtual')).json()
}

export async function linkIvirtual(username: string, password: string): Promise<IvirtualLink> {
  return (await request('/credentials/ivirtual', 'PUT', { username, password })).json()
}

// Un 404 significa que ya estaba desvinculada: para el alumno el resultado es el mismo.
export async function unlinkIvirtual(): Promise<'unlinked' | 'already_unlinked'> {
  try {
    await request('/credentials/ivirtual', 'DELETE')
    return 'unlinked'
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return 'already_unlinked'
    throw error
  }
}
