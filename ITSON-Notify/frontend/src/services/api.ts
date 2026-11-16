// ITN-53 - Datos del alumno desde /api. La sesión va en la cookie HttpOnly: aquí no
// se guarda nada ni se usa la llave interna del worker.
import { backendUrl, mockMode } from '@/services/backend'
import type { Notif, SourceStatus } from '@/types'

export interface Me {
  email: string
  classroomConnected: boolean
  itsonStatus: SourceStatus
}

// ITN-55 - `code` es el código de error del backend (p. ej. matricula_no_coincide), solo
// si tiene forma de código; `retryAfter`, los segundos de Retry-After de un 429. Nunca
// se guarda el resto del body.
export class ApiError extends Error {
  status: number
  code?: string
  retryAfter?: number
  constructor(status: number, code?: string, retryAfter?: number) {
    super(`La API respondió ${status}`)
    this.name = 'ApiError'
    this.status = status
    if (code) this.code = code
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }
}

const ERROR_CODE = /^[a-z_]{1,40}$/

async function apiErrorOf(response: Response): Promise<ApiError> {
  let code: string | undefined
  try {
    const body = await response.json()
    if (typeof body?.error === 'string' && ERROR_CODE.test(body.error)) code = body.error
  } catch { /* sin body JSON: solo el status */ }
  const header = response.headers?.get?.('Retry-After')
  const retryAfter = header && /^\d{1,6}$/.test(header) ? Number(header) : undefined
  return new ApiError(response.status, code, retryAfter)
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
  if (!response.ok) throw await apiErrorOf(response)
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

// ITN-55 - Matrícula y carrera para la API REST de ITSON. GET nunca trae la matrícula
// completa, solo matriculaHint. La matrícula solo viaja en el body del PUT: aquí no se
// guarda ni se registra.
export interface ItsonProfile {
  configured: boolean
  matriculaHint: string | null
  career: string | null
  updatedAt: string | null
}

export const EMPTY_ITSON_PROFILE: ItsonProfile = { configured: false, matriculaHint: null, career: null, updatedAt: null }

// Con VITE_USE_MOCK=true no hay backend: el perfil vive en memoria y, como en la API,
// solo se conserva la pista, nunca la matrícula completa.
let mockProfile: ItsonProfile = EMPTY_ITSON_PROFILE
const hintOf = (matricula: string) => `${'•'.repeat(7)}${matricula.slice(-4)}`

export async function getItsonProfile(): Promise<ItsonProfile> {
  if (mockMode) return mockProfile
  return (await request('/itson-profile')).json()
}

export async function saveItsonProfile(matricula: string, career: string): Promise<ItsonProfile> {
  if (mockMode) {
    mockProfile = { configured: true, matriculaHint: hintOf(matricula), career, updatedAt: new Date().toISOString() }
    return mockProfile
  }
  return (await request('/itson-profile', 'PUT', { matricula, career })).json()
}

// Un 404 significa que no había perfil: para el alumno el resultado es el mismo.
export async function deleteItsonProfile(): Promise<'deleted' | 'already_deleted'> {
  if (mockMode) {
    const had = mockProfile.configured
    mockProfile = EMPTY_ITSON_PROFILE
    return had ? 'deleted' : 'already_deleted'
  }
  try {
    await request('/itson-profile', 'DELETE')
    return 'deleted'
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return 'already_deleted'
    throw error
  }
}
