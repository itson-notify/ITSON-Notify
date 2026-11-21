import { useEffect, useState } from 'react'
import { AppLayout } from '@/layouts/AppLayout'
import { ConfirmDialog, HelpSheet, ToastView } from '@/components/overlays'
import { IvirtualLinkSheet } from '@/components/IvirtualLinkSheet'
import { ItsonProfileForm } from '@/components/ItsonProfileForm'
import { Sheet, Spinner } from '@/components/ui'
import { Onboarding } from '@/pages/Onboarding'
import { HomePage } from '@/pages/HomePage'
import { NotificationsPage } from '@/pages/NotificationsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { ProfilePage } from '@/pages/ProfilePage'
import { CoursesPage } from '@/pages/CoursesPage'
import { CalendarPage } from '@/pages/CalendarPage'
import { DEFAULT_SETTINGS, INITIAL_NOTIFS, STUDENT } from '@/services/mockData'
import {
  ApiError, EMPTY_ITSON_PROFILE, deleteItsonProfile, getCalendar, getCourseItems, getCourses, getItsonProfile, getIvirtualLink, getMe, getNotifications, markAllRead,
  markRead, unlinkIvirtual, type Course, type ItsonProfile, type IvirtualLink,
  TASKS_AUTH_OFF, getTasksAuthorization, disableTasksAuthorization, type TasksAuthorization,
  tasksDemoState, setMockTasksAuthorization,
} from '@/services/api'
import { mockMode } from '@/services/backend'
import { activateClassroomTasks, connectGoogle, googleSession, logoutGoogle, tasksResultMessage } from '@/services/googleAuth'
import { unsubscribeBrowserPush } from '@/services/pushNotifications'
import { studentView } from '@/utils/student'
import { calendarWindow } from '@/utils/calendar'
import { courseHasItems } from '@/utils/courses'
import type { CalendarState, ConfirmReq, CourseItemsEntry, CoursesState, Filter, Notif, Notify, Page, Settings, SyncProps } from '@/types'

/* ════════════════════════════════════════════════════════════════════════════
   ITSON Notify — frontend mobile-first
   Estilos base = teléfono. `md:` (≥768px) agrega sidebar. `lg:` (≥1024px)
   muestra lista + detalle lado a lado.

   Revisado con las 10 heurísticas de Nielsen: los comentarios [H1]…[H10]
   marcan dónde se aplica cada una.
   ════════════════════════════════════════════════════════════════════════════ */

// Sin mock, las notificaciones solo existen si llegan del backend.
const EMPTY_NOTIFS = mockMode ? INITIAL_NOTIFS : []
const EMPTY_COURSES: CoursesState = { status: 'idle', courses: [] }
const EMPTY_CALENDAR: CalendarState = { status: 'idle', events: [], from: null, to: null }

// ITN-58 - Sube al cerrar la sesión: una respuesta que llega después no se aplica.
let sessionEpoch = 0

