import { I, type IconFn } from '@/components/icons'
import type { NotifType, Settings } from '@/types'

export const TYPE_CFG: Record<NotifType, { label: string; desc: string; icon: IconFn; color: string; bg: string; source: string; note: string; cta: string; stat: string }> = {
  calificaciones: { label: 'Calificaciones', desc: 'Cuando se publique una calificación', icon: I.chart, color: '#16A34A', bg: '#F0FDF4',
    source: 'Portal de alumnos', note: 'Se generó al detectar una calificación nueva en el portal de alumnos.', cta: 'Ver en el portal', stat: 'calificaciones nuevas' },
  tareas: { label: 'Tareas', desc: 'Tareas nuevas y recordatorios de entrega', icon: I.filetext, color: '#7C3AED', bg: '#F5F3FF',
    source: 'Google Classroom', note: 'Se generó al detectar una tarea nueva o próxima a vencer en Google Classroom.', cta: 'Abrir en Classroom', stat: 'tareas nuevas' },
  cupos: { label: 'Cupos', desc: 'Cuando se libere un lugar en las materias que elijas', icon: I.users, color: '#EA580C', bg: '#FFF7ED',
    source: 'Inscripciones', note: 'Se generó al detectar un lugar libre en una materia que estás vigilando.', cta: 'Ir a inscripciones', stat: 'cupos libres' },
  tramites: { label: 'Trámites', desc: 'Cuando cambie el estado de un trámite', icon: I.file, color: '#2563EB', bg: '#EFF6FF',
    source: 'Portal de alumnos', note: 'Se generó al detectar un cambio de estado en uno de tus trámites.', cta: 'Ver trámite', stat: 'trámites actualizados' },
}

export const TYPES = Object.keys(TYPE_CFG) as NotifType[]

/** [H5] Categorías activas (tareas solo cuenta si Classroom está conectado). */
export function activeCategories(s: Settings) {
  return TYPES.filter(t => s.categories[t] && (t !== 'tareas' || s.classroomConnected))
}
