// ITN-58 - Utilidades puras de "Mis materias y tareas": orden, clasificación y textos.
// Reciben `now` para poder probarlas con una hora fija.
import type { Course, CourseItem, CourseSource, CourseSourceEntry } from '@/services/api'

export const ZONA_ITSON = 'America/Hermosillo'

export type ItemStatus = 'vencida' | 'proxima' | 'calificada' | 'sin_fecha'

export const STATUS_ORDER: ItemStatus[] = ['vencida', 'proxima', 'calificada', 'sin_fecha']

export const SOURCE_LABEL: Record<CourseSource, string> = {
  ivirtual: 'iVirtual',
  classroom: 'Google Classroom',
  itson_api: 'API de ITSON',
}

const dueMs = (item: CourseItem) => {
  if (!item.dueAt) return NaN
  return Date.parse(item.dueAt)
}

const hasGrade = (item: CourseItem) => item.grade !== null && item.grade !== undefined && item.grade !== ''

/** Por fecha de entrega ascendente; las que no tienen fecha (o es inválida) van al final. Estable. */
export function sortItems(items: CourseItem[]): CourseItem[] {
  return items
    .map((item, index) => ({ item, index, ms: dueMs(item) }))
    .sort((a, b) => {
      const aNo = Number.isNaN(a.ms); const bNo = Number.isNaN(b.ms)
      if (aNo !== bNo) return aNo ? 1 : -1
      if (!aNo && a.ms !== b.ms) return a.ms - b.ms
      return a.index - b.index
    })
    .map(x => x.item)
}

/** Calificada si tiene nota; si no, sin fecha, vencida (dueAt < now) o próxima (dueAt >= now). */
export function classifyItem(item: CourseItem, now: number): ItemStatus {
  if (hasGrade(item)) return 'calificada'
  const ms = dueMs(item)
  if (Number.isNaN(ms)) return 'sin_fecha'
  return ms < now ? 'vencida' : 'proxima'
}

/** Grupos no vacíos en el orden Vencidas, Próximas, Calificadas, Sin fecha; cada uno ordenado por fecha. */
export function groupItems(items: CourseItem[], now: number): { status: ItemStatus; items: CourseItem[] }[] {
  const sorted = sortItems(items)
  return STATUS_ORDER
    .map(status => ({ status, items: sorted.filter(item => classifyItem(item, now) === status) }))
    .filter(group => group.items.length > 0)
}

const partsOf = (date: Date, options: Intl.DateTimeFormatOptions) => {
  const parts = new Intl.DateTimeFormat('es-MX', { timeZone: ZONA_ITSON, ...options }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => (parts.find(p => p.type === type)?.value ?? '').replace(/\.$/, '')
  return get
}

/**
 * Fecha ISO (UTC) a texto en hora de Hermosillo, p. ej. "jue 19 nov, 23:59".
 * Agrega el año solo si no es el de `now`. Devuelve null si no hay fecha válida.
 */
export function formatDue(iso: string | null, now: number): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const date = new Date(ms)
  const get = partsOf(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const year = get('year')
  const thisYear = partsOf(new Date(now), { year: 'numeric' })('year')
  const fecha = `${get('weekday')} ${get('day')} ${get('month')}${year !== thisYear ? ` ${year}` : ''}`
  return `${fecha.toLowerCase()}, ${get('hour')}:${get('minute')}`
}

const numero = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100))

/** "85 / 100", "85", "Aprobado" (si iVirtual solo trae texto) o "Sin calificar". */
export function formatGrade(item: Pick<CourseItem, 'grade' | 'maxGrade'>): string {
  if (!hasGrade(item as CourseItem)) return 'Sin calificar'
  const grade = typeof item.grade === 'number' ? numero(item.grade) : String(item.grade)
  return typeof item.grade === 'number' && item.maxGrade !== null && item.maxGrade !== undefined
    ? `${grade} / ${numero(item.maxGrade)}`
    : grade
}

/** Periodo legible: "Semestre 3" para itson_api; la sección tal cual en Classroom. */
export function periodLabel(course: Pick<Course, 'source' | 'period'>): string | null {
  const period = course.period?.trim()
  if (!period) return null
  if (course.source === 'itson_api' && /^\d{1,2}$/.test(period)) return `Semestre ${Number(period)}`
  return period
}

// ── ITN-58b - Materias unificadas ───────────────────────────────────────────

export const SOURCE_ORDER: CourseSource[] = ['ivirtual', 'classroom', 'itson_api']

/** Fuentes de la materia en orden iVirtual, Classroom, ITSON; sin `sources` usa la propia. */
export function courseSources(course: Course): CourseSourceEntry[] {
  const lista = course.sources?.length
    ? course.sources
    : [{ source: course.source, id: course.id, name: course.name, period: course.period, finalGrade: course.finalGrade, updatedAt: course.updatedAt }]
  return [...lista].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))
}

/** Hay algo que pedir a /items: alguna fuente con tareas (iVirtual o Classroom). */
export const courseHasItems = (course: Course) => courseSources(course).some(s => s.source !== 'itson_api')

/** Fuente de un item: `source` si viene, si no `kind`. */
export const itemSource = (item: CourseItem): 'ivirtual' | 'classroom' => item.source ?? item.kind

/**
 * Una sección por fuente con datos, en orden iVirtual, Classroom, ITSON. Se omite la
 * fuente que no tiene ni items ni calificación final.
 */
export function sourceSections(course: Course, items: CourseItem[]): { entry: CourseSourceEntry; items: CourseItem[] }[] {
  return courseSources(course)
    .map(entry => ({ entry, items: entry.source === 'itson_api' ? [] : items.filter(i => itemSource(i) === entry.source) }))
    .filter(({ entry, items }) => items.length > 0 || Boolean(entry.finalGrade))
}