export default function App() {
  const [onboarded, setOnboarded] = useState(false)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [notifs, setNotifs] = useState<Notif[]>(EMPTY_NOTIFS)
  const [page, setPage] = useState<Page>('inicio')
  const [filter, setFilter] = useState<Filter>('todas')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [firstRun, setFirstRun] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  // ITN-51 - Estado real de la vinculación de iVirtual; null mientras no se conoce (o en mock).
  const [ivirtualLink, setIvirtualLink] = useState<IvirtualLink | null>(null)
  // ITN-55 - Perfil ITSON (matrícula y carrera) de /api/itson-profile; null si no se pudo
  // leer. Solo trae la pista de la matrícula, nunca la completa.
  const [itsonProfile, setItsonProfile] = useState<ItsonProfile | null>(mockMode ? EMPTY_ITSON_PROFILE : null)
  const [profileOpen, setProfileOpen] = useState(false)
  // ITN-43c - Autorización opcional de tareas de Classroom (apagada mientras no se sabe).
  const [tasksAuth, setTasksAuth] = useState<TasksAuthorization>(TASKS_AUTH_OFF)
  const [helpQuery, setHelpQuery] = useState<string | null>(null)
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null)
  const [toast, setToast] = useState<{ id: number; text: string; undo?: () => void } | null>(null)
  const [promptDismissed, setPromptDismissed] = useState(false)
  // ITN-58 - Materias y sus tareas (en memoria; las tareas se piden al abrir cada materia).
  const [coursesState, setCoursesState] = useState<CoursesState>(EMPTY_COURSES)
  const [courseItems, setCourseItems] = useState<Record<string, CourseItemsEntry>>({})
  const [courseId, setCourseId] = useState<string | null>(null)
  // ITN-61 - Calendario académico (en memoria, como las materias).
  const [calendarState, setCalendarState] = useState<CalendarState>(EMPTY_CALENDAR)
  // ITN-58 - Correo de la sesión (/api/me o Google). Sin mock es lo único que se sabe
  // del alumno además de la carrera: la API no da el nombre.
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Evita mostrar Onboarding un instante a quien ya tiene sesión. Al volver de Google
  // no se espera: Onboarding debe leer `from` de la URL antes de que se limpie.
  const [checkingSession, setCheckingSession] = useState(() =>
    !mockMode && !new URLSearchParams(window.location.search).get('classroom') &&
    !new URLSearchParams(window.location.search).get('tareas'))

  const notify: Notify = (text, undo) => {
    const id = Date.now()
    setToast({ id, text, undo })
    setTimeout(() => setToast(t => (t?.id === id ? null : t)), 6000)
  }

  const endSession = () => {
    setOnboarded(false); setSettings(DEFAULT_SETTINGS); setNotifs(EMPTY_NOTIFS)
    setPage('inicio'); setFilter('todas'); setSelectedId(null); setPromptDismissed(false)
    setIvirtualLink(null); setLinkOpen(false)
    setItsonProfile(mockMode ? EMPTY_ITSON_PROFILE : null); setProfileOpen(false)
    sessionEpoch++
    setCoursesState(EMPTY_COURSES); setCourseItems({}); setCourseId(null); setSessionEmail(null)
    setCalendarState(EMPTY_CALENDAR)
    setTasksAuth(TASKS_AUTH_OFF)
  }
  // Un 401 significa que la sesión ya no sirve: se vuelve a Onboarding.
  const sessionExpired = () => {
    endSession()
    notify('Tu sesión expiró. Vuelve a entrar con Google.')
  }
  const apiFailed = (error: unknown, text: string) => {
    if (error instanceof ApiError && error.status === 401) sessionExpired()
    else notify(text)
  }
  // ITN-51 - itsonStatus sigue a la vinculación: needs_relink es error.
  const applyIvirtualLink = (link: IvirtualLink) => {
    setIvirtualLink(link)
    setSettings(s => ({ ...s, itsonStatus: link.status === 'needs_relink' ? 'error' : 'ok' }))
  }
  const loadFromApi = () => {
    setLoading(true)
    Promise.all([getMe(), getNotifications()])
      .then(([me, list]) => {
        setNotifs(list)
        setSessionEmail(me.email)
        setSettings(s => ({
          ...s, email: me.email, classroomEmail: me.email,
          classroomConnected: me.classroomConnected, itsonStatus: me.itsonStatus,
        }))
      })
      .catch(error => apiFailed(error, 'No se pudieron cargar tus notificaciones'))
      .finally(() => setLoading(false))
    // Aparte: si falla, Ajustes muestra el estado como desconocido sin romper la carga.
    getIvirtualLink().then(setIvirtualLink).catch(() => setIvirtualLink(null))
    // ITN-55 - Igual: si falla, Ajustes dice que el estado no está disponible.
    getItsonProfile().then(setItsonProfile).catch(() => setItsonProfile(null))
    // ITN-43c - Si falla, la tarjeta de tareas no se muestra; el resto sigue igual.
    getTasksAuthorization().then(setTasksAuth).catch(() => setTasksAuth(TASKS_AUTH_OFF))
  }

  // ITN-58 - Materias. Se piden al entrar a la pantalla (y al volver a entrar); si ya hay
  // una petición en curso no se repite. Sin mock, getCourses solo usa la API.
  const loadCourses = () => {
    if (coursesState.status === 'loading') return
    const epoch = sessionEpoch
    setCoursesState(s => ({ ...s, status: 'loading' }))
    getCourses()
      .then(courses => {
        if (epoch !== sessionEpoch) return
        setCoursesState({ status: 'ready', courses })
        // Las tareas guardadas solo sirven si la materia sigue igual que cuando se pidieron.
        setCourseItems(cache => Object.fromEntries(Object.entries(cache).filter(([id, entry]) =>
          entry.status !== 'error' && courses.some(c => c.id === id && c.updatedAt === entry.updatedAt))))
        setCourseId(id => (id && courses.some(c => c.id === id) ? id : null))
      })
      .catch(error => {
        if (epoch !== sessionEpoch) return
        if (error instanceof ApiError && error.status === 401) sessionExpired()
        else setCoursesState(s => ({ ...s, status: 'error' }))
      })
  }
  const loadCourseItems = (course: Course) => {
    const epoch = sessionEpoch
    const { id, updatedAt } = course
    setCourseItems(c => ({ ...c, [id]: { status: 'loading', items: [], updatedAt } }))
    getCourseItems(id)
      .then(items => {
        if (epoch === sessionEpoch) setCourseItems(c => ({ ...c, [id]: { status: 'ready', items, updatedAt } }))
      })
      .catch(error => {
        if (epoch !== sessionEpoch) return
        if (error instanceof ApiError && error.status === 401) return sessionExpired()
        const status = error instanceof ApiError && error.status === 404 ? 'missing' : 'error'
        setCourseItems(c => ({ ...c, [id]: { status, items: [], updatedAt } }))
      })
  }
  const openCourse = (id: string) => {
    const course = coursesState.courses.find(c => c.id === id)
    if (!course) return
    setCourseId(id)
    window.scrollTo(0, 0)
    // itson_api siempre responde { items: [] }: solo tiene calificación final. Una
    // materia unificada (ITN-58b) sí se pide si alguna de sus fuentes tiene tareas.
    if (!courseHasItems(course)) return
    const cached = courseItems[id]
    if (cached && cached.updatedAt === course.updatedAt && (cached.status === 'ready' || cached.status === 'loading')) return
    loadCourseItems(course)
  }
  const retryCourseItems = (id: string) => {
    const course = coursesState.courses.find(c => c.id === id)
    if (course && courseItems[id]?.status !== 'loading') loadCourseItems(course)
  }

  // ITN-61 - Calendario. Se pide al entrar a la pantalla (y al volver a entrar) con la
  // ventana de calendarWindow; si ya hay una petición en curso no se repite. Mientras
  // carga o si falla, se conserva la última lista buena. Sin mock, getCalendar solo usa la API.
  const loadCalendar = () => {
    if (calendarState.status === 'loading') return
    const epoch = sessionEpoch
    const { from, to } = calendarWindow(Date.now())
    setCalendarState(s => ({ ...s, status: 'loading' }))
    getCalendar(from, to)
      .then(events => {
        if (epoch === sessionEpoch) setCalendarState({ status: 'ready', events, from, to })
      })
      .catch(error => {
        if (epoch !== sessionEpoch) return
        if (error instanceof ApiError && error.status === 401) return sessionExpired()
        const unavailable = error instanceof ApiError && error.status === 503 && error.code === 'calendario_no_disponible'
        setCalendarState(s => ({ ...s, status: unavailable ? 'unavailable' : 'error' }))
      })
  }

  // ITN-55 - Quitar la matrícula con confirmación. Un 404 es "ya no estaba".
  const removeItsonProfile = () => setConfirmReq({
    title: '¿Quitar tu matrícula?',
    body: 'Dejaremos de avisarte tus calificaciones finales desde el portal de ITSON. Puedes volver a agregarla cuando quieras.',
    label: 'Quitar', danger: true,
    onConfirm: async () => {
      try {
        const result = await deleteItsonProfile()
        setItsonProfile(EMPTY_ITSON_PROFILE)
        notify(result === 'already_deleted' ? 'Tu matrícula ya no estaba guardada' : 'Matrícula quitada')
      } catch (error) { apiFailed(error, 'No se pudo quitar tu matrícula') }
    },
  })

  // ITN-51 - Desvincular con confirmación. Un 404 es "ya estaba desvinculada".
  const unlinkItson = () => setConfirmReq({
    title: '¿Desvincular tu cuenta de iVirtual?',
    body: 'Dejaremos de revisar tus calificaciones. Para volver a vincularla tendrás que escribir tu contraseña otra vez.',
    label: 'Desvincular', danger: true,
    onConfirm: async () => {
      try {
        const result = await unlinkIvirtual()
        applyIvirtualLink({ available: ivirtualLink?.available ?? false, linked: false, status: null, lastValidatedAt: null })
        notify(result === 'already_unlinked' ? 'Tu cuenta de iVirtual ya estaba desvinculada' : 'Cuenta de iVirtual desvinculada')
      } catch (error) { apiFailed(error, 'No se pudo desvincular tu cuenta de iVirtual') }
    },
  })

  // [H3] Esc cierra el detalle abierto (si no hay un diálogo encima)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || linkOpen || confirmReq || helpQuery !== null) return
      if (selectedId !== null) setSelectedId(null)
      setCourseId(null)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [selectedId, linkOpen, confirmReq, helpQuery])

  // ITN-41 - La conexión se consulta en el backend; los parámetros de retorno
  // solo sirven para mostrar el resultado, nunca para autenticar al alumno.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const result = params.get('classroom')
    const from = params.get('from')
    // ITN-43c - Resultado de activar las tareas de Classroom desde Ajustes.
    const tareas = params.get('tareas')
    // La procedencia restaura la navegación, nunca autentica al estudiante.
    // También al cancelar o fallar la consulta de sesión se vuelve a Configuración.
    if ((result && from === 'settings') || tareas) { setOnboarded(true); setPage('configuracion') }
    googleSession()
      .then(session => {
        if (session.connected && session.email) {
          if (!mockMode) setSessionEmail(session.email)
          setSettings(s => ({
            ...s, classroomConnected: true, classroomEmail: session.email!,
            categories: { ...s.categories, tareas: true },
          }))
          if (!mockMode) {
            // Quien vuelve de Google a medio Onboarding termina sus pasos.
            if (from !== 'onboarding') setOnboarded(true)
            loadFromApi()
          }
          if (result === 'auth_success') {
            notify('Google Classroom conectado con éxito')
          }
          if (tareas) notify(tasksResultMessage(tareas))
        } else {
          if (!mockMode) setOnboarded(false)
          if (result === 'auth_success') notify('No se pudo verificar la autorización de Classroom')
          if (tareas) notify(tasksResultMessage('error'))
        }
        if (result === 'error') notify('No se pudo conectar Google Classroom')
      })
      .catch(() => {
        if (result) notify('Error al verificar autorización de Classroom')
        else if (tareas) notify(tasksResultMessage('error'))
        else if (!mockMode) notify('No se pudo conectar con el servidor. Intenta de nuevo.')
      })
      .finally(() => {
        setCheckingSession(false)
        if (result || tareas) window.history.replaceState({}, document.title, window.location.pathname)
      })
  }, [])

  // ITN-43c - Solo modo demo (VITE_USE_MOCK=true): ?tareasDemo=no_activadas|activadas|
  // revincular|apagada abre Ajustes con Classroom conectado y la tarjeta en ese estado.
  useEffect(() => {
    if (!mockMode || !tasksDemoState(window.location.search)) return
    setOnboarded(true)
    setPage('configuracion')
    setSettings(s => ({ ...s, classroomConnected: true }))
    getTasksAuthorization().then(setTasksAuth).catch(() => setTasksAuth(TASKS_AUTH_OFF))
  }, [])
  // En el demo no hay Google: Activar y Volver a autorizar simulan el regreso.
  const updateDemoTasks = (next: TasksAuthorization, text: string) => {
    setMockTasksAuthorization(next)
    setTasksAuth(next)
    notify(text)
  }
  const activateDemoTasks = () => updateDemoTasks({ ...tasksAuth, granted: true, needsRelink: false }, tasksResultMessage('ok'))
  // Tras volver a autorizar lo normal es que Google ya no conserve el permiso de tareas.
  const reconnectDemo = () => updateDemoTasks({ ...tasksAuth, granted: false, needsRelink: false }, 'Google Classroom conectado con éxito')

  const visible = notifs.filter(n => settings.categories[n.type] && (n.type !== 'tareas' || settings.classroomConnected))
  const unread = visible.filter(n => n.unread).length

  const go = (p: Page) => {
    setPage(p); setSelectedId(null); setCourseId(null); window.scrollTo(0, 0)
    if (p === 'materias') loadCourses()
    if (p === 'calendario') loadCalendar()
  }
  const openNotif = (id: string) => {
    const wasUnread = notifs.some(n => n.id === id && n.unread)
    setNotifs(ns => ns.map(n => (n.id === id ? { ...n, unread: false } : n)))
    if (!mockMode && wasUnread) {
      markRead(id).catch(error => {
        setNotifs(ns => ns.map(n => (n.id === id ? { ...n, unread: true } : n)))
        apiFailed(error, 'No se pudo marcar como leída')
      })
    }
    setSelectedId(id)
    setPage('notificaciones')
    window.scrollTo(0, 0)
  }
  const markAll = () => {
    const ids = visible.filter(n => n.unread).map(n => n.id)
    setNotifs(ns => ns.map(n => (ids.includes(n.id) ? { ...n, unread: false } : n)))
    const restore = () => setNotifs(ns => ns.map(n => (ids.includes(n.id) ? { ...n, unread: true } : n)))
    // Deshacer es local, como markUnread: no hay endpoint para marcar como no leída.
    notify(`${ids.length} ${ids.length === 1 ? 'notificación marcada' : 'notificaciones marcadas'} como leídas`, restore)
    if (!mockMode) {
      markAllRead().catch(error => {
        restore()
        apiFailed(error, 'No se pudieron marcar como leídas')
      })
    }
  }
  // Solo local: no hay endpoint para marcar como no leída, así que vuelve a leída al recargar.
  const markUnread = (id: string) => {
    setNotifs(ns => ns.map(n => (n.id === id ? { ...n, unread: true } : n)))
    setSelectedId(null)
    notify('Marcada como no leída')
  }
  // TODO(API): "Revisar ahora" sigue simulado aunque VITE_USE_MOCK no sea 'true'. Falta un
  // endpoint que dispare una revisión del RPA.
  const sync = () => {
    setSyncing(true)
    setTimeout(() => { setSyncing(false); notify('Todo al día. No hay novedades nuevas.') }, 1600)
  }
  const finishOnboarding = () => {
    setOnboarded(true)
    // Sin mock no se simula la primera revisión: los datos ya vienen de la API.
    if (!mockMode) return
    setFirstRun(true)
    setTimeout(() => { setFirstRun(false); notify('Primera revisión terminada') }, 2200)
  }
  // ITN-43c - Desactivar las tareas de Classroom: el backend quita el permiso y borra las
  // tareas guardadas. Pide confirmación; un 401 vuelve a Onboarding.
  const disableTasks = () => setConfirmReq({
    title: '¿Desactivar las tareas de Classroom?',
    body: 'Dejaremos de revisar tus tareas de Classroom y borraremos las que guardamos. Tu sesión y tus cursos siguen igual. Puedes volver a activarlas cuando quieras.',
    label: 'Desactivar', danger: true,
    onConfirm: async () => {
      try {
        await disableTasksAuthorization()
        setTasksAuth(a => ({ ...a, granted: false }))
        notify('Tareas de Classroom desactivadas')
      } catch (error) { apiFailed(error, 'No se pudieron desactivar las tareas de Classroom') }
    },
  })

  const logout = () => setConfirmReq({
    title: '¿Cerrar sesión?',
    body: 'Dejarás de recibir avisos en este dispositivo hasta que vuelvas a entrar.',
    label: 'Cerrar sesión', danger: true,
    onConfirm: async () => {
      // Si falla revocar el Push, la sesión de Google se cierra igual: el alumno
      // pidió salir. Solo el resultado de logoutGoogle() decide el aviso.
      try { await unsubscribeBrowserPush() }
      catch { console.warn('push_unsubscribe_failed') }
      try { await logoutGoogle() }
      catch {
        notify('No se pudo cerrar la sesión. Intenta de nuevo.')
        return
      }
      endSession()
    },
  })

  // ITN-58 - Sin mock, solo datos de la sesión: nada de "Alumno Demo".
  const student = studentView({ mock: mockMode, demo: STUDENT, email: sessionEmail, career: itsonProfile?.career ?? null })

  const syncProps: SyncProps = { syncing, firstRun, loading, onSync: sync, onFix: () => setLinkOpen(true), onHelp: setHelpQuery }

  const overlays = (
    <>
      {/* ITN-51 - Vinculación real de iVirtual contra /api/credentials/ivirtual. */}
      {linkOpen && (
        <IvirtualLinkSheet onClose={() => setLinkOpen(false)} onSessionExpired={sessionExpired}
          onLinked={link => { applyIvirtualLink(link); notify('Cuenta de iVirtual vinculada') }} />
      )}
      {/* ITN-55 - Matrícula y carrera contra /api/itson-profile. */}
      {profileOpen && (
        <Sheet labelledBy="itson-profile-title" onClose={() => setProfileOpen(false)}>
          <h2 id="itson-profile-title" className="text-[18px] font-semibold text-[#111827]">Matrícula para calificaciones finales</h2>
          <p className="text-[14px] text-[#64748B] mt-1 mb-5">
            Con tu matrícula y tu carrera te avisamos cuando se publique tu calificación final de cada materia.
          </p>
          <ItsonProfileForm initialCareer={itsonProfile?.career ?? ''} onCancel={() => setProfileOpen(false)}
            onSessionExpired={sessionExpired}
            onSaved={profile => { setItsonProfile(profile); setProfileOpen(false); notify('Matrícula guardada') }} />
        </Sheet>
      )}
      {helpQuery !== null && <HelpSheet initialQuery={helpQuery} onClose={() => setHelpQuery(null)} />}
      {confirmReq && <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />}
      <ToastView toast={toast} onClose={() => setToast(null)} />
    </>
  )

  if (checkingSession && !onboarded) {
    return <div className="min-h-dvh flex items-center justify-center text-[#2563EB]" role="status" aria-label="Cargando"><Spinner /></div>
  }

  if (!onboarded) {
    return (
      <>
        <Onboarding student={student} settings={settings} setSettings={setSettings} onFinish={finishOnboarding} onHelp={setHelpQuery} requireGoogle={!mockMode}
          itsonProfile={itsonProfile} onItsonProfileSaved={setItsonProfile} onSessionExpired={sessionExpired} />
        {overlays}
      </>
    )
  }

  return (
    <>
      <AppLayout student={student} page={page} unread={unread} itsonError={settings.itsonStatus === 'error'} onGo={go} onHelp={() => setHelpQuery('')} onLogout={logout}>
        {page === 'inicio' && (
          <HomePage student={student} notifs={visible} settings={settings} sync={syncProps} onOpen={openNotif} onFilter={setFilter} onGo={go}
            showClassroomPrompt={!settings.classroomConnected && !promptDismissed} onDismissPrompt={() => setPromptDismissed(true)} />
        )}
        {page === 'materias' && (
          <CoursesPage state={coursesState} itemsById={courseItems} selectedId={courseId} onOpen={openCourse} onClose={() => setCourseId(null)}
            onRetry={loadCourses} onRetryItems={retryCourseItems} onGo={go}
            ivirtualLink={mockMode ? null : ivirtualLink} classroomConnected={settings.classroomConnected} />
        )}
        {page === 'calendario' && <CalendarPage state={calendarState} onRetry={loadCalendar} />}
        {page === 'notificaciones' && (
          <NotificationsPage notifs={visible} settings={settings} filter={filter} setFilter={setFilter} selectedId={selectedId}
            onOpen={openNotif} onClose={() => setSelectedId(null)} onMarkAll={markAll} onMarkUnread={markUnread} sync={syncProps} />
        )}
        {/* TODO(API): los ajustes siguen simulados: solo viven en memoria. */}
        {page === 'configuracion' && (
          <SettingsPage settings={settings} setSettings={setSettings} onFix={() => setLinkOpen(true)} askConfirm={setConfirmReq} notify={notify}
            ivirtualLink={mockMode ? undefined : ivirtualLink} onUnlinkItson={unlinkItson}
            itsonProfile={itsonProfile} onEditItsonProfile={() => setProfileOpen(true)} onRemoveItsonProfile={removeItsonProfile}
            onDisconnected={mockMode ? undefined : endSession}
            tasksAuth={tasksAuth} onActivateTasks={mockMode ? activateDemoTasks : activateClassroomTasks}
            onDisableTasks={disableTasks}
            onReconnectClassroom={mockMode ? reconnectDemo : () => connectGoogle('settings')} />
        )}
        {page === 'perfil' && <ProfilePage student={student} settings={settings} matriculaHint={itsonProfile?.matriculaHint ?? null} onGo={go} onLogout={logout} onHelp={setHelpQuery} />}
      </AppLayout>
      {overlays}
    </>
  )
}
