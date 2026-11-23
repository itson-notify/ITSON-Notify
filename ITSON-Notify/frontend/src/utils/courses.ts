// ITN-58 - Utilidades puras de "Mis materias y tareas": orden, clasificación y textos.
// Reciben `now` para poder probarlas con una hora fija.
import type { Course, CourseItem, CourseSource, CourseSourceEntry } from '@/services/api'

export const ZONA_ITSON = 'America/Hermosillo'

export type ItemStatus = 'vencida' | 'proxima' | 'entregada' | 'calificada' | 'sin_fecha'

export const STATUS_ORDER: ItemStatus[] = ['vencida', 'proxima', 'entregada', 'calificada', 'sin_fecha']

// ITN-58f - Estados de Classroom que cuentan como entregada. NEW, CREATED y
// RECLAIMED_BY_STUDENT (el alumno retiró la entrega) no cuentan.
const SUBMITTED_STATES = new Set(['TURNED_IN', 'RETURNED'])

/** La tarea de Classroom ya se entregó (TURNED_IN o RETURNED). iVirtual nunca usa este estado. */
export const isSubmitted = (item: CourseItem) =>
  (item.source ?? item.kind) === 'classroom' && SUBMITTED_STATES.has(item.submission?.state ?? '')

/** Entregada después de la fecha límite, según Classroom. */
export const isLateSubmission = (item: CourseItem) => isSubmitted(item) && item.submission?.late === true

export const SOURCE_LABEL: Record<CourseSource, string> = {
  ivirtual: 'iVirtual',
  classroom: 'Google Classroom',
  itson_api: 'API de ITSON',
}

// ITN-58e - Enlace de un item (tarea de Classroom) que se puede poner en un href. El
// backend ya lo valida; aquí se revalida con las mismas reglas que urlClassroomSegura
// (backend/src/utils/classroomUrl.js), como defensa en profundidad: solo
// https://classroom.google.com/..., sin usuario, contraseña ni puerto, máximo 2048
// caracteres. Cualquier otro valor devuelve null (sin enlace).
const CLASSROOM_HOST = 'classroom.google.com'
const MAX_URL_LENGTH = 2048

export function safeItemUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const text = url.trim()
  if (text === '' || text.length > MAX_URL_LENGTH) return null
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== CLASSROOM_HOST) return null
  if (parsed.username || parsed.password || parsed.port) return null
  return parsed.href
}

// ITN-58g - Enlace "Abrir en iVirtual" de una materia. El backend lo arma con el id de
// curso de Moodle; aquí se revalida como defensa en profundidad: solo
// https://ivirtual.itson.edu.mx/course/view.php?id=N (N entero positivo de hasta 10
// dígitos), sin usuario, contraseña, puerto, fragmento ni otros parámetros, máximo 2048
// caracteres. Cualquier otro valor devuelve null (sin enlace).
const IVIRTUAL_HOST = 'ivirtual.itson.edu.mx'
const IVIRTUAL_PATH = '/course/view.php'
const IVIRTUAL_ID = /^[1-9][0-9]{0,9}$/

export function safeIvirtualUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const text = url.trim()
  if (text === '' || text.length > MAX_URL_LENGTH) return null
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== IVIRTUAL_HOST) return null
  if (parsed.username || parsed.password || parsed.port || parsed.hash) return null
  if (parsed.pathname !== IVIRTUAL_PATH) return null
  const keys = [...parsed.searchParams.keys()]
  const id = parsed.searchParams.get('id') ?? ''
  if (keys.length !== 1 || keys[0] !== 'id' || !IVIRTUAL_ID.test(id)) return null
  return `https://${IVIRTUAL_HOST}${IVIRTUAL_PATH}?id=${id}`
}

/** Enlace válido a la materia en iVirtual, solo si una de sus fuentes es iVirtual. */
export function courseIvirtualUrl(course: Course): string | null {
  if (!courseSources(course).some(s => s.source === 'ivirtual')) return null
  return safeIvirtualUrl(course.ivirtualUrl)
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

/**
 * Calificada si tiene nota; si no, entregada si Classroom la marca como entregada
 * (TURNED_IN o RETURNED); si no, sin fecha, vencida (dueAt < now) o próxima (dueAt >= now).
 */
export function classifyItem(item: CourseItem, now: number): ItemStatus {
  if (hasGrade(item)) return 'calificada'
  if (isSubmitted(item)) return 'entregada'
  const ms = dueMs(item)
  if (Number.isNaN(ms)) return 'sin_fecha'
  return ms < now ? 'vencida' : 'proxima'
}

/** Grupos no vacíos en el orden Vencidas, Próximas, Entregadas, Calificadas, Sin fecha; cada uno ordenado por fecha. */
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
    .filter(({ entry, items }) => items.length > 0 || hasFinalGrade(entry.finalGrade))
}

