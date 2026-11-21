import { useState, type ReactElement, type ReactNode } from 'react'
import { I } from '@/components/icons'
import { Button, SkeletonList } from '@/components/ui'
import type { Course, CourseItem, CourseSource, IvirtualLink } from '@/services/api'
import {
  classifyItem, CLASSROOM_TASKS_NOTICE, courseSources, emptyCourseNotice, finalGradeLabel, formatDue, formatGrade, groupItems, hasFinalGrade, itsonSemesters, periodLabel, sourceSections,
  SOURCE_LABEL, SOURCE_ORDER, type ItemStatus, type SemesterCourse,
} from '@/utils/courses'
import { focusRing } from '@/utils/styles'
import type { CourseItemsEntry, CoursesState, Page } from '@/types'

/* ITN-58 - "Mis materias y tareas". Mismo esquema que Notificaciones: en móvil lista o
   detalle; en lg: lado a lado. Los datos y las peticiones viven en App.
   ITN-58b - Una materia que está en varias fuentes es una sola tarjeta con sus fuentes
   como indicadores; su detalle tiene una sección por fuente con datos.
   ITN-58c - Las secciones por plataforma son plegables y empiezan cerradas. La de la
   API de ITSON es el historial de calificaciones: una subsección plegable por
   semestre con todas las materias que tienen fuente itson_api (también las
   unificadas, que en iVirtual o Classroom siguen saliendo con sus indicadores). */

const SOURCE_STYLE: Record<CourseSource, { icon: (s?: number) => ReactElement; color: string; bg: string }> = {
  ivirtual: { icon: I.chart, color: '#16A34A', bg: '#F0FDF4' },
  classroom: { icon: I.book, color: '#7C3AED', bg: '#F5F3FF' },
  itson_api: { icon: I.file, color: '#2563EB', bg: '#EFF6FF' },
}

// [H1] Texto + icono + color: el estado se entiende aunque no se distinga el color.
const STATUS_CFG: Record<ItemStatus, { title: string; tag: string; icon: ReactElement; text: string; bg: string; border: string }> = {
  vencida: { title: 'Vencidas', tag: 'Vencida', icon: I.alert(14), text: 'text-[#B91C1C]', bg: 'bg-[#FEF2F2]', border: 'border-[#FECACA]' },
  proxima: { title: 'Próximas', tag: 'Próxima', icon: I.clock(14), text: 'text-[#1D4ED8]', bg: 'bg-[#EFF6FF]', border: 'border-[#BFDBFE]' },
  calificada: { title: 'Calificadas', tag: 'Calificada', icon: I.check(14), text: 'text-[#15803D]', bg: 'bg-[#F0FDF4]', border: 'border-[#BBF7D0]' },
  sin_fecha: { title: 'Sin fecha', tag: 'Sin fecha', icon: I.info(14), text: 'text-[#475569]', bg: 'bg-[#F1F5F9]', border: 'border-[#E2E8F0]' },
}

function SourceIcon({ source, size = 40 }: { source: CourseSource; size?: number }) {
  const { icon, color, bg } = SOURCE_STYLE[source]
  return (
    <span className="flex-shrink-0 rounded-full flex items-center justify-center" style={{ width: size, height: size, backgroundColor: bg, color }}>
      {icon(Math.round(size * 0.45))}
    </span>
  )
}

const courseMeta = (c: Course) => [SOURCE_LABEL[c.source], periodLabel(c)].filter(Boolean).join(' · ')

const isUnified = (c: Course) => courseSources(c).length > 1

