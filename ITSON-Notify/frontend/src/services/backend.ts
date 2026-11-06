// ITN-53 - Configuración común de los clientes del backend.
export const backendUrl = (import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')

// Con 'true' la app usa los datos de mockData.ts en lugar de la API.
export const mockMode = import.meta.env.VITE_USE_MOCK === 'true'
