import { I } from './icons'
import { focusRing, linkCls } from '@/utils/styles'
import type { SourceStatus } from '@/types'

/** [H1] Siempre visible: cuándo se revisó, si está revisando o si algo falló. */
export function SyncStatus({ status, syncing, firstRun, onSync, onFix, onHelp }: {
  status: SourceStatus; syncing: boolean; firstRun: boolean; onSync: () => void; onFix: () => void; onHelp: (q: string) => void
}) {
  if (status === 'error') {
    return (
      <div role="alert" className="rounded-lg border border-[#FED7AA] bg-[#FFF7ED] p-3.5 flex gap-3">
        <span className="text-[#EA580C] mt-0.5 flex-shrink-0">{I.alert(18)}</span>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-[#9A3412]">No pudimos revisar tu portal ITSON</p>
          <p className="text-[13px] leading-relaxed text-[#9A3412]/85 mt-0.5">Tal vez cambiaste tu contraseña. Mientras tanto no recibirás calificaciones, cupos ni trámites.</p>
          <div className="mt-1.5 flex flex-wrap gap-x-4">
            <button onClick={onFix} className={`${linkCls} text-[#C2410C]`}>Actualizar contraseña</button>
            <button onClick={() => onHelp('cambio mi contraseña')} className={`${linkCls} font-medium text-[#9A3412]/80`}>¿Por qué pasa esto?</button>
          </div>
        </div>
      </div>
    )
  }
  const busy = syncing || firstRun
  return (
    <div className="flex items-center justify-between gap-3 text-[13px] text-[#64748B]">
      <span className="flex items-center gap-2" aria-live="polite">
        <span className={`w-2 h-2 rounded-full ${busy ? 'bg-[#F59E0B] motion-safe:animate-pulse' : 'bg-[#22C55E]'}`} />
        {firstRun ? 'Haciendo tu primera revisión…' : syncing ? 'Revisando tus portales…' : 'Última revisión hace 8 min'}
      </span>
      <button onClick={onSync} disabled={busy}
        className={`flex items-center gap-1.5 min-h-9 px-2 -mr-2 rounded-md font-medium text-[#2563EB] hover:bg-[#EFF6FF] disabled:opacity-50 cursor-pointer disabled:cursor-default ${focusRing}`}>
        <span className={busy ? 'motion-safe:animate-spin' : ''}>{I.refresh(14)}</span>Revisar ahora
      </button>
    </div>
  )
}