/**
 * ITN-58f - Nota bajo las tareas de Classroom: el estado de entrega viene de Classroom y
 * se actualiza con cada sincronización.
 */
export const CLASSROOM_SUBMISSION_NOTE =
  'El estado de entrega se actualiza con cada sincronización con Google Classroom. Si una tarea aún no muestra su estado, puede tardar en aparecer.'

/** Aviso de Classroom: sus tareas todavía no se sincronizan (no significa que no existan). */
export const CLASSROOM_TASKS_NOTICE = {
  title: 'Tareas de Classroom aún no disponibles',
  body: 'Las tareas de Google Classroom todavía no están disponibles en ITSON Notify. Consulta Classroom para revisar tus actividades y entregas pendientes.',
}

/**
 * Estado vacío del detalle de una materia. No afirma que no haya actividades: con
 * Classroom explica que sus tareas aún no se sincronizan; sin Classroom, que aún no
 * hay actividades sincronizadas.
 */
export function emptyCourseNotice(course: Course): { title: string; body: string } {
  if (courseSources(course).some(s => s.source === 'classroom')) return CLASSROOM_TASKS_NOTICE
  return {
    title: 'Aún no hay actividades sincronizadas',
    body: 'Todavía no hemos sincronizado actividades ni calificaciones de esta materia. Aparecerán aquí en cuanto lleguen de sus fuentes.',
  }
}

// ── ITN-58c - Historial de calificaciones de la API de ITSON por semestre ────

/** La API de ITSON manda null o '-' cuando aún no hay calificación final. */
export function hasFinalGrade(value: string | null | undefined): value is string {
  const v = value?.trim()
  return Boolean(v) && v !== '-'
}

/** Calificación final legible o "Sin calificación" (null, vacío o '-'). */
export const finalGradeLabel = (value: string | null | undefined): string =>
  hasFinalGrade(value) ? value.trim() : 'Sin calificación'

export interface SemesterCourse { course: Course; entry: CourseSourceEntry }
export interface SemesterGroup { period: string | null; label: string; courses: SemesterCourse[] }

const periodNumber = (period: string | null) => (period && /^\d{1,2}$/.test(period.trim()) ? Number(period) : null)

/**
 * Un grupo por semestre con todas las fuentes itson_api de la lista, también las de
 * materias unificadas (es el historial de calificaciones). Orden descendente por
 * semestre; los periodos no numéricos van después y "sin semestre" al final. Dentro
 * de cada semestre, por nombre.
 */
export function itsonSemesters(courses: Course[]): SemesterGroup[] {
  const porPeriodo = new Map<string, SemesterGroup>()
  for (const course of courses) {
    for (const entry of courseSources(course)) {
      if (entry.source !== 'itson_api') continue
      const period = entry.period?.trim() || null
      const key = period ?? ''
      let group = porPeriodo.get(key)
      if (!group) {
        group = { period, label: period ? periodLabel({ source: 'itson_api', period }) ?? period : 'Sin semestre', courses: [] }
        porPeriodo.set(key, group)
      }
      group.courses.push({ course, entry })
    }
  }
  const groups = [...porPeriodo.values()]
  for (const g of groups) g.courses.sort((a, b) => a.course.name.localeCompare(b.course.name, 'es'))
  return groups.sort((a, b) => {
    if (a.period === null || b.period === null) return a.period === null ? (b.period === null ? 0 : 1) : -1
    const na = periodNumber(a.period); const nb = periodNumber(b.period)
    if (na !== null && nb !== null) return nb - na
    if (na !== null || nb !== null) return na !== null ? -1 : 1
    return b.period.localeCompare(a.period, 'es')
  })
}

// ── ITN-58d - Materias fuera del plan de estudios ──────────────────────────

/** Solo "anterior" saca la materia de la lista normal; sin `scope` (backend viejo) es actual. */
export const isPastCourse = (course: Course) => course.scope === 'anterior'

/** Separa las materias del semestre actual de las fuera del plan, conservando el orden. */
export function splitByScope(courses: Course[]): { current: Course[]; past: Course[] } {
  return { current: courses.filter(c => !isPastCourse(c)), past: courses.filter(isPastCourse) }
}

export const PAST_COURSES_TITLE = 'Fuera del plan de estudios'
export const PAST_COURSES_HELP = 'Cursos de Classroom que no coinciden con tu semestre actual.'
