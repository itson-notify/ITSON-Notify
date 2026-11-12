// Configuración centralizada de la URL del backend para OAuth y Web Push.
export interface BackendEnv {
  VITE_BACKEND_URL?: string
  VITE_API_BASE_URL?: string
  PROD?: boolean
  MODE?: string
  VITE_USE_MOCK?: string
}

export function resolveBackendUrl(env: BackendEnv = import.meta.env): string {
  const raw = (env?.VITE_BACKEND_URL || env?.VITE_API_BASE_URL || '').trim()
  // En modo mock la app no depende del backend: un build de demo no debe
  // tronar por una URL vacía o local.
  if (env?.VITE_USE_MOCK === 'true') return raw ? raw.replace(/\/+$/, '') : 'http://localhost:3000'
  const isProd = Boolean(env?.PROD || env?.MODE === 'production')

  if (!raw) {
    if (isProd) {
      throw new Error('VITE_BACKEND_URL es obligatoria en el entorno de producción')
    }
    return 'http://localhost:3000'
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('VITE_BACKEND_URL debe ser una URL válida')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('VITE_BACKEND_URL debe usar protocolo http o https')
  }

  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (isProd && (parsed.protocol !== 'https:' || isLocalhost)) {
    throw new Error('VITE_BACKEND_URL en producción debe usar HTTPS y un dominio público')
  }

  return raw.replace(/\/+$/, '')
}

// Con 'true' la app usa los datos de mockData.ts en lugar de la API.
export const mockMode = import.meta.env.VITE_USE_MOCK === 'true'

export const backendUrl = resolveBackendUrl()
