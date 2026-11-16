// ITN-55 - Matrícula y carrera para avisar las calificaciones finales con la API de
// ITSON. Se usa en Onboarding y en Ajustes. La matrícula solo vive en el estado de este
// formulario: se borra al enviar (antes de esperar la respuesta) y nunca va a Settings,
// localStorage, sessionStorage ni a la consola. Los errores no repiten lo escrito.
import { useState } from 'react'
import { Button, Spinner, TextField } from './ui'
import { ApiError, saveItsonProfile, type ItsonProfile } from '@/services/api'
import {
  CAREER_RE, MATRICULA_RE, careerError, itsonProfileErrorText, matriculaError, normalizeCareer, onlyDigits,
} from '@/utils/itsonProfile'

export function ItsonProfileForm({ initialMatricula = '', initialCareer = '', submitLabel = 'Guardar matrícula', onSaved, onCancel, onSessionExpired }: {
  initialMatricula?: string
  initialCareer?: string
  submitLabel?: string
  onSaved: (profile: ItsonProfile) => void
  onCancel?: () => void
  onSessionExpired: () => void
}) {
  const [matricula, setMatricula] = useState(() => (MATRICULA_RE.test(initialMatricula) ? initialMatricula : ''))
  const [career, setCareer] = useState(() => normalizeCareer(initialCareer))
  const [touched, setTouched] = useState({ matricula: false, career: false })
  const [sending, setSending] = useState(false)
  const [errorText, setErrorText] = useState('')

  const valid = MATRICULA_RE.test(matricula) && CAREER_RE.test(career)

  const send = async () => {
    if (!valid || sending) return
    const enviada = matricula
    // Se borra antes de esperar: si algo falla, el alumno la vuelve a escribir.
    setMatricula('')
    setTouched({ matricula: false, career: true })
    setErrorText('')
    setSending(true)
    try {
      const profile = await saveItsonProfile(enviada, career)
      setSending(false)
      onSaved(profile)
    } catch (error) {
      setSending(false)
      if (error instanceof ApiError && error.status === 401) return onSessionExpired()
      setErrorText(itsonProfileErrorText(error))
    }
  }

  return (
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); void send() }}>
      <TextField id="itson-matricula" label="Matrícula" value={matricula} inputMode="numeric" maxLength={11}
        autoComplete="off" placeholder="Ej. 00000123456" disabled={sending}
        onChange={v => { setMatricula(onlyDigits(v)); if (errorText) setErrorText('') }}
        onBlur={() => setTouched(t => ({ ...t, matricula: true }))}
        hint="Son 11 dígitos y empieza con 00000. Debe ser la de tu correo institucional."
        error={touched.matricula ? matriculaError(matricula) : undefined} />
      <TextField id="itson-carrera" label="Carrera" value={career} maxLength={8} autoComplete="off" placeholder="Ej. INSOF"
        disabled={sending}
        onChange={v => { setCareer(normalizeCareer(v)); if (errorText) setErrorText('') }}
        onBlur={() => setTouched(t => ({ ...t, career: true }))}
        hint="El código de tu carrera, de 2 a 8 letras, por ejemplo INSOF."
        error={touched.career ? careerError(career) : undefined} />
      {errorText && (
        <p role="alert" className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-3 text-[13px] text-[#991B1B]">{errorText}</p>
      )}
      <div className="pt-1 space-y-2 md:flex md:flex-row-reverse md:space-y-0 md:gap-2">
        <Button full type="submit" disabled={!valid || sending}>
          {sending ? <><Spinner />Guardando…</> : submitLabel}
        </Button>
        {onCancel && <Button full variant="ghost" onClick={onCancel}>Cancelar</Button>}
      </div>
    </form>
  )
}
