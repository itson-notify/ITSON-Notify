import { I } from '@/components/icons'
import { Button, Section, SettingRow, SmallIcon, Toggle } from '@/components/ui'
import { CategoryRows } from '@/components/CategoryRows'
import { PageTitle } from '@/components/PageTitle'
import { WatchEditor } from '@/components/WatchEditor'
import { linkCls } from '@/utils/styles'
import { connectGoogle, disconnectGoogle } from '@/services/googleAuth'
import type { ConfirmReq, Notify, SetSettings, Settings } from '@/types'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

// Pide permiso en el navegador, registra el Service Worker y guarda la suscripción en el backend.
async function subscribeBrowserPush(userId: string) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('push_no_soportado')
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('permiso_denegado')

  const keyRes = await fetch(`${API_BASE}/push/vapid-public-key`, { credentials: 'include' })
  if (!keyRes.ok) throw new Error('sin_llave_vapid')
  const { publicKey } = await keyRes.json()

  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })

  const subRes = await fetch(`${API_BASE}/push/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ userId, subscription: subscription.toJSON() }),
  })
  if (!subRes.ok) throw new Error('error_guardando_suscripcion')
}

async function unsubscribeBrowserPush(userId: string) {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return

  await fetch(`${API_BASE}/push/subscriptions`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ userId, endpoint: subscription.endpoint }),
  })
  await subscription.unsubscribe()
}

export function SettingsPage({ settings, setSettings, onFix, askConfirm, notify }: {
  settings: Settings; setSettings: SetSettings; onFix: () => void; askConfirm: (r: ConfirmReq) => void; notify: Notify
}) {
  const itsonError = settings.itsonStatus === 'error'

  const StatusPill = ({ ok, text }: { ok: boolean; text: string }) => (
    <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${ok ? 'text-[#15803D]' : 'text-[#C2410C]'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-[#22C55E]' : 'bg-[#F97316]'}`} />{text}
    </span>
  )

  const disconnectClassroom = () => askConfirm({
    title: '¿Desconectar Google Classroom?',
    body: 'Dejarás de recibir avisos de tareas. Puedes volver a conectarlo cuando quieras.',
    label: 'Desconectar', danger: true,
    onConfirm: async () => {
      try {
        await disconnectGoogle()
        setSettings(s => ({ ...s, classroomConnected: false }))
        notify('Google Classroom desconectado')
      } catch { notify('No se pudo desconectar Google Classroom') }
    },
  })

  // [H5] No se permite apagar el último canal: así nunca te quedas sin avisos por accidente
  const onlyPush = settings.pushOn && !settings.emailOn
  const onlyEmail = settings.emailOn && !settings.pushOn

  const togglePush = async (v: boolean) => {
    const userId = settings.itsonId || 'default-student'
    if (v) {
      try {
        await subscribeBrowserPush(userId)
        setSettings(s => ({ ...s, pushOn: true, pushPermission: 'granted' }))
        notify('Notificaciones activadas en este dispositivo')
      } catch {
        const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied'
        setSettings(s => ({ ...s, pushOn: false, pushPermission: denied ? 'denied' : s.pushPermission }))
        notify(denied ? 'Permiso bloqueado en el navegador' : 'No se pudieron activar las notificaciones push')
      }
    } else {
      try { await unsubscribeBrowserPush(userId) } catch { /* ignorar error de red */ }
      setSettings(s => ({ ...s, pushOn: false }))
      notify('Notificaciones desactivadas en este dispositivo')
    }
  }

  return (
    <div className="py-5 md:px-8 md:py-8 lg:px-10 max-w-2xl">
      {/* [H1] Explica que no hay botón de guardar */}
      <PageTitle title="Configuración" subtitle="Los cambios se guardan automáticamente." />

      <div className="mt-6">
        <Section title="Cuentas conectadas">
          <SettingRow icon={<SmallIcon tone="blue">{I.lock(18)}</SmallIcon>} title="Cuenta ITSON"
            subtitle={
              <div className="flex flex-col items-start gap-0.5">
                <span>ID {settings.itsonId || '—'}</span>
                <StatusPill ok={!itsonError} text={itsonError ? 'Requiere tu contraseña' : 'Conectada'} />
                {/* [H4] Misma acción, mismas palabras que en el aviso de error */}
                <button onClick={onFix} className={`${linkCls} ${itsonError ? 'text-[#C2410C]' : 'text-[#2563EB]'}`}>Actualizar contraseña</button>
              </div>
            } />
          <SettingRow icon={<SmallIcon>{I.book(18)}</SmallIcon>} title="Google Classroom"
            subtitle={settings.classroomConnected
              ? <div className="flex flex-col items-start gap-0.5">
                  <span className="max-w-full truncate">{settings.classroomEmail}</span>
                  <StatusPill ok text="Conectada" />
                  <button onClick={disconnectClassroom} className={`${linkCls} text-[#DC2626]`}>Desconectar</button>
                </div>
              : 'Sin conectar'}>
            {!settings.classroomConnected && (
              <Button onClick={() => connectGoogle('settings')}>Conectar</Button>
            )}
          </SettingRow>
        </Section>

        <Section title="Qué quieres recibir">
          <CategoryRows settings={settings} setSettings={setSettings} />
        </Section>

        {settings.categories.cupos && (
          <Section title="Materias para vigilar cupos" description="Te avisamos solo cuando se libere un lugar en estas materias.">
            <WatchEditor list={settings.cupoWatch}
              onChange={fn => setSettings(s => ({ ...s, cupoWatch: fn(s.cupoWatch) }))}
              onRemoved={(m, undo) => notify(`Dejaste de vigilar ${m}`, undo)} />
          </Section>
        )}

        <Section title="Cómo te avisamos">
          <SettingRow icon={<SmallIcon>{I.phone(18)}</SmallIcon>} title="En este dispositivo"
            subtitle={onlyPush ? 'Debe quedar al menos un canal activo' : settings.pushPermission === 'granted' ? 'Notificaciones push' : 'Te pediremos permiso al activarlo'}>
            <Toggle label="Notificaciones push" on={settings.pushOn} disabled={onlyPush}
              onChange={togglePush} />
          </SettingRow>
          <SettingRow icon={<SmallIcon>{I.mail(18)}</SmallIcon>} title="Por correo"
            subtitle={onlyEmail ? 'Debe quedar al menos un canal activo' : <span className="block truncate">{settings.email}</span>}>
            <Toggle label="Avisos por correo" on={settings.emailOn} disabled={onlyEmail} onChange={v => setSettings(s => ({ ...s, emailOn: v }))} />
          </SettingRow>
          <SettingRow icon={<SmallIcon>{I.moon(18)}</SmallIcon>} title="Horario silencioso" subtitle="De 22:00 a 7:00 los avisos se juntan y llegan en la mañana">
            <Toggle label="Horario silencioso" on={settings.quietHours} onChange={v => setSettings(s => ({ ...s, quietHours: v }))} />
          </SettingRow>
        </Section>

        {/* Solo para presentar el prototipo */}
        <section className="mt-8 mx-4 md:mx-0 rounded-lg border border-dashed border-[#CBD5E1] p-4">
          <p className="text-[13px] font-semibold text-[#475569]">Solo para la demo</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[13px] text-[#64748B]">Simular que el RPA no pudo entrar al portal</p>
            <Toggle label="Simular error del portal" on={itsonError} onChange={v => setSettings(s => ({ ...s, itsonStatus: v ? 'error' : 'ok' }))} />
          </div>
        </section>
      </div>
    </div>
  )
}