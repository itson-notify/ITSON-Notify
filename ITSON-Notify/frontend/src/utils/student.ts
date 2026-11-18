// ITN-58 - Datos del alumno que se muestran en Inicio, Perfil, la barra lateral y
// Onboarding. Con mock salen de STUDENT; sin mock solo de la sesión: el correo de
// /api/me y la carrera de /api/itson-profile. La API no da el nombre: no se inventa.
export interface StudentView {
  name: string | null
  email: string | null
  initials: string
  career: string | null
}

export function studentView({ mock, demo, email, career }: {
  mock: boolean
  demo: { name: string; initials: string; career: string }
  email: string | null
  career: string | null
}): StudentView {
  if (mock) return { name: demo.name, email, initials: demo.initials, career: demo.career }
  const cleanEmail = email?.trim() || null
  const initial = cleanEmail?.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? ''
  return { name: null, email: cleanEmail, initials: initial, career: career?.trim() || null }
}

/** "Hola, Alumno" con nombre; "Hola" a secas sin él. */
export const greeting = (s: StudentView) => (s.name ? `Hola, ${s.name.split(' ')[0]}` : 'Hola')
