import { useEffect, useState, type ReactNode } from 'react'
import { I } from './icons'
import { TYPE_CFG } from '@/utils/notifTypes'
import { focusRing } from '@/utils/styles'
import type { NotifType } from '@/types'

export function Button({ children, variant = 'primary', full, disabled, onClick, type = 'button' }: {
  children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid'; full?: boolean; disabled?: boolean; onClick?: () => void; type?: 'button' | 'submit'
}) {
  const styles = {
    primary: 'bg-[#2563EB] text-white hover:bg-[#1D4ED8] disabled:bg-[#93C5FD]',
    secondary: 'bg-white text-[#111827] border border-[#E5E7EB] hover:bg-[#F8FAFC] disabled:text-[#94A3B8]',
    ghost: 'text-[#64748B] hover:text-[#111827] hover:bg-[#F1F5F9]',
    danger: 'bg-white text-[#DC2626] border border-[#E5E7EB] hover:bg-[#FEF2F2]',
    dangerSolid: 'bg-[#DC2626] text-white hover:bg-[#B91C1C]',
  }[variant]
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 min-h-12 md:min-h-11 rounded-lg px-5 text-[15px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed ${focusRing} ${styles} ${full ? 'w-full' : ''}`}>
      {children}
    </button>
  )
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${focusRing} ${on ? 'bg-[#2563EB]' : 'bg-[#CBD5E1]'}`}>
      <span className={`inline-block h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
    </button>
  )
}

export function TypeIcon({ type, size = 40 }: { type: NotifType; size?: number }) {
  const { icon, color, bg } = TYPE_CFG[type]
  return (
    <span className="flex-shrink-0 rounded-full flex items-center justify-center" style={{ width: size, height: size, backgroundColor: bg, color }}>
      {icon(Math.round(size * 0.45))}
    </span>
  )
}

export function TextField({ id, label, value, onChange, onBlur, placeholder, inputMode, disabled, autoComplete, autoFocus, maxLength, type = 'text', trailing, hint, error }: {
  id: string; label: string; value: string; onChange?: (v: string) => void; onBlur?: () => void; placeholder?: string; inputMode?: 'numeric' | 'email' | 'text'
  disabled?: boolean; autoComplete?: string; autoFocus?: boolean; maxLength?: number; type?: string; trailing?: ReactNode; hint?: string; error?: string
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium text-[#334155] mb-1.5">{label}</label>
      <div className="relative">
        {/* 16px en móvil evita que iOS haga zoom al enfocar */}
        <input id={id} type={type} value={value} onChange={e => onChange?.(e.target.value)} onBlur={onBlur} placeholder={placeholder} inputMode={inputMode}
          disabled={disabled} autoComplete={autoComplete} autoFocus={autoFocus} maxLength={maxLength} aria-invalid={!!error} aria-describedby={describedBy}
          className={`w-full h-12 rounded-lg border bg-white px-3.5 text-[16px] md:text-[15px] text-[#111827] placeholder:text-[#94A3B8] focus:outline-none focus:ring-4 disabled:bg-[#F8FAFC] disabled:text-[#64748B] ${error ? 'border-[#DC2626] focus:ring-[#DC2626]/15' : 'border-[#E5E7EB] focus:border-[#2563EB] focus:ring-[#2563EB]/15'} ${trailing ? 'pr-12' : ''}`} />
        {trailing && <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>}
      </div>
      {error
        ? <p id={`${id}-error`} className="mt-1.5 text-[13px] text-[#B91C1C]">{error}</p>
        : hint && <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-[#64748B]">{hint}</p>}
    </div>
  )
}

export function PasswordField({ id, value, onChange, autoFocus, error }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; error?: string }) {
  const [show, setShow] = useState(false)
  return (
    <TextField id={id} label="Contraseña del portal" value={value} onChange={onChange} type={show ? 'text' : 'password'} autoComplete="current-password"
      autoFocus={autoFocus} error={error}
      trailing={
        <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          className={`w-10 h-10 flex items-center justify-center rounded-md text-[#64748B] hover:text-[#111827] cursor-pointer ${focusRing}`}>
          {show ? I.eyeOff() : I.eye()}
        </button>
      } />
  )
}

export function Spinner() {
  return <span className="inline-block w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />
}

export function SuccessCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[#BBF7D0] bg-[#F0FDF4] p-4" role="status">
      <span className="w-9 h-9 rounded-full bg-[#22C55E] text-white flex items-center justify-center flex-shrink-0">{I.check(18)}</span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-[#14532D]">{title}</p>
        <p className="text-[13px] text-[#166534] truncate">{subtitle}</p>
      </div>
    </div>
  )
}

/** Grupo de ajustes: en móvil ocupa todo el ancho con bordes arriba/abajo; en md+ es una tarjeta. */
export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mt-7 first:mt-0">
      <div className="px-4 md:px-0 mb-2">
        <h2 className="text-[15px] font-semibold text-[#111827]">{title}</h2>
        {description && <p className="text-[13px] text-[#64748B] mt-0.5">{description}</p>}
      </div>
      <div className="bg-white border-y md:border md:rounded-lg border-[#E5E7EB] divide-y divide-[#F1F5F9]">{children}</div>
    </section>
  )
}

export function SettingRow({ icon, title, subtitle, children }: { icon?: ReactNode; title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 md:px-5">
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-medium text-[#111827]">{title}</p>
        {subtitle && <div className="text-[13px] text-[#64748B] mt-0.5">{subtitle}</div>}
      </div>
      {children}
    </div>
  )
}

export function SmallIcon({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'blue' }) {
  return (
    <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${tone === 'blue' ? 'bg-[#EFF6FF] text-[#2563EB]' : 'bg-[#F1F5F9] text-[#475569]'}`}>
      {children}
    </span>
  )
}

/** Hoja inferior en móvil / diálogo centrado en md+. [H3] Se cierra con Esc, tocando fuera o con Cancelar. */
export function Sheet({ labelledBy, onClose, children, tall }: { labelledBy: string; onClose: () => void; children: ReactNode; tall?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <div className="absolute inset-0 bg-[#0F172A]/40" onClick={onClose} />
      <div className={`relative w-full md:max-w-md bg-white rounded-t-2xl md:rounded-xl px-4 pt-3 pb-[calc(16px+env(safe-area-inset-bottom))] md:p-6 flex flex-col ${tall ? 'max-h-[88dvh]' : ''}`}>
        <div className="w-10 h-1 rounded-full bg-[#E5E7EB] mx-auto mb-4 md:hidden flex-shrink-0" />
        {children}
      </div>
    </div>
  )
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <ul aria-hidden="true" className="divide-y divide-[#F1F5F9]">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3.5 md:px-6 md:gap-4">
          <span className="w-10 h-10 rounded-full bg-[#F1F5F9] motion-safe:animate-pulse flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-3/5 rounded bg-[#F1F5F9] motion-safe:animate-pulse" />
            <div className="h-3 w-2/5 rounded bg-[#F1F5F9] motion-safe:animate-pulse" />
          </div>
        </li>
      ))}
    </ul>
  )
}
