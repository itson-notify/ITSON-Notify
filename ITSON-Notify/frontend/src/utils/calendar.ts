// ITN-61 - Utilidades puras del calendario académico: días en hora de Hermosillo,
// clasificación, agrupación por fecha y textos. Reciben `now` para probarlas con una
// hora fija.
import type { CalendarEvent } from '@/services/api'
import { ZONA_ITSON } from '@/utils/courses'

export type EventWhen = 'pasado' | 'hoy' | 'proximo'

export const REGISTRO_ESCOLAR = 'Registro Escolar'

const DIA_MS = 86_400_000
const RE_DIA = /^(\d{4})-(\d{2})-(\d{2})$/

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_ITSON, year: 'numeric', month: '2-digit', day: '2-digit' })

/** Instante (ms) a "AAAA-MM-DD" del día en Hermosillo. */
export function dayKey(ms: number): string {
  const parts = dayFormatter.formatToParts(new Date(ms))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

// Un día "AAAA-MM-DD" como instante a mediodía UTC: solo para aritmética de calendario
// y para formatearlo con timeZone UTC sin que se corra de día.
const dayToUtc = (day: string) => {
  const m = RE_DIA.exec(day)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : NaN
}
const utcToDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function addDays(day: string, n: number): string {
  return utcToDay(dayToUtc(day) + n * DIA_MS)
}

/** Días de calendario de `from` a `to` (negativo si `to` es antes). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayToUtc(to) - dayToUtc(from)) / DIA_MS)
}

/**
 * Ventana que se pide a /api/calendar: del primer día del mes actual al último día del
 * cuarto mes siguiente (p. ej. 1 nov – 31 mar). Siempre bajo los 366 días del backend.
 */
export function calendarWindow(now: number): { from: string; to: string } {
  const [y, m] = dayKey(now).split('-').map(Number)
  const from = `${y}-${String(m).padStart(2, '0')}-01`
  const to = utcToDay(Date.UTC(y, m - 1 + 5, 0, 12))
  return { from, to }
}

/** Primer y último día (inclusive) en Hermosillo. Los de todo el día usan startDate/endDate. */
export function eventDays(event: CalendarEvent): { start: string; end: string } {
  if (event.allDay) return { start: event.startDate, end: event.endDate || event.startDate }
  const start = dayKey(Date.parse(event.startsAt))
  const endMs = Date.parse(event.endsAt)
  const end = Number.isNaN(endMs) ? start : dayKey(endMs)
  return { start, end: end < start ? start : end }
}

/** Pasado si terminó antes de hoy, hoy si hoy cae entre su inicio y su fin, próximo si empieza después. */
export function classifyEvent(event: CalendarEvent, now: number): EventWhen {
  const today = dayKey(now)
  const { start, end } = eventDays(event)
  if (end < today) return 'pasado'
  if (start > today) return 'proximo'
  return 'hoy'
}

export function isSchoolRecord(event: Pick<CalendarEvent, 'category'>): boolean {
  return event.category?.trim().toLowerCase() === REGISTRO_ESCOLAR.toLowerCase()
}

export interface DayGroup {
  day: string
  when: EventWhen
  events: CalendarEvent[]
}

/**
 * Agrupa por día en orden ascendente. Un evento de varios días que sigue en curso se
 * muestra en el grupo de hoy; los demás, en su día de inicio. Dentro del día, primero
 * los de todo el día y luego por hora de inicio. No muta la lista.
 */
export function groupByDate(events: CalendarEvent[], now: number): DayGroup[] {
  const today = dayKey(now)
  const byDay = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    const when = classifyEvent(event, now)
    const day = when === 'hoy' ? today : eventDays(event).start
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push(event)
  }
  return [...byDay.keys()].sort().map(day => ({
    day,
    when: day < today ? 'pasado' : day === today ? 'hoy' : 'proximo',
    events: byDay.get(day)!
      .map((event, index) => ({ event, index }))
      .sort((a, b) => {
        if (a.event.allDay !== b.event.allDay) return a.event.allDay ? -1 : 1
        const diff = Date.parse(a.event.startsAt) - Date.parse(b.event.startsAt)
        return Number.isNaN(diff) || diff === 0 ? a.index - b.index : diff
      })
      .map(x => x.event),
  }))
}

