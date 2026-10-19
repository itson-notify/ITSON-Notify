import { useEffect, useState } from 'react'
import { AppLayout } from '@/layouts/AppLayout'
import { ConfirmDialog, HelpSheet, PasswordSheet, ToastView } from '@/components/overlays'
import { Onboarding } from '@/pages/Onboarding'
import { HomePage } from '@/pages/HomePage'
import { NotificationsPage } from '@/pages/NotificationsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { ProfilePage } from '@/pages/ProfilePage'
import { DEFAULT_SETTINGS, INITIAL_NOTIFS } from '@/services/mockData'
import type { ConfirmReq, Filter, Notif, Notify, Page, Settings, SyncProps } from '@/types'

/* ════════════════════════════════════════════════════════════════════════════
   ITSON Notify — frontend mobile-first
   Estilos base = teléfono. `md:` (≥768px) agrega sidebar. `lg:` (≥1024px)
   muestra lista + detalle lado a lado.

   Revisado con las 10 heurísticas de Nielsen: los comentarios [H1]…[H10]
   marcan dónde se aplica cada una.
   ════════════════════════════════════════════════════════════════════════════ */

export default function App() {
  const [onboarded, setOnboarded] = useState(false)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [notifs, setNotifs] = useState<Notif[]>(INITIAL_NOTIFS)
  const [page, setPage] = useState<Page>('inicio')
  const [filter, setFilter] = useState<Filter>('todas')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [firstRun, setFirstRun] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [helpQuery, setHelpQuery] = useState<string | null>(null)
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null)
  const [toast, setToast] = useState<{ id: number; text: string; undo?: () => void } | null>(null)
  const [promptDismissed, setPromptDismissed] = useState(false)

  const notify: Notify = (text, undo) => {
    const id = Date.now()
    setToast({ id, text, undo })
    setTimeout(() => setToast(t => (t?.id === id ? null : t)), 6000)
  }

  // [H3] Esc cierra el detalle abierto (si no hay un diálogo encima)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedId !== null && !pwOpen && !confirmReq && helpQuery === null) setSelectedId(null)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [selectedId, pwOpen, confirmReq, helpQuery])

  const visible = notifs.filter(n => settings.categories[n.type] && (n.type !== 'tareas' || settings.classroomConnected))
  const unread = visible.filter(n => n.unread).length

  const go = (p: Page) => { setPage(p); setSelectedId(null); window.scrollTo(0, 0) }
  const openNotif = (id: number) => {
    setNotifs(ns => ns.map(n => (n.id === id ? { ...n, unread: false } : n)))
    setSelectedId(id)
    setPage('notificaciones')
    window.scrollTo(0, 0)
  }
  const markAll = () => {
    const ids = visible.filter(n => n.unread).map(n => n.id)
    setNotifs(ns => ns.map(n => (ids.includes(n.id) ? { ...n, unread: false } : n)))
    notify(`${ids.length} ${ids.length === 1 ? 'notificación marcada' : 'notificaciones marcadas'} como leídas`,
      () => setNotifs(ns => ns.map(n => (ids.includes(n.id) ? { ...n, unread: true } : n))))
  }
  const markUnread = (id: number) => {
    setNotifs(ns => ns.map(n => (n.id === id ? { ...n, unread: true } : n)))
    setSelectedId(null)
    notify('Marcada como no leída')
  }
  // TODO real: disparar una revisión del RPA desde el backend
  const sync = () => {
    setSyncing(true)
    setTimeout(() => { setSyncing(false); notify('Todo al día. No hay novedades nuevas.') }, 1600)
  }
  const finishOnboarding = () => {
    setOnboarded(true)
    setFirstRun(true)
    setTimeout(() => { setFirstRun(false); notify('Primera revisión terminada') }, 2200)
  }
  const logout = () => setConfirmReq({
    title: '¿Cerrar sesión?',
    body: 'Dejarás de recibir avisos en este dispositivo hasta que vuelvas a entrar.',
    label: 'Cerrar sesión', danger: true,
    onConfirm: () => {
      setOnboarded(false); setSettings(DEFAULT_SETTINGS); setNotifs(INITIAL_NOTIFS)
      setPage('inicio'); setFilter('todas'); setSelectedId(null); setPromptDismissed(false)
    },
  })

  const syncProps: SyncProps = { syncing, firstRun, onSync: sync, onFix: () => setPwOpen(true), onHelp: setHelpQuery }

  const overlays = (
    <>
      {pwOpen && (
        <PasswordSheet itsonId={settings.itsonId} onClose={() => setPwOpen(false)}
          onSave={() => { setSettings(s => ({ ...s, itsonStatus: 'ok' })); setPwOpen(false); notify('Cuenta ITSON reconectada') }} />
      )}
      {helpQuery !== null && <HelpSheet initialQuery={helpQuery} onClose={() => setHelpQuery(null)} />}
      {confirmReq && <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />}
      <ToastView toast={toast} onClose={() => setToast(null)} />
    </>
  )

  if (!onboarded) {
    return (
      <>
        <Onboarding settings={settings} setSettings={setSettings} onFinish={finishOnboarding} onHelp={setHelpQuery} />
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
        {page === 'configuracion' && (
          <SettingsPage settings={settings} setSettings={setSettings} onFix={() => setPwOpen(true)} askConfirm={setConfirmReq} notify={notify} />
        )}
        {page === 'perfil' && <ProfilePage settings={settings} onGo={go} onLogout={logout} onHelp={setHelpQuery} />}
      </AppLayout>
      {overlays}
    </>
  )
}
