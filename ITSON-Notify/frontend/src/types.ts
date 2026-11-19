import type { Dispatch, SetStateAction } from 'react'
import type { CalendarEvent, Course, CourseItem } from '@/services/api'

export type Page = 'inicio' | 'materias' | 'calendario' | 'notificaciones' | 'configuracion' | 'perfil'
export type NotifType = 'calificaciones' | 'tareas' | 'cupos' | 'tramites'
export type Filter = 'todas' | NotifType
export type SourceStatus = 'ok' | 'error'

export interface Notif {
  id: string
  type: NotifType
  title: string
  subject: string
  time: string
  unread: boolean
  body: string
  rows: { label: string; value: string }[]
}

export interface Settings {
  itsonId: string
  itsonStatus: SourceStatus
  classroomConnected: boolean
  classroomEmail: string
  categories: Record<NotifType, boolean>
  cupoWatch: string[]
  pushOn: boolean
  pushPermission: 'default' | 'granted' | 'denied';
  emailOn: boolean
  email: string
  quietHours: boolean
}

export type SetSettings = Dispatch<SetStateAction<Settings>>
export type Notify = (text: string, undo?: () => void) => void

export interface ConfirmReq {
  title: string
  body: string
  label: string
  danger?: boolean
  onConfirm: () => void
}

export interface SyncProps {
  syncing: boolean
  firstRun: boolean
  loading: boolean
  onSync: () => void
  onFix: () => void
  onHelp: (q: string) => void
}

// ITN-58 - Materias de /api/courses. `courses` conserva la última lista buena mientras
// se refresca o si el refresco falla.
export interface CoursesState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  courses: Course[]
}

// Tareas de una materia, guardadas en memoria. `updatedAt` es el de la materia cuando se
// pidieron: si cambia al refrescar la lista, se vuelven a pedir.
export interface CourseItemsEntry {
  status: 'loading' | 'ready' | 'error' | 'missing'
  items: CourseItem[]
  updatedAt: string
}

// ITN-61 - Calendario académico de /api/calendar. `events` conserva la última lista buena
// mientras se refresca o si el refresco falla. `unavailable` es el 503 de
// calendario_no_disponible (falta la migración en la base), distinto de un error genérico.
// `from`/`to` son el rango pedido (días en Hermosillo).
export interface CalendarState {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
  events: CalendarEvent[]
  from: string | null
  to: string | null
}