/** Separa los grupos pasados de los de hoy y próximos. */
export function splitGroups(groups: DayGroup[]): { past: DayGroup[]; upcoming: DayGroup[] } {
  return { past: groups.filter(g => g.when === 'pasado'), upcoming: groups.filter(g => g.when !== 'pasado') }
}

/** "Hoy", "Mañana", "En 3 días", "Ayer", "Hace 5 días"; si sigue en curso, "Hoy · termina en 2 días". */
export function relativeLabel(event: CalendarEvent, now: number): string {
  const today = dayKey(now)
  const { start, end } = eventDays(event)
  const when = classifyEvent(event, now)
  if (when === 'hoy') {
    const left = daysBetween(today, end)
    if (left <= 0) return 'Hoy'
    return left === 1 ? 'Hoy · termina mañana' : `Hoy · termina en ${left} días`
  }
  if (when === 'proximo') {
    const n = daysBetween(today, start)
    return n === 1 ? 'Mañana' : `En ${n} días`
  }
  const n = daysBetween(end, today)
  return n === 1 ? 'Ayer' : `Hace ${n} días`
}

const clean = (s: string) => s.replace(/\.$/, '')

const fmtDay = (day: string, options: Intl.DateTimeFormatOptions) => {
  const parts = new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', ...options }).formatToParts(new Date(dayToUtc(day)))
  return (type: Intl.DateTimeFormatPartTypes) => clean(parts.find(p => p.type === type)?.value ?? '')
}

const yearOf = (now: number) => dayKey(now).slice(0, 4)

/** Encabezado de un día: "jueves 19 de noviembre" (con el año si no es el de `now`). */
export function formatDayHeading(day: string, now: number): string {
  const get = fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const year = get('year')
  return `${get('weekday')} ${get('day')} de ${get('month')}${year !== yearOf(now) ? ` de ${year}` : ''}`.toLowerCase()
}

/** Día corto: "19 nov" (con el año si no es el de `now`). */
export function formatShortDay(day: string, now: number): string {
  const get = fmtDay(day, { day: 'numeric', month: 'short', year: 'numeric' })
  const year = get('year')
  return `${get('day')} ${get('month')}${year !== yearOf(now) ? ` ${year}` : ''}`.toLowerCase()
}

const timeOf = (ms: number) => {
  const parts = new Intl.DateTimeFormat('es-MX', { timeZone: ZONA_ITSON, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('hour')}:${get('minute')}`
}

/**
 * Cuándo ocurre, en hora de Hermosillo:
 * - todo el día de un solo día: "Todo el día"
 * - todo el día de varios días: "Todo el día · 21 dic – 6 ene 2027"
 * - con hora, mismo día: "08:00 – 10:00" (o solo "08:00" si empieza y termina igual)
 * - con hora, varios días: "19 nov, 08:00 – 20 nov, 10:00"
 */
export function formatEventWhen(event: CalendarEvent, now: number): string {
  const { start, end } = eventDays(event)
  if (event.allDay) {
    return start === end ? 'Todo el día' : `Todo el día · ${formatShortDay(start, now)} – ${formatShortDay(end, now)}`
  }
  const startMs = Date.parse(event.startsAt)
  const endMs = Date.parse(event.endsAt)
  if (Number.isNaN(startMs)) return ''
  const from = timeOf(startMs)
  if (Number.isNaN(endMs) || endMs <= startMs) return from
  const to = timeOf(endMs)
  if (start === end) return `${from} – ${to}`
  return `${formatShortDay(start, now)}, ${from} – ${formatShortDay(end, now)}, ${to}`
}
