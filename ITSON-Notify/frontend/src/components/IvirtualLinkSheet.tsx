// ITN-51 - Vincular la cuenta de iVirtual. Se abre desde Ajustes y desde el aviso de
// itsonStatus === 'error'. La contraseña solo vive en el estado de este formulario:
// se borra al enviar (antes de esperar la respuesta) y nunca va a localStorage,
// sessionStorage ni a la consola. Los errores son genéricos, sin detalles técnicos.
import { useEffect, useState } from 'react'
import { I } from './icons'
import { Button, PasswordField, Sheet, Spinner, SuccessCard, TextField } from './ui'
import { ApiError, getIvirtualLink, linkIvirtual, type IvirtualLink } from '@/services/api'
import { mockMode } from '@/services/backend'
import { ITSON_RECOVERY_URL } from '@/services/mockData'
import { linkCls } from '@/utils/styles'

type Phase = 'checking' | 'unavailable' | 'load_failed' | 'idle' | 'sending' | 'rejected' | 'failed' | 'success'

const MAX_USERNAME = 64

// Texto para cada fallo del envío, sin códigos ni detalles del backend.
function sendFailure(error: unknown): { phase: Phase; text: string } {
  const status = error instanceof ApiError ? error.status : 0
  if (status === 501) return { phase: 'unavailable', text: '' }
  if (status === 422) return { phase: 'rejected', text: 'iVirtual no aceptó ese usuario o contraseña.' }
  if (status === 429) return { phase: 'failed', text: 'Hiciste demasiados intentos. Espera unos minutos y vuelve a intentarlo.' }
  return { phase: 'failed', text: 'No pudimos vincular tu cuenta. Intenta de nuevo más tarde.' }
}

export function IvirtualLinkSheet({ onClose, onLinked, onSessionExpired }: {
  onClose: () => void
  onLinked: (link: IvirtualLink) => void
  onSessionExpired: () => void
}) {
  const [phase, setPhase] = useState<Phase>(mockMode ? 'unavailable' : 'checking')
  const [errorText, setErrorText] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (mockMode) return
    getIvirtualLink()
      .then(link => setPhase(link.available ? 'idle' : 'unavailable'))
      .catch(error => {
        if (error instanceof ApiError && error.status === 401) onSessionExpired()
        else setPhase('load_failed')
      })
  }, [])

  const canType = phase === 'idle' || phase === 'rejected' || phase === 'failed'
  const user = username.trim()
  const canSend = canType && user !== '' && password !== ''

  const send = async () => {
    if (!canSend) return
    const pw = password
    // Se borra antes de esperar: si algo falla, el alumno la vuelve a escribir.
    setPassword('')
    setPhase('sending')
    try {
      const link = await linkIvirtual(user, pw)
      setPhase('success')
      onLinked(link)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return onSessionExpired()
      const failure = sendFailure(error)
      setErrorText(failure.text)
      setPhase(failure.phase)
    }
  }

  const blockedText = phase === 'unavailable'
    ? 'La vinculación con iVirtual aún no está disponible. Te avisaremos cuando puedas conectar tu cuenta.'
    : phase === 'load_failed'
      ? 'No pudimos revisar el estado de tu cuenta. Intenta de nuevo más tarde.'
      : null

  return (
    <Sheet labelledBy="ivirtual-title" onClose={onClose}>
      <h2 id="ivirtual-title" className="text-[18px] font-semibold text-[#111827]">Vincula tu cuenta de iVirtual</h2>
      <p className="text-[14px] text-[#64748B] mt-1">
        Usa el usuario y la contraseña con los que entras hoy a iVirtual. No guardamos tu contraseña: solo la usamos para
        conectar tu cuenta.
      </p>

      {phase === 'checking' && (
        <p className="mt-5 flex items-center gap-2 text-[14px] text-[#64748B]" role="status">
          <span className="text-[#2563EB]"><Spinner /></span>Revisando tu cuenta…
        </p>
      )}

      {blockedText && (
        <div className="mt-5 space-y-4">
          <p className="rounded-lg border border-[#E5E7EB] bg-[#F8FAFC] p-4 text-[14px] text-[#334155]" role="status">{blockedText}</p>
          <Button full variant="secondary" onClick={onClose}>Entendido</Button>
        </div>
      )}

      {phase === 'success' && (
        <div className="mt-5 space-y-4">
          <SuccessCard title="Cuenta vinculada" subtitle="Ya podemos revisar tus calificaciones de iVirtual." />
          <Button full onClick={onClose}>Listo</Button>
        </div>
      )}

      {(canType || phase === 'sending') && (
        <form className="mt-5 space-y-4" onSubmit={e => { e.preventDefault(); void send() }}>
          <TextField id="ivirtual-user" label="Usuario de iVirtual" value={username} autoComplete="username" autoFocus
            maxLength={MAX_USERNAME} disabled={phase === 'sending'} onChange={setUsername} />
          <PasswordField id="ivirtual-pw" value={password}
            onChange={v => { setPassword(v); if (phase === 'rejected' || phase === 'failed') setPhase('idle') }}
            error={phase === 'rejected' || phase === 'failed' ? errorText : undefined} />
          {phase === 'rejected' && (
            <a href={ITSON_RECOVERY_URL} target="_blank" rel="noreferrer" className={`${linkCls} text-[#B91C1C]`}>Recuperar contraseña en ITSON{I.external(14)}</a>
          )}
          <div className="pt-2 space-y-2 md:flex md:flex-row-reverse md:space-y-0 md:gap-2">
            <Button full type="submit" disabled={!canSend}>
              {phase === 'sending' ? <><Spinner />Vinculando…</> : 'Vincular cuenta'}
            </Button>
            <Button full variant="ghost" onClick={onClose}>Cancelar</Button>
          </div>
        </form>
      )}
    </Sheet>
  )
}
