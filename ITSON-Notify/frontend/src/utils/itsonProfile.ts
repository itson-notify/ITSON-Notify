// ITN-55 - Validación del perfil ITSON (matrícula y carrera) y textos de error del
// guardado. Ningún texto incluye lo que el alumno escribió.
import { ApiError } from '@/services/api'

// 11 dígitos que empiezan con 00000, igual que el backend.
export const MATRICULA_RE = /^00000\d{6}$/
// Código de carrera, p. ej. INSOF.
export const CAREER_RE = /^[A-Z]{2,8}$/

export const onlyDigits = (v: string) => v.replace(/\D/g, '').slice(0, 11)
export const normalizeCareer = (v: string) => v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)

export const matriculaError = (v: string) =>
  v && !MATRICULA_RE.test(v) ? 'Tu matrícula debe tener 11 dígitos y empezar con 00000.' : undefined
export const careerError = (v: string) =>
  v && !CAREER_RE.test(v) ? 'La carrera es un código de 2 a 8 letras, por ejemplo INSOF.' : undefined

const minutos = (segundos: number) => {
  const m = Math.max(1, Math.ceil(segundos / 60))
  return `${m} ${m === 1 ? 'minuto' : 'minutos'}`
}

// Texto para un fallo de saveItsonProfile. El 401 lo maneja quien llama.
export function itsonProfileErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'No pudimos guardar tu matrícula. Revisa tu conexión e intenta de nuevo.'
  if (error.status === 400) {
    if (error.code === 'correo_no_institucional') {
      return 'Para usar tu matrícula entra con tu correo institucional (@potros.itson.edu.mx).'
    }
    if (error.code === 'correo_sin_matricula') {
      return 'Tu correo institucional no termina con tu matrícula, así que no podemos confirmar que es tuya.'
    }
    if (error.code === 'matricula_no_coincide') {
      return 'Esa matrícula no corresponde a tu correo institucional. Revisa que sea la tuya.'
    }
    return 'Revisa la matrícula y la carrera e intenta de nuevo.'
  }
  if (error.status === 413) return 'Los datos enviados son demasiado grandes. Revisa los campos e intenta de nuevo.'
  if (error.status === 429) {
    return error.retryAfter
      ? `Hiciste demasiados intentos. Espera ${minutos(error.retryAfter)} y vuelve a intentarlo.`
      : 'Hiciste demasiados intentos. Espera unos minutos y vuelve a intentarlo.'
  }
  return 'No pudimos guardar tu matrícula. Intenta de nuevo más tarde.'
}
