import type { Dispatch, SetStateAction } from 'react'

export type Page = 'inicio' | 'notificaciones' | 'configuracion' | 'perfil'
export type NotifType = 'calificaciones' | 'tareas' | 'cupos' | 'tramites'
export type Filter = 'todas' | NotifType
export type SourceStatus = 'ok' | 'error'

export interface Notif {
  id: number
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
  pushPermission: 'default' | 'granted'
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
  onSync: () => void
  onFix: () => void
  onHelp: (q: string) => void
}
