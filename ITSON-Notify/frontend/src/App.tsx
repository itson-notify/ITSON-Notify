import { useEffect, useState } from 'react'
import { AppLayout } from '@/layouts/AppLayout'
import { ConfirmDialog, HelpSheet, PasswordSheet, ToastView } from '@/components/overlays'
import { Spinner } from '@/components/ui'
import { Onboarding } from '@/pages/Onboarding'
import { HomePage } from '@/pages/HomePage'
import { NotificationsPage } from '@/pages/NotificationsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { ProfilePage } from '@/pages/ProfilePage'
import { DEFAULT_SETTINGS, INITIAL_NOTIFS } from '@/services/mockData'
import { ApiError, getMe, getNotifications, markAllRead, markRead } from '@/services/api'
import { mockMode } from '@/services/backend'
import { googleSession, logoutGoogle } from '@/services/googleAuth'
import { unsubscribeBrowserPush } from '@/services/pushNotifications'
import type { ConfirmReq, Filter, Notif, Notify, Page, Settings, SyncProps } from '@/types'

/* ════════════════════════════════════════════════════════════════════════════
   ITSON Notify — frontend mobile-first
   Estilos base = teléfono. `md:` (≥768px) agrega sidebar. `lg:` (≥1024px)
   muestra lista + detalle lado a lado.

   Revisado con las 10 heurísticas de Nielsen: los comentarios [H1]…[H10]
   marcan dónde se aplica cada una.
   ════════════════════════════════════════════════════════════════════════════ */

// Sin mock, las notificaciones solo existen si llegan del backend.
const EMPTY_NOTIFS = mockMode ? INITIAL_NOTIFS : []

export default function App() {
  const [onboarded, setOnboarded] = useState(false)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [notifs, setNotifs] = useState<Notif[]>(EMPTY_NOTIFS)
  const [page, setPage] = useState<Page>('inicio')
  const [filter, setFilter] = useState<Filter>('todas')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [firstRun, setFirstRun] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [helpQuery, setHelpQuery] = useState<string | null>(null)
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null)
  const [toast, setToast] = useState<{ id: number; text: string; undo?: () => void } | null>(null)
  const [promptDismissed, setPromptDismissed] = useState(false)
  const [loading, setLoading] = useState(false)
  // Evita mostrar Onboarding un instante a quien ya tiene sesión. Al volver de Google
  // no se espera: Onboarding debe leer `from` de la URL antes de que se limpie.
  const [checkingSession, setCheckingSession] = useState(() =>
    !mockMode && !new URLSearchParams(window.location.search).get('classroom'))

  const notify: Notify = (text, undo) => {
    const id = Date.now()
    setToast({ id, text, undo })
    setTimeout(() => setToast(t => (t?.id === id ? null : t)), 6000)
  }

  const endSession = () => {
    setOnboarded(false); setSettings(DEFAULT_SETTINGS); setNotifs(EMPTY_NOTIFS)
    setPage('inicio'); setFilter('todas'); setSelectedId(null); setPromptDismissed(false)
  }
  // Un 401 significa que la sesión ya no sirve: se vuelve a Onboarding.
  const apiFailed = (error: unknown, text: string) => {
    if (error instanceof ApiError && error.status === 401) {
      endSession()
      notify('Tu sesión expiró. Vuelve a entrar con Google.')
    } else notify(text)
  }
  const loadFromApi = () => {
    setLoading(true)
    Promise.all([getMe(), getNotifications()])
      .then(([me, list]) => {
        setNotifs(list)
        setSettings(s => ({
          ...s, email: me.email, classroomEmail: me.email,
          classroomConnected: me.classroomConnected, itsonStatus: me.itsonStatus,
        }))
      })
      .catch(error => apiFailed(error, 'No se pudieron cargar tus notificaciones'))
      .finally(() => setLoading(false))
  }

  // [H3] Esc cierra el detalle abierto (si no hay un diálogo encima)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedId !== null && !pwOpen && !confirmReq && helpQuery === null) setSelectedId(null)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [selectedId, pwOpen, confirmReq, helpQuery])

  // ITN-41 - La conexión se consulta en el backend; los parámetros de retorno
  // solo sirven para mostrar el resultado, nunca para autenticar al alumno.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const result = params.get('classroom')
    const from = params.get('from')
    // La procedencia restaura la navegación, nunca autentica al estudiante.
    // También al cancelar o fallar la consulta de sesión se vuelve a Configuración.
    if (result && from === 'settings') { setOnboarded(true); setPage('configuracion') }
    googleSession()
      .then(session => {
        if (session.connected && session.email) {
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
        } else {
          if (!mockMode) setOnboarded(false)
          if (result === 'auth_success') notify('No se pudo verificar la autorización de Classroom')
        }
        if (result === 'error') notify('No se pudo conectar Google Classroom')
      })
      .catch(() => {
        if (result) notify('Error al verificar autorización de Classroom')
        else if (!mockMode) notify('No se pudo conectar con el servidor. Intenta de nuevo.')
      })
      .finally(() => {
        setCheckingSession(false)
        if (result) window.history.replaceState({}, document.title, window.location.pathname)
      })
  }, [])

  const visible = notifs.filter(n => settings.categories[n.type] && (n.type !== 'tareas' || settings.classroomConnected))
  const unread = visible.filter(n => n.unread).length

  const go = (p: Page) => { setPage(p); setSelectedId(null); window.scrollTo(0, 0) }
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

  const syncProps: SyncProps = { syncing, firstRun, loading, onSync: sync, onFix: () => setPwOpen(true), onHelp: setHelpQuery }

  const overlays = (
    <>
      {/* TODO(API): la contraseña de ITSON sigue simulada: no se envía al backend y solo cambia el estado local. */}
      {pwOpen && (
        <PasswordSheet itsonId={settings.itsonId} onClose={() => setPwOpen(false)}
          onSave={() => { setSettings(s => ({ ...s, itsonStatus: 'ok' })); setPwOpen(false); notify('Cuenta ITSON reconectada') }} />
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
        <Onboarding settings={settings} setSettings={setSettings} onFinish={finishOnboarding} onHelp={setHelpQuery} requireGoogle={!mockMode} />
        {overlays}
      </>
    )
  }

  return (
    <>
      <AppLayout page={page} unread={unread} itsonError={settings.itsonStatus === 'error'} onGo={go} onHelp={() => setHelpQuery('')} onLogout={logout}>
        {page === 'inicio' && (
          <HomePage notifs={visible} settings={settings} sync={syncProps} onOpen={openNotif} onFilter={setFilter} onGo={go}
            showClassroomPrompt={!settings.classroomConnected && !promptDismissed} onDismissPrompt={() => setPromptDismissed(true)} />
        )}
        {page === 'notificaciones' && (
          <NotificationsPage notifs={visible} settings={settings} filter={filter} setFilter={setFilter} selectedId={selectedId}
            onOpen={openNotif} onClose={() => setSelectedId(null)} onMarkAll={markAll} onMarkUnread={markUnread} sync={syncProps} />
        )}
        {/* TODO(API): los ajustes y los cupos vigilados siguen simulados: solo viven en memoria. */}
        {page === 'configuracion' && (
          <SettingsPage settings={settings} setSettings={setSettings} onFix={() => setPwOpen(true)} askConfirm={setConfirmReq} notify={notify}
            onDisconnected={mockMode ? undefined : endSession} />
        )}
        {page === 'perfil' && <ProfilePage settings={settings} onGo={go} onLogout={logout} onHelp={setHelpQuery} />}
      </AppLayout>
      {overlays}
    </>
  )
}
