import { useState, type ReactNode } from 'react'
import { I } from '@/components/icons'
import { Button, SkeletonList } from '@/components/ui'
import type { CalendarEvent } from '@/services/api'
import {
  classifyEvent, eventDays, formatDayHeading, formatEventWhen, formatShortDay, groupByDate, isSchoolRecord,
  relativeLabel, splitGroups, REGISTRO_ESCOLAR, type DayGroup,
} from '@/utils/calendar'
import { focusRing } from '@/utils/styles'
import type { CalendarState } from '@/types'

/* ITN-61 - Calendario académico en vista de agenda: lista agrupada por día. Primero hoy
   y lo próximo; lo pasado queda colapsado y atenuado. Los datos y la petición viven en App. */

function Notice({ tone = 'slate', title, children, action }: {
  tone?: 'slate' | 'red' | 'blue'; title: string; children?: ReactNode; action?: ReactNode
}) {
  const t = {
    slate: 'border-[#E5E7EB] bg-white text-[#334155]',
    red: 'border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]',
    blue: 'border-[#BFDBFE] bg-[#EFF6FF] text-[#1E3A8A]',
  }[tone]
  return (
    <div role={tone === 'red' ? 'alert' : 'status'} className={`rounded-lg border p-4 ${t}`}>
      <p className="text-[14px] font-semibold">{title}</p>
      {children && <div className="text-[13px] mt-1 leading-relaxed opacity-90">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

// [H1] La categoría se dice con texto (no solo con color): "Registro Escolar" lleva
// etiqueta y barra lateral; las demás muestran su categoría en gris.
function CategoryTag({ event, past }: { event: CalendarEvent; past: boolean }) {
  if (isSchoolRecord(event)) {
    return (
      <span className={`inline-flex items-center gap-1 h-6 px-2 rounded-full border text-[12px] font-semibold ${past ? 'text-[#475569] bg-[#F1F5F9] border-[#E2E8F0]' : 'text-[#1D4ED8] bg-[#EFF6FF] border-[#BFDBFE]'}`}>
        {I.file(13)}{REGISTRO_ESCOLAR}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center h-6 px-2 rounded-full border border-[#E2E8F0] bg-white text-[12px] text-[#64748B]">
      {event.category?.trim() || 'Otro'}
    </span>
  )
}

function EventRow({ event, now }: { event: CalendarEvent; now: number }) {
  const when = classifyEvent(event, now)
  const past = when === 'pasado'
  const school = isSchoolRecord(event)
  const rel = relativeLabel(event, now)
  return (
    <li className={`relative flex gap-3 px-4 py-3.5 ${school && !past ? 'bg-[#F8FBFF]' : ''}`}>
      {/* Barra lateral: refuerzo visual; la etiqueta de texto es la que da el significado. */}
      <span aria-hidden="true" className={`absolute left-0 top-0 bottom-0 w-1 ${school ? (past ? 'bg-[#CBD5E1]' : 'bg-[#2563EB]') : 'bg-transparent'}`} />
      <div className="flex-1 min-w-0">
        <p className={`text-[15px] break-words ${past ? 'text-[#64748B] font-medium' : school ? 'text-[#111827] font-semibold' : 'text-[#111827] font-medium'}`}>
          {event.title}
        </p>
        <p className={`text-[13px] mt-0.5 ${past ? 'text-[#94A3B8]' : 'text-[#64748B]'}`}>{formatEventWhen(event, now)}</p>
        {event.description && <p className={`text-[13px] mt-1 leading-relaxed break-words ${past ? 'text-[#94A3B8]' : 'text-[#475569]'}`}>{event.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <CategoryTag event={event} past={past} />
          <span className={`inline-flex items-center gap-1 h-6 px-2 rounded-full text-[12px] font-medium ${
            past ? 'text-[#64748B] bg-[#F1F5F9]' : when === 'hoy' ? 'text-white bg-[#2563EB]' : 'text-[#15803D] bg-[#F0FDF4] border border-[#BBF7D0]'}`}>
            {past ? I.check(13) : I.clock(13)}{past ? `Pasado · ${rel.toLowerCase()}` : rel}
          </span>
        </div>
      </div>
    </li>
  )
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function DayList({ group, now }: { group: DayGroup; now: number }) {
  const id = `dia-${group.day}`
  const today = group.when === 'hoy'
  const past = group.when === 'pasado'
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className={`px-4 md:px-0 mb-2 flex items-center gap-2 text-[14px] font-semibold ${past ? 'text-[#94A3B8]' : today ? 'text-[#1D4ED8]' : 'text-[#334155]'}`}>
        {today && <span className="inline-flex items-center h-6 px-2 rounded-full bg-[#2563EB] text-white text-[12px] font-semibold">Hoy</span>}
        <span>{capitalize(formatDayHeading(group.day, now))}</span>
      </h2>
      <ul className={`bg-white border-y md:border md:rounded-lg overflow-hidden divide-y divide-[#F1F5F9] ${today ? 'border-[#93C5FD] md:border-2' : 'border-[#E5E7EB]'}`}>
        {group.events.map(event => <EventRow key={event.id} event={event} now={now} />)}
      </ul>
    </section>
  )
}

// Lo próximo que más importa: el siguiente de Registro Escolar (o el siguiente de cualquier categoría).
function NextUp({ upcoming, now }: { upcoming: DayGroup[]; now: number }) {
  const next = upcoming.filter(g => g.when === 'proximo').flatMap(g => g.events)
  const event = next.find(isSchoolRecord) ?? next[0]
  if (!event) return null
  return (
    <div className="mx-4 md:mx-0 rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] p-4 flex items-start gap-3">
      <span className="w-10 h-10 rounded-full bg-white text-[#2563EB] flex items-center justify-center flex-shrink-0">{I.calendar(18)}</span>
      <div className="min-w-0">
        <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[#1D4ED8]">
          {isSchoolRecord(event) ? 'Próxima fecha de Registro Escolar' : 'Próximo evento'}
        </p>
        <p className="text-[16px] font-semibold text-[#111827] mt-0.5 break-words">{event.title}</p>
        <p className="text-[13px] text-[#334155] mt-0.5">
          <strong className="font-semibold">{relativeLabel(event, now)}</strong> · {formatShortDay(eventDays(event).start, now)}
        </p>
      </div>
    </div>
  )
}

export function CalendarPage({ state, onRetry, now = Date.now() }: { state: CalendarState; onRetry: () => void; now?: number }) {
  const [showPast, setShowPast] = useState(false)
  const { status, events } = state
  const refreshing = status === 'loading' && events.length > 0
  const { past, upcoming } = splitGroups(groupByDate(events, now))
  const pastCount = past.reduce((n, g) => n + g.events.length, 0)
  const range = state.from && state.to ? `${formatShortDay(state.from, now)} al ${formatShortDay(state.to, now)}` : null
  const retry = <Button variant="secondary" onClick={onRetry}>{I.refresh()}Reintentar</Button>

  let body: ReactNode
  if ((status === 'loading' || status === 'idle') && events.length === 0) {
    body = (
      <div role="status" aria-label="Cargando calendario" className="bg-white border-y md:border md:rounded-lg border-[#E5E7EB]">
        <SkeletonList rows={5} />
      </div>
    )
  } else if (status === 'unavailable' && events.length === 0) {
    body = (
      <div className="px-4 md:px-0">
        <Notice tone="blue" title="El calendario académico aún no está disponible" action={retry}>
          Estamos terminando de prepararlo en el servidor. Tus demás secciones funcionan normal; vuelve a intentarlo más tarde.
        </Notice>
      </div>
    )
  } else if (status === 'error' && events.length === 0) {
    body = (
      <div className="px-4 md:px-0">
        <Notice tone="red" title="No pudimos cargar el calendario" action={retry}>Revisa tu conexión e intenta de nuevo.</Notice>
      </div>
    )
  } else if (events.length === 0) {
    body = (
      <div className="px-4 md:px-0">
        <Notice title="Sin eventos en estas fechas" action={retry}>
          No hay fechas del calendario académico {range ? `del ${range}` : 'en este periodo'}. Cuando ITSON publique nuevas fechas aparecerán aquí.
        </Notice>
      </div>
    )
  } else {
    body = (
      <div className="space-y-5">
        {(status === 'error' || status === 'unavailable') && (
          <div className="px-4 md:px-0">
            <Notice tone="red" title="No pudimos actualizar el calendario" action={retry}>Te mostramos lo último que cargamos.</Notice>
          </div>
        )}
        <NextUp upcoming={upcoming} now={now} />
        {pastCount > 0 && (
          <div className="px-4 md:px-0">
            <button onClick={() => setShowPast(v => !v)} aria-expanded={showPast} aria-controls="eventos-pasados"
              className={`inline-flex items-center gap-1.5 min-h-11 px-3 -ml-3 rounded-lg text-[14px] font-medium text-[#64748B] hover:text-[#111827] cursor-pointer ${focusRing}`}>
              <span className={`transition-transform ${showPast ? 'rotate-90' : ''}`}>{I.chevron()}</span>
              {showPast ? 'Ocultar' : 'Ver'} eventos pasados ({pastCount})
            </button>
          </div>
        )}
        {showPast && (
          <div id="eventos-pasados" className="space-y-5 opacity-90">
            {past.map(g => <DayList key={g.day} group={g} now={now} />)}
          </div>
        )}
        {upcoming.length === 0 ? (
          <div className="px-4 md:px-0">
            <Notice title="No hay fechas próximas">
              Todos los eventos {range ? `del ${range}` : 'de este periodo'} ya pasaron. Cuando ITSON publique nuevas fechas aparecerán aquí.
            </Notice>
          </div>
        ) : upcoming.map(g => <DayList key={g.day} group={g} now={now} />)}
      </div>
    )
  }

  return (
    <div className="py-5 md:px-8 md:py-8 lg:px-10 max-w-2xl">
      <div className="px-4 md:px-0 mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[24px] md:text-[32px] leading-tight font-semibold text-[#111827] tracking-[-0.02em]">Calendario</h1>
          <p className="text-[14px] text-[#64748B] mt-1">
            Fechas del calendario académico de ITSON{range ? `, del ${range}` : ''}. Horas de Hermosillo.
          </p>
        </div>
        {refreshing && (
          <span role="status" className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-[#64748B] whitespace-nowrap">
            <span className="motion-safe:animate-spin">{I.refresh(14)}</span>Actualizando
          </span>
        )}
      </div>
      {body}
    </div>
  )
}
