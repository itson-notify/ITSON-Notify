import { I, type IconFn } from '@/components/icons'
import type { NotifType, Settings } from '@/types'

export const TYPE_CFG: Record<NotifType, { label: string; desc: string; icon: IconFn; color: string; bg: string; source: string; note: string; cta: string; stat: string }> = {
  calificaciones: { label: 'Calificaciones', desc: 'Cuando se publique una calificación', icon: I.chart, color: '#16A34A', bg: '#F0FDF4',
    source: 'Portal de alumnos', note: 'Se generó al detectar una calificación nueva en el portal de alumnos.', cta: 'Ver en el portal', stat: 'calificaciones nuevas' },
  tareas: { label: 'Tareas', desc: 'Tareas de Google Classroom: llegarán en una siguiente versión', icon: I.filetext, color: '#7C3AED', bg: '#F5F3FF',
    source: 'Google Classroom', note: 'Los avisos de tareas de Google Classroom llegarán en una siguiente versión.', cta: 'Abrir en Classroom', stat: 'tareas nuevas' },
  tramites: { label: 'Trámites', desc: 'Cuando cambie el estado de un trámite', icon: I.file, color: '#2563EB', bg: '#EFF6FF',
    source: 'Portal de alumnos', note: 'Se generó al detectar un cambio de estado en uno de tus trámites.', cta: 'Ver trámite', stat: 'trámites actualizados' },
}

export const TYPES = Object.keys(TYPE_CFG) as NotifType[]

/** [H5] Categorías activas (tareas solo cuenta si Classroom está conectado). */
export function activeCategories(s: Settings) {
  return TYPES.filter(t => s.categories[t] && (t !== 'tareas' || s.classroomConnected))
}
