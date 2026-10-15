import { useState, type ReactNode } from 'react'
import { I } from '@/components/icons'
import { Button, PasswordField, Spinner, SuccessCard, TextField, TypeIcon } from '@/components/ui'
import { CategoryRows } from '@/components/CategoryRows'
import { WatchEditor } from '@/components/WatchEditor'
import { ITSON_RECOVERY_URL, STUDENT } from '@/services/mockData'
import { TYPE_CFG, TYPES } from '@/utils/notifTypes'
import { focusRing, linkCls } from '@/utils/styles'
import type { SetSettings, Settings } from '@/types'

export function Onboarding({ settings, setSettings, onFinish, onHelp }: {
  settings: Settings; setSettings: SetSettings; onFinish: () => void; onHelp: (q: string) => void
}) {
  const [step, setStep] = useState(0)
  const [pw, setPw] = useState('')
  const [consent, setConsent] = useState(false)
  const [idTouched, setIdTouched] = useState(false)
  const [itsonState, setItsonState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [googleState, setGoogleState] = useState<'idle' | 'loading'>('idle')
  const patch = (p: Partial<Settings>) => setSettings(s => ({ ...s, ...p }))

  // [H5] El ID de ITSON tiene 11 dígitos: se valida antes de intentar conectar
  const idValid = /^\d{11}$/.test(settings.itsonId)
  const idError = idTouched && settings.itsonId && !idValid ? `Tu ID debe tener 11 dígitos (llevas ${settings.itsonId.length}).` : undefined

  const connectItson = () => {
    setItsonState('loading')
    // TODO real: POST /auth/itson → el backend valida con Playwright y guarda la contraseña cifrada
    setTimeout(() => setItsonState(pw.toLowerCase() === 'error' ? 'error' : 'done'), 1300)
  }
  const connectGoogle = () => {
    setGoogleState('loading')
    // TODO real: OAuth de Google con scopes de solo lectura de Classroom
    setTimeout(() => { patch({ classroomConnected: true }); setGoogleState('idle') }, 1100)
  }
  const enablePush = () => {
    // TODO real: Notification.requestPermission() + getToken() de Firebase Cloud Messaging
    patch({ pushOn: true, pushPermission: 'granted' })
    setStep(5)
  }

  const next = () => setStep(s => s + 1)

  let body: ReactNode = null
  let footer: ReactNode = null

  if (step === 0) {
    body = (
      <div className="flex flex-col h-full pt-6 md:pt-2">
        <span className="w-14 h-14 rounded-xl bg-[#2563EB] text-white flex items-center justify-center">{I.bell(26)}</span>
        <h1 className="mt-6 text-[28px] md:text-[30px] leading-[1.15] font-semibold text-[#111827] tracking-[-0.02em]">Deja de revisar el portal a cada rato</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-[#64748B]">ITSON Notify revisa tus portales y Google Classroom por ti, y te avisa en cuanto algo cambia.</p>
        <ul className="mt-8 space-y-4">
          {TYPES.map(t => (
            <li key={t} className="flex items-center gap-3">
              <TypeIcon type={t} size={36} />
              <div>
                <p className="text-[15px] font-medium text-[#111827]">{TYPE_CFG[t].label}</p>
                <p className="text-[13px] text-[#64748B]">{TYPE_CFG[t].desc}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    )
    footer = <Button full onClick={next}>Empezar</Button>
  }

  if (step === 1) {
    body = (
      <div>
        <h1 className="text-[24px] font-semibold text-[#111827] tracking-[-0.015em]">Conecta tu cuenta ITSON</h1>
        <p className="mt-2 text-[15px] text-[#64748B]">Usa el mismo ID y contraseña con los que entras al portal de alumnos.</p>

        {itsonState === 'done' ? (
          <div className="mt-6"><SuccessCard title={`Conectado como ${STUDENT.name}`} subtitle={`${STUDENT.career}, ID ${settings.itsonId}`} /></div>
        ) : (
          <div className="mt-6 space-y-4">
            <TextField id="itson-id" label="ID de estudiante" value={settings.itsonId} onChange={v => patch({ itsonId: v.replace(/\D/g, '') })}
              onBlur={() => setIdTouched(true)} inputMode="numeric" maxLength={11} placeholder="Ej. 00000123456" autoComplete="username"
              hint="Son 11 dígitos y empieza con 00000." error={idError} />
            <PasswordField id="itson-pw" value={pw} onChange={v => { setPw(v); if (itsonState === 'error') setItsonState('idle') }} />

            {/* [H9] Qué pasó y qué hacer, en lenguaje del alumno */}
            {itsonState === 'error' && (
              <div role="alert" className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-3.5 flex gap-2.5">
                <span className="text-[#DC2626] mt-0.5 flex-shrink-0">{I.alert(16)}</span>
                <div>
                  <p className="text-[14px] font-semibold text-[#991B1B]">El portal no aceptó ese ID y contraseña</p>
                  <p className="text-[13px] text-[#991B1B]/85 mt-0.5">Revisa que sean los mismos con los que entras al portal de alumnos. Si no recuerdas tu contraseña, recupérala en ITSON y vuelve aquí.</p>
                  <a href={ITSON_RECOVERY_URL} target="_blank" rel="noreferrer" className={`${linkCls} mt-1 text-[#B91C1C]`}>Recuperar contraseña en ITSON{I.external(14)}</a>
                </div>
              </div>
            )}

            <div className="rounded-lg bg-[#F8FAFC] border border-[#E5E7EB] p-4 space-y-3">
              <p className="text-[14px] font-semibold text-[#111827]">Qué hacemos con tu contraseña</p>
              {[
                { icon: I.lock(16), text: 'Se guarda cifrada. Nadie del equipo puede leerla.' },
                { icon: I.shield(16), text: 'Solo la usamos para consultar tu información. Nunca hacemos trámites ni cambios por ti.' },
                { icon: I.x(16), text: 'Puedes desconectarte y borrar tus datos cuando quieras.' },
              ].map((r, i) => (
                <p key={i} className="flex items-start gap-2.5 text-[13px] leading-relaxed text-[#475569]">
                  <span className="mt-0.5 text-[#2563EB] flex-shrink-0">{r.icon}</span>{r.text}
                </p>
              ))}
              <button onClick={() => onHelp('contraseña')} className={`${linkCls} text-[#2563EB]`}>{I.help(16)}Más preguntas sobre seguridad</button>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}
                className="mt-0.5 w-5 h-5 rounded accent-[#2563EB] flex-shrink-0 cursor-pointer" />
              <span className="text-[13px] leading-relaxed text-[#475569]">
                Autorizo que ITSON Notify consulte mi información en los portales de ITSON. Entiendo que es un proyecto estudiantil y no un servicio oficial de ITSON.
              </span>
            </label>
          </div>
        )}
      </div>
    )
    // [H1] Dice qué falta en lugar de solo deshabilitar el botón
    const missing = !idValid ? 'Escribe tu ID de 11 dígitos' : !pw ? 'Escribe tu contraseña' : !consent ? 'Acepta la autorización para continuar' : ''
    footer = itsonState === 'done'
      ? <Button full onClick={next}>Continuar</Button>
      : <div>
          <Button full onClick={connectItson} disabled={!!missing || itsonState === 'loading'}>
            {itsonState === 'loading' ? <><Spinner />Verificando con el portal…</> : 'Conectar cuenta'}
          </Button>
          {missing && itsonState !== 'loading' && <p className="mt-2 text-center text-[13px] text-[#64748B]">{missing}</p>}
        </div>
  }

  if (step === 2) {
    body = (
      <div>
        <span className="w-12 h-12 rounded-xl bg-[#F5F3FF] text-[#7C3AED] flex items-center justify-center">{I.book(22)}</span>
        <h1 className="mt-5 text-[24px] font-semibold text-[#111827] tracking-[-0.015em]">Conecta Google Classroom</h1>
        <p className="mt-2 text-[15px] text-[#64748B]">Así te avisamos de tareas nuevas y de las que están por vencer.</p>

        {settings.classroomConnected ? (
          <div className="mt-6"><SuccessCard title="Classroom conectado" subtitle={settings.classroomEmail} /></div>
        ) : (
          <div className="mt-6 rounded-lg border border-[#E5E7EB] divide-y divide-[#F1F5F9]">
            <div className="p-4">
              <p className="text-[13px] font-semibold text-[#111827] mb-2">Vamos a poder</p>
              {['Ver tus clases', 'Ver tus tareas y fechas de entrega'].map(t => (
                <p key={t} className="flex items-center gap-2 text-[14px] text-[#475569] py-1"><span className="text-[#16A34A]">{I.check(16)}</span>{t}</p>
              ))}
            </div>
            <div className="p-4">
              <p className="text-[13px] font-semibold text-[#111827] mb-2">Nunca vamos a</p>
              {['Entregar tareas ni publicar en tus clases', 'Leer tu correo o tus archivos'].map(t => (
                <p key={t} className="flex items-center gap-2 text-[14px] text-[#475569] py-1"><span className="text-[#94A3B8]">{I.x(16)}</span>{t}</p>
              ))}
            </div>
          </div>
        )}
      </div>
    )
    footer = settings.classroomConnected
      ? <Button full onClick={next}>Continuar</Button>
      : <div className="space-y-2">
          <Button full onClick={connectGoogle} disabled={googleState === 'loading'}>
            {googleState === 'loading' ? <><Spinner />Conectando…</> : 'Continuar con Google'}
          </Button>
          <Button full variant="ghost" onClick={next}>Omitir por ahora</Button>
        </div>
  }

  if (step === 3) {
    body = (
      <div className="-mx-4 md:-mx-6">
        <div className="px-4 md:px-6">
          <h1 className="text-[24px] font-semibold text-[#111827] tracking-[-0.015em]">¿De qué quieres enterarte?</h1>
          <p className="mt-2 text-[15px] text-[#64748B]">Puedes cambiarlo después en Configuración.</p>
        </div>
        <div className="mt-5 border-y border-[#E5E7EB] divide-y divide-[#F1F5F9]">
          <CategoryRows settings={settings} setSettings={setSettings} />
        </div>
        {settings.categories.cupos && (
          <div className="mt-6">
            <div className="px-4 md:px-6">
              <h2 className="text-[15px] font-semibold text-[#111827]">Materias para vigilar cupos</h2>
              <p className="text-[13px] text-[#64748B] mt-0.5">Te avisamos solo cuando se libere un lugar en estas materias.</p>
            </div>
            <div className="md:px-2">
              <WatchEditor list={settings.cupoWatch} onChange={fn => setSettings(s => ({ ...s, cupoWatch: fn(s.cupoWatch) }))} />
            </div>
          </div>
        )}
      </div>
    )
    footer = <Button full onClick={next}>Continuar</Button>
  }

  if (step === 4) {
    body = (
      <div>
        <h1 className="text-[24px] font-semibold text-[#111827] tracking-[-0.015em]">Activa las notificaciones</h1>
        <p className="mt-2 text-[15px] text-[#64748B]">Te avisamos en cuanto detectemos algo, aunque no tengas la app abierta.</p>

        <div className="mt-6 rounded-2xl bg-[#F1F5F9] p-4">
          <div className="rounded-xl bg-white/90 border border-[#E5E7EB] p-3.5 flex gap-3">
            <span className="w-9 h-9 rounded-lg bg-[#2563EB] text-white flex items-center justify-center flex-shrink-0">{I.bell(16)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex justify-between text-[12px] text-[#64748B]"><span className="font-medium">ITSON Notify</span><span>ahora</span></div>
              <p className="text-[14px] font-semibold text-[#111827] mt-0.5">Se liberó un cupo</p>
              <p className="text-[13px] text-[#475569]">Redes de Computadoras, grupo 01</p>
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-start gap-3 rounded-lg border border-[#E5E7EB] p-4">
          <span className="text-[#64748B] mt-0.5">{I.phone(18)}</span>
          <p className="text-[13px] leading-relaxed text-[#475569]">
            <span className="font-semibold text-[#111827]">¿Usas iPhone?</span> Primero toca <span className="inline-flex align-middle text-[#2563EB]">{I.share(14)}</span> Compartir y luego “Agregar a inicio”. Safari solo permite avisos desde apps agregadas a la pantalla de inicio.
          </p>
        </div>
      </div>
    )
    footer = (
      <div className="space-y-2">
        <Button full onClick={enablePush}>Activar notificaciones</Button>
        <Button full variant="ghost" onClick={() => { patch({ pushOn: false, emailOn: true }); setStep(5) }}>Prefiero solo por correo</Button>
      </div>
    )
  }

  if (step === 5) {
    const watched = settings.cupoWatch.length
    const summary = [
      { ok: true, text: `Cuenta ITSON conectada (ID ${settings.itsonId})` },
      { ok: settings.classroomConnected, text: settings.classroomConnected ? 'Google Classroom conectado' : 'Google Classroom sin conectar (puedes hacerlo después)' },
      { ok: !settings.categories.cupos || watched > 0, text: settings.categories.cupos ? `Vigilando cupos en ${watched} ${watched === 1 ? 'materia' : 'materias'}` : 'Cupos desactivados' },
      { ok: true, text: settings.pushOn ? `Avisos en este dispositivo y en ${settings.email}` : `Avisos por correo a ${settings.email}` },
    ]
    body = (
      <div className="pt-6 md:pt-2">
        <span className="w-14 h-14 rounded-full bg-[#22C55E] text-white flex items-center justify-center">{I.check(28)}</span>
        <h1 className="mt-6 text-[26px] font-semibold text-[#111827] tracking-[-0.02em]">Todo listo, {STUDENT.name.split(' ')[0]}</h1>
        <p className="mt-2 text-[15px] text-[#64748B]">Vamos a hacer la primera revisión de tus portales. Puede tardar unos minutos.</p>
        <ul className="mt-6 space-y-3">
          {summary.map(s => (
            <li key={s.text} className="flex items-start gap-2.5 text-[14px] text-[#334155]">
              <span className={`mt-0.5 ${s.ok ? 'text-[#16A34A]' : 'text-[#EA580C]'}`}>{s.ok ? I.check(16) : I.alert(16)}</span>{s.text}
            </li>
          ))}
        </ul>
      </div>
    )
    footer = <Button full onClick={onFinish}>Ir a mi inicio</Button>
  }

  const showProgress = step >= 1 && step <= 4
  const stepNames = ['', 'Cuenta ITSON', 'Classroom', 'Preferencias', 'Avisos']

  return (
    <div className="min-h-dvh bg-white md:bg-[#F8FAFC] md:flex md:items-center md:justify-center md:p-8">
      <div className="min-h-dvh md:min-h-0 flex flex-col w-full md:max-w-[460px] md:bg-white md:border md:border-[#E5E7EB] md:rounded-xl">
        {showProgress && (
          <header className="sticky top-0 z-10 bg-white px-2 pt-[calc(8px+env(safe-area-inset-top))] md:pt-3 md:px-3 md:rounded-t-xl">
            <div className="flex items-center gap-1">
              {/* [H3] Siempre se puede regresar al paso anterior */}
              <button onClick={() => setStep(step - 1)} aria-label="Regresar al paso anterior"
                className={`w-11 h-11 flex items-center justify-center rounded-lg text-[#64748B] hover:text-[#111827] cursor-pointer ${focusRing}`}>{I.arrow()}</button>
              {/* [H1] Dónde estoy y cuánto falta */}
              <span className="text-[13px] text-[#64748B]">Paso {step} de 4: <span className="text-[#111827] font-medium">{stepNames[step]}</span></span>
            </div>
            <div className="mx-2 mb-1 h-1 rounded-full bg-[#F1F5F9] overflow-hidden" role="progressbar" aria-valuemin={1} aria-valuemax={4} aria-valuenow={step}>
              <div className="h-full bg-[#2563EB] transition-all duration-300" style={{ width: `${(step / 4) * 100}%` }} />
            </div>
          </header>
        )}
        <div className={`flex-1 px-4 md:px-6 ${showProgress ? 'pt-4' : 'pt-[calc(16px+env(safe-area-inset-top))] md:pt-8'} pb-6`}>{body}</div>
        <footer className="sticky bottom-0 bg-white border-t border-[#F1F5F9] md:border-0 px-4 md:px-6 pt-3 pb-[calc(16px+env(safe-area-inset-bottom))] md:pb-6 md:rounded-b-xl">
          {footer}
        </footer>
      </div>
    </div>
  )
}