// ITN-58b - Indicadores de fuente: texto + punto de color, legibles sin distinguir el color.
function SourceBadges({ course }: { course: Course }) {
  const fuentes = courseSources(course)
  return (
    <span className="flex flex-wrap gap-1.5 mt-1" aria-label={`Fuentes: ${fuentes.map(f => SOURCE_LABEL[f.source]).join(', ')}`}>
      {fuentes.map(f => (
        <span key={f.source} data-source={f.source}
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full text-[11px] font-medium"
          style={{ backgroundColor: SOURCE_STYLE[f.source].bg, color: SOURCE_STYLE[f.source].color }}>
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: SOURCE_STYLE[f.source].color }} />
          {SOURCE_LABEL[f.source]}
        </span>
      ))}
    </span>
  )
}

function CourseRow({ c, selected, onClick }: { c: Course; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-current={selected ? 'true' : undefined}
      className={`w-full text-left flex items-center gap-3 px-4 py-3.5 md:px-6 md:gap-4 transition-colors cursor-pointer group outline-none focus-visible:bg-[#EFF6FF] ${selected ? 'bg-[#EFF6FF]' : 'hover:bg-[#F8FAFC]'}`}>
      <SourceIcon source={c.source} />
      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-medium text-[#111827] truncate">{c.name}</p>
        {isUnified(c)
          ? <SourceBadges course={c} />
          : <p className="text-[13px] text-[#64748B] truncate mt-0.5">{courseMeta(c)}</p>}
      </div>
      {hasFinalGrade(c.finalGrade) && (
        <span className="flex-shrink-0 text-right">
          <span className="block text-[16px] font-semibold text-[#111827] leading-none">{c.finalGrade}</span>
          <span className="block text-[11px] text-[#94A3B8] mt-1">Final</span>
        </span>
      )}
      <span className={`flex-shrink-0 transition-colors ${selected ? 'text-[#2563EB]' : 'text-[#CBD5E1] group-hover:text-[#2563EB]'}`}>{I.chevron()}</span>
    </button>
  )
}

// ITN-58c - Encabezado plegable: botón con aria-expanded y aria-controls (Enter y
// Espacio funcionan por ser <button>). Cerrado solo se ve el encabezado.
function Collapsible({ id, open, onToggle, title, count, nested = false, children }: {
  id: string; open: boolean; onToggle: (id: string) => void; title: ReactNode; count: string; nested?: boolean; children: ReactNode
}) {
  const regionId = `${id}-contenido`
  return (
    <section data-collapsible={id} aria-labelledby={`${id}-titulo`}>
      <h2 className={nested ? 'text-[14px]' : 'text-[13px]'}>
        <button type="button" id={`${id}-titulo`} aria-expanded={open} aria-controls={regionId} onClick={() => onToggle(id)}
          className={`w-full flex items-center gap-2 min-h-11 text-left cursor-pointer ${focusRing} ${nested
            ? 'px-4 md:px-6 py-2 font-medium text-[#334155] hover:bg-[#F8FAFC]'
            : 'px-4 md:px-0 lg:px-6 font-semibold text-[#64748B] uppercase tracking-[0.04em] hover:text-[#111827]'}`}>
          <span className="flex-1 min-w-0 truncate">
            {title} <span className={`font-normal text-[#94A3B8] ${nested ? '' : 'normal-case tracking-normal'}`}>{count}</span>
          </span>
          <span aria-hidden="true" className={`flex-shrink-0 text-[#94A3B8] transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>{I.chevron()}</span>
        </button>
      </h2>
      <div id={regionId} hidden={!open}>
        {open && children}
      </div>
    </section>
  )
}

const materias = (n: number) => `${n} ${n === 1 ? 'materia' : 'materias'}`

// ITN-58c - Renglón del historial de ITSON: nombre y calificación final del semestre.
function SemesterCourseRow({ item, selected, onClick }: { item: SemesterCourse; selected: boolean; onClick: () => void }) {
  const grade = finalGradeLabel(item.entry.finalGrade)
  const sin = !hasFinalGrade(item.entry.finalGrade)
  return (
    <button onClick={onClick} aria-current={selected ? 'true' : undefined}
      className={`w-full text-left flex items-center gap-3 px-4 py-3 md:px-6 transition-colors cursor-pointer group outline-none focus-visible:bg-[#EFF6FF] ${selected ? 'bg-[#EFF6FF]' : 'hover:bg-[#F8FAFC]'}`}>
      <p className="flex-1 min-w-0 text-[15px] text-[#111827] truncate">{item.course.name}</p>
      <span className={`flex-shrink-0 text-right ${sin ? 'text-[13px] text-[#94A3B8]' : 'text-[16px] font-semibold text-[#111827]'}`}>{grade}</span>
      <span className={`flex-shrink-0 transition-colors ${selected ? 'text-[#2563EB]' : 'text-[#CBD5E1] group-hover:text-[#2563EB]'}`}>{I.chevron()}</span>
    </button>
  )
}

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

// [H9] El vacío dice por qué está vacío y qué hacer.
function EmptyCourses({ ivirtualLink, classroomConnected, onGo, onRetry }: {
  ivirtualLink: IvirtualLink | null; classroomConnected: boolean; onGo: (p: Page) => void; onRetry: () => void
}) {
  const toSettings = <Button variant="secondary" onClick={() => onGo('configuracion')}>{I.settings(18)}Ir a Configuración</Button>
  if (ivirtualLink?.linked) {
    return (
      <Notice tone="blue" title="Tu primera revisión aún no termina"
        action={<Button variant="secondary" onClick={onRetry}>{I.refresh()}Volver a revisar</Button>}>
        Tu cuenta de iVirtual ya está vinculada. Tus materias y tareas aparecen aquí cuando termine la primera revisión, que puede tardar un rato.
      </Notice>
    )
  }
  if (ivirtualLink && !ivirtualLink.linked) {
    return (
      <Notice title="Aún no vinculas iVirtual" action={toSettings}>
        Vincula tu cuenta de iVirtual en Configuración para ver tus materias, calificaciones y fechas de entrega.
        {!classroomConnected && ' También puedes conectar Google Classroom para ver tus cursos.'}
      </Notice>
    )
  }
  return (
    <Notice title="Todavía no tenemos materias tuyas" action={toSettings}>
      Revisa en Configuración que tu cuenta de iVirtual esté vinculada{classroomConnected ? '' : ' o conecta Google Classroom'}. Si ya lo hiciste, tus materias aparecen después de la primera revisión.
    </Notice>
  )
}

function CourseList({ state, selectedId, onOpen, onRetry, ivirtualLink, classroomConnected, onGo, open, onToggle }: {
  state: CoursesState; selectedId: string | null; onOpen: (id: string) => void; onRetry: () => void
  ivirtualLink: IvirtualLink | null; classroomConnected: boolean; onGo: (p: Page) => void
  open: Record<string, boolean>; onToggle: (id: string) => void
}) {
  const { status, courses } = state
  if ((status === 'loading' || status === 'idle') && courses.length === 0) {
    return <div className="bg-white border-y md:border md:rounded-lg lg:border-0 lg:border-t lg:rounded-none border-[#E5E7EB]"><SkeletonList rows={5} /></div>
  }
  if (status === 'error' && courses.length === 0) {
    return (
      <div className="px-4 md:px-0 lg:px-6">
        <Notice tone="red" title="No pudimos cargar tus materias" action={<Button variant="secondary" onClick={onRetry}>{I.refresh()}Reintentar</Button>}>
          Revisa tu conexión e intenta de nuevo.
        </Notice>
      </div>
    )
  }
  if (courses.length === 0) {
    return <div className="px-4 md:px-0 lg:px-6"><EmptyCourses ivirtualLink={ivirtualLink} classroomConnected={classroomConnected} onGo={onGo} onRetry={onRetry} /></div>
  }
  const pendingFirstRun = ivirtualLink?.linked && !courses.some(c => c.source === 'ivirtual')
  return (
    <div className="space-y-2 lg:space-y-0">
      {status === 'error' && (
        <div className="px-4 md:px-0 lg:px-6 lg:pb-4">
          <Notice tone="red" title="No pudimos actualizar tus materias" action={<Button variant="secondary" onClick={onRetry}>{I.refresh()}Reintentar</Button>}>
            Te mostramos lo último que cargamos.
          </Notice>
        </div>
      )}
      {pendingFirstRun && (
        <div className="px-4 md:px-0 lg:px-6 lg:pb-4">
          <Notice tone="blue" title="Tus materias de iVirtual aún no llegan">
            Aparecen aquí cuando termine la primera revisión de tu cuenta.
          </Notice>
        </div>
      )}
      {SOURCE_ORDER.map(source => {
        const id = `fuente-${source}`
        if (source === 'itson_api') {
          const semestres = itsonSemesters(courses)
          if (semestres.length === 0) return null
          const total = semestres.reduce((n, s) => n + s.courses.length, 0)
          return (
            <Collapsible key={source} id={id} open={Boolean(open[id])} onToggle={onToggle} title={SOURCE_LABEL[source]} count={String(total)}>
              <div className="mt-1 bg-white border-y md:border md:rounded-lg lg:border-x-0 lg:rounded-none border-[#E5E7EB] divide-y divide-[#F1F5F9]">
                {semestres.map(sem => {
                  const semId = `semestre-${sem.period ?? 'sin'}`
                  return (
                    <Collapsible key={semId} id={semId} nested open={Boolean(open[semId])} onToggle={onToggle}
                      title={sem.label} count={`· ${materias(sem.courses.length)}`}>
                      <ul className="divide-y divide-[#F1F5F9] border-t border-[#F1F5F9] bg-[#FCFDFE]">
                        {sem.courses.map(item => (
                          <li key={`${item.entry.id}-${item.course.id}`}>
                            <SemesterCourseRow item={item} selected={selectedId === item.course.id} onClick={() => onOpen(item.course.id)} />
                          </li>
                        ))}
                      </ul>
                    </Collapsible>
                  )
                })}
              </div>
            </Collapsible>
          )
        }
        const group = courses.filter(c => c.source === source)
        if (group.length === 0) return null
        return (
          <Collapsible key={source} id={id} open={Boolean(open[id])} onToggle={onToggle} title={SOURCE_LABEL[source]} count={String(group.length)}>
            <ul className="mt-1 bg-white border-y md:border md:rounded-lg lg:border-x-0 lg:rounded-none border-[#E5E7EB] divide-y divide-[#F1F5F9]">
              {group.map(c => (
                <li key={`${c.source}-${c.id}`}><CourseRow c={c} selected={selectedId === c.id} onClick={() => onOpen(c.id)} /></li>
              ))}
            </ul>
          </Collapsible>
        )
      })}
    </div>
  )
}

function ItemRow({ item, status, now }: { item: CourseItem; status: ItemStatus; now: number }) {
  const cfg = STATUS_CFG[status]
  const due = formatDue(item.dueAt, now)
  const grade = formatGrade(item)
  return (
    <li className="flex items-start gap-3 px-4 py-3.5">
      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-medium text-[#111827] break-words">{item.label || 'Actividad sin nombre'}</p>
        <p className="text-[13px] text-[#64748B] mt-0.5">{due ? `Entrega: ${due}` : 'Sin fecha de entrega'}</p>
      </div>
      <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
        <span className={`text-[14px] ${grade === 'Sin calificar' ? 'text-[#94A3B8]' : 'font-semibold text-[#111827]'}`}>{grade}</span>
        <span className={`inline-flex items-center gap-1 h-6 px-2 rounded-full border text-[12px] font-medium ${cfg.text} ${cfg.bg} ${cfg.border}`}>
          {cfg.icon}{cfg.tag}
        </span>
      </div>
    </li>
  )
}

function ItemGroups({ items, now, idPrefix }: { items: CourseItem[]; now: number; idPrefix: string }) {
  return (
    <>
      {groupItems(items, now).map(g => {
        const cfg = STATUS_CFG[g.status]
        return (
          <section key={g.status} aria-labelledby={`${idPrefix}-${g.status}`}>
            <h2 id={`${idPrefix}-${g.status}`} className={`flex items-center gap-1.5 mb-2 text-[14px] font-semibold ${cfg.text}`}>
              {cfg.icon}{cfg.title}<span className="font-normal text-[#94A3B8]">{g.items.length}</span>
            </h2>
            <ul className={`bg-white border rounded-lg divide-y divide-[#F1F5F9] ${cfg.border}`}>
              {g.items.map(item => <ItemRow key={item.id} item={item} status={classifyItem(item, now)} now={now} />)}
            </ul>
          </section>
        )
      })}
    </>
  )
}

function ClassroomNote() {
  return (
    <p className="flex items-start gap-2 text-[12px] leading-relaxed text-[#94A3B8]">
      <span className="mt-0.5 flex-shrink-0">{I.info()}</span>
      Google Classroom no nos dice si ya entregaste una tarea: “Vencida” solo significa que pasó la fecha de entrega.
    </p>
  )
}

function FinalGrade({ value: raw }: { value: string | null }) {
  const value = hasFinalGrade(raw) ? raw.trim() : null
  return (
    <dl className="bg-white border border-[#E5E7EB] rounded-lg">
      <div className="flex justify-between items-center gap-4 px-4 py-3">
        <dt className="text-[13px] text-[#64748B]">Calificación final</dt>
        <dd className={`text-[16px] text-right ${value ? 'font-semibold text-[#111827]' : 'text-[#94A3B8]'}`}>{value ?? 'Aún sin calificación'}</dd>
      </div>
    </dl>
  )
}

// ITN-58b - Detalle de una materia unificada: una sección por fuente con datos (las
// vacías no se muestran). Los items vienen juntos de /items, cada uno con su fuente.
function UnifiedCourseDetail({ course, entry, now, onBack, onRetry }: {
  course: Course; entry: CourseItemsEntry | undefined; now: number; onBack: () => void; onRetry: () => void
}) {
  const fuentes = courseSources(course)
  const conTareas = fuentes.some(f => f.source !== 'itson_api')
  const cargando = conTareas && (!entry || entry.status === 'loading')
  const fallo = conTareas && entry?.status === 'error'
  const perdida = conTareas && entry?.status === 'missing'
  const secciones = sourceSections(course, entry?.status === 'ready' ? entry.items : [])
  return (
    <article className="px-4 py-4 md:px-8 md:py-8 max-w-2xl lg:mx-auto w-full">
      <button onClick={onBack} className={`lg:hidden -ml-2 mb-4 flex items-center gap-2 min-h-11 px-2 rounded-lg text-[15px] font-medium text-[#64748B] hover:text-[#111827] cursor-pointer ${focusRing}`}>
        {I.arrow()}Materias
      </button>

      <div className="flex items-start gap-4">
        <SourceIcon source={course.source} size={48} />
        <div className="min-w-0 pt-0.5">
          <h1 className="text-[20px] md:text-[22px] leading-snug font-semibold text-[#111827] tracking-[-0.01em] break-words">{course.name}</h1>
          <p className="text-[13px] text-[#94A3B8] mt-1">Desde {fuentes.map(f => SOURCE_LABEL[f.source]).join(' · ')}</p>
        </div>
      </div>

      <div className="mt-6 space-y-8">
        {fallo && (
          <Notice tone="red" title="No pudimos cargar las tareas de esta materia" action={<Button variant="secondary" onClick={onRetry}>{I.refresh()}Reintentar</Button>}>
            Revisa tu conexión e intenta de nuevo.
          </Notice>
        )}
        {perdida && (
          <Notice tone="red" title="Esta materia ya no está disponible">
            Puede que se haya actualizado tu lista de materias. Vuelve a la lista para ver la versión más reciente.
          </Notice>
        )}
        {cargando ? (
          <div className="bg-white border border-[#E5E7EB] rounded-lg overflow-hidden" role="status" aria-label="Cargando tareas"><SkeletonList rows={3} /></div>
        ) : secciones.length === 0 && !fallo && !perdida ? (
          <Notice title={emptyCourseNotice(course).title}>
            {emptyCourseNotice(course).body}
          </Notice>
        ) : (
          secciones.map(({ entry: fuente, items }) => {
            const periodo = periodLabel(fuente)
            return (
              <section key={fuente.source} data-source={fuente.source} aria-labelledby={`detalle-${fuente.source}`} className="space-y-4">
                <h2 id={`detalle-${fuente.source}`} className="flex items-center gap-2 text-[15px] font-semibold text-[#111827]">
                  <SourceIcon source={fuente.source} size={28} />
                  {SOURCE_LABEL[fuente.source]}
                  {periodo && <span className="font-normal text-[13px] text-[#94A3B8]">{periodo}</span>}
                </h2>
                {fuente.source !== 'classroom' && <FinalGrade value={fuente.finalGrade} />}
                {items.length > 0 && <div className="space-y-5"><ItemGroups items={items} now={now} idPrefix={`grupo-${fuente.source}`} /></div>}
                {fuente.source === 'classroom' && <ClassroomNote />}
              </section>
            )
          })
        )}
        {/* Classroom sin tareas sincronizadas junto a otras fuentes con datos: se aclara que aún no llegan. */}
        {!cargando && secciones.length > 0 && fuentes.some(f => f.source === 'classroom') && !secciones.some(s => s.entry.source === 'classroom') && (
          <Notice title={CLASSROOM_TASKS_NOTICE.title}>{CLASSROOM_TASKS_NOTICE.body}</Notice>
        )}
      </div>
    </article>
  )
}

function CourseDetail({ course, entry, now, onBack, onRetry }: {
  course: Course; entry: CourseItemsEntry | undefined; now: number; onBack: () => void; onRetry: () => void
}) {
  if (isUnified(course)) return <UnifiedCourseDetail course={course} entry={entry} now={now} onBack={onBack} onRetry={onRetry} />
  const groups = entry?.status === 'ready' ? groupItems(entry.items, now) : []
  return (
    <article className="px-4 py-4 md:px-8 md:py-8 max-w-2xl lg:mx-auto w-full">
      <button onClick={onBack} className={`lg:hidden -ml-2 mb-4 flex items-center gap-2 min-h-11 px-2 rounded-lg text-[15px] font-medium text-[#64748B] hover:text-[#111827] cursor-pointer ${focusRing}`}>
        {I.arrow()}Materias
      </button>

      <div className="flex items-start gap-4">
        <SourceIcon source={course.source} size={48} />
        <div className="min-w-0 pt-0.5">
          <h1 className="text-[20px] md:text-[22px] leading-snug font-semibold text-[#111827] tracking-[-0.01em] break-words">{course.name}</h1>
          <p className="text-[13px] text-[#94A3B8] mt-1">Desde {courseMeta(course)}</p>
        </div>
      </div>

      {course.source !== 'classroom' && <div className="mt-5"><FinalGrade value={course.finalGrade} /></div>}

      <div className="mt-6">
        {course.source === 'itson_api' ? (
          <Notice title="Solo calificación final">
            De la API de ITSON solo se reporta la calificación final de cada materia. Las tareas y actividades se ven en las materias de iVirtual.
          </Notice>
        ) : !entry || entry.status === 'loading' ? (
          <div className="bg-white border border-[#E5E7EB] rounded-lg overflow-hidden" role="status" aria-label="Cargando tareas"><SkeletonList rows={3} /></div>
        ) : entry.status === 'error' ? (
          <Notice tone="red" title="No pudimos cargar las tareas de esta materia" action={<Button variant="secondary" onClick={onRetry}>{I.refresh()}Reintentar</Button>}>
            Revisa tu conexión e intenta de nuevo.
          </Notice>
        ) : entry.status === 'missing' ? (
          <Notice tone="red" title="Esta materia ya no está disponible">
            Puede que se haya actualizado tu lista de materias. Vuelve a la lista para ver la versión más reciente.
          </Notice>
        ) : groups.length === 0 ? (
          <Notice title={emptyCourseNotice(course).title}>
            {emptyCourseNotice(course).body}
          </Notice>
        ) : (
          <div className="space-y-5">
            <ItemGroups items={entry.items} now={now} idPrefix="grupo" />
            {course.source === 'classroom' && <ClassroomNote />}
          </div>
        )}
      </div>
    </article>
  )
}

export function CoursesPage({ state, itemsById, selectedId, onOpen, onClose, onRetry, onRetryItems, onGo, ivirtualLink, classroomConnected, now = Date.now() }: {
  state: CoursesState; itemsById: Record<string, CourseItemsEntry>; selectedId: string | null
  onOpen: (id: string) => void; onClose: () => void; onRetry: () => void; onRetryItems: (id: string) => void; onGo: (p: Page) => void
  ivirtualLink: IvirtualLink | null; classroomConnected: boolean; now?: number
}) {
  const selected = state.courses.find(c => c.id === selectedId) ?? null
  // ITN-58c - Secciones y semestres abiertos; todo empieza cerrado.
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const toggle = (id: string) => setOpen(o => ({ ...o, [id]: !o[id] }))
  const refreshing = state.status === 'loading' && state.courses.length > 0

  return (
    <div className="lg:flex lg:h-dvh">
      <section className={`${selected ? 'hidden lg:flex' : 'flex'} flex-col lg:w-[420px] lg:flex-shrink-0 lg:border-r border-[#E5E7EB] lg:bg-white`}>
        <div className="px-4 pt-5 pb-4 md:px-8 md:pt-8 lg:px-6 lg:pt-7">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-[24px] md:text-[28px] leading-tight font-semibold text-[#111827] tracking-[-0.02em]">Materias</h1>
              <p className="hidden md:block text-[14px] text-[#64748B] mt-1">Calificaciones, tareas y fechas de entrega.</p>
            </div>
            {/* [H1] Se ve que la lista se está actualizando sin taparla */}
            {refreshing && (
              <span role="status" className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-[#64748B] whitespace-nowrap">
                <span className="motion-safe:animate-spin">{I.refresh(14)}</span>Actualizando
              </span>
            )}
          </div>
        </div>
        <div className="pb-6 md:px-8 lg:px-0 lg:flex-1 lg:overflow-y-auto">
          <CourseList state={state} selectedId={selectedId} onOpen={onOpen} onRetry={onRetry}
            ivirtualLink={ivirtualLink} classroomConnected={classroomConnected} onGo={onGo} open={open} onToggle={toggle} />
        </div>
      </section>

      <section className={`${selected ? 'block' : 'hidden lg:flex'} lg:flex-1 lg:overflow-y-auto bg-white lg:bg-[#F8FAFC] min-h-[calc(100dvh-57px)] md:min-h-dvh lg:min-h-0`}>
        {selected ? (
          <CourseDetail course={selected} entry={itemsById[selected.id]} now={now} onBack={onClose} onRetry={() => onRetryItems(selected.id)} />
        ) : (
          <div className="m-auto flex flex-col items-center gap-3 p-8 text-[#64748B]">
            <span className="opacity-20">{I.bookOpen(36)}</span>
            <p className="text-[14px] text-center">Selecciona una materia para ver sus tareas y calificaciones.</p>
          </div>
        )}
      </section>
    </div>
  )
}
