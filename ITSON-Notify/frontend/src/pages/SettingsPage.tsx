import { I } from '@/components/icons'
import { Button, Section, SettingRow, SmallIcon, Toggle } from '@/components/ui'
import { CategoryRows } from '@/components/CategoryRows'
import { PageTitle } from '@/components/PageTitle'
import { WatchEditor } from '@/components/WatchEditor'
import { linkCls } from '@/utils/styles'
import type { ConfirmReq, Notify, SetSettings, Settings } from '@/types'

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
    onConfirm: () => { setSettings(s => ({ ...s, classroomConnected: false })); notify('Google Classroom desconectado') },
  })

  // [H5] No se permite apagar el último canal: así nunca te quedas sin avisos por accidente
  const onlyPush = settings.pushOn && !settings.emailOn
  const onlyEmail = settings.emailOn && !settings.pushOn

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
              <Button onClick={() => { setSettings(s => ({ ...s, classroomConnected: true, categories: { ...s.categories, tareas: true } })); notify('Google Classroom conectado') }}>Conectar</Button>
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
              onChange={v => {
                setSettings(s => ({ ...s, pushOn: v, pushPermission: v ? 'granted' : s.pushPermission }))
                if (v) notify('Notificaciones activadas en este dispositivo')
              }} />
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
