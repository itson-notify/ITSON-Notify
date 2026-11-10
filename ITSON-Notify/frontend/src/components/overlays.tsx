import { useState } from 'react'
import { I } from './icons'
import { Button, Sheet } from './ui'
import { FAQ } from '@/services/mockData'
import { focusRing, norm } from '@/utils/styles'
import type { ConfirmReq } from '@/types'

/** [H5] Confirmación antes de acciones que quitan algo al alumno. */
export function ConfirmDialog({ req, onClose }: { req: ConfirmReq; onClose: () => void }) {
  return (
    <Sheet labelledBy="confirm-title" onClose={onClose}>
      <h2 id="confirm-title" className="text-[18px] font-semibold text-[#111827]">{req.title}</h2>
      <p className="text-[14px] leading-relaxed text-[#64748B] mt-1.5">{req.body}</p>
      <div className="mt-6 space-y-2 md:flex md:flex-row-reverse md:space-y-0 md:gap-2">
        <Button full variant={req.danger ? 'dangerSolid' : 'primary'} onClick={() => { req.onConfirm(); onClose() }}>{req.label}</Button>
        <Button full variant="ghost" onClick={onClose}>Cancelar</Button>
      </div>
    </Sheet>
  )
}

/** [H1] + [H3] Mensaje breve de confirmación, con “Deshacer” cuando aplica. */
export function ToastView({ toast, onClose }: { toast: { text: string; undo?: () => void } | null; onClose: () => void }) {
  return (
    <div aria-live="polite" className="fixed z-40 left-4 right-4 bottom-[calc(80px+env(safe-area-inset-bottom))] md:left-auto md:right-6 md:bottom-6 md:w-[380px] pointer-events-none">
      {toast && (
        <div className="pointer-events-auto flex items-center gap-3 rounded-lg bg-[#111827] text-white pl-4 pr-2 py-2 min-h-12 shadow-lg">
          <span className="flex-1 text-[14px]">{toast.text}</span>
          {toast.undo && (
            <button onClick={() => { toast.undo!(); onClose() }} className={`min-h-9 px-3 rounded-md text-[14px] font-semibold text-[#93C5FD] hover:bg-white/10 cursor-pointer ${focusRing}`}>Deshacer</button>
          )}
          <button onClick={onClose} aria-label="Cerrar mensaje" className={`w-9 h-9 flex items-center justify-center rounded-md text-white/60 hover:text-white cursor-pointer ${focusRing}`}>{I.x(16)}</button>
        </div>
      )}
    </div>
  )
}

/** [H10] Ayuda buscable, se puede abrir ya filtrada desde el lugar donde surge la duda. */
export function HelpSheet({ initialQuery, onClose }: { initialQuery: string; onClose: () => void }) {
  const [q, setQ] = useState(initialQuery)
  const items = FAQ.filter(f => norm(`${f.q} ${f.a}`).includes(norm(q.trim())))
  return (
    <Sheet labelledBy="help-title" onClose={onClose} tall>
      <div className="flex items-center justify-between flex-shrink-0">
        <h2 id="help-title" className="text-[18px] font-semibold text-[#111827]">Ayuda</h2>
        <button onClick={onClose} aria-label="Cerrar ayuda" className={`w-10 h-10 -mr-2 flex items-center justify-center rounded-lg text-[#64748B] hover:text-[#111827] cursor-pointer ${focusRing}`}>{I.x(18)}</button>
      </div>
      <div className="relative mt-3 flex-shrink-0">
        <label htmlFor="help-search" className="sr-only">Buscar en la ayuda</label>
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#94A3B8]">{I.search(16)}</span>
        <input id="help-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar, por ejemplo “contraseña”"
          className="w-full h-11 rounded-lg border border-[#E5E7EB] pl-10 pr-3.5 text-[16px] md:text-[15px] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#2563EB] focus:ring-4 focus:ring-[#2563EB]/15" />
      </div>
      <div className="mt-3 -mx-1 px-1 overflow-y-auto space-y-2 flex-1">
        {items.map((f, i) => (
          <details key={f.q + q} open={q.trim() !== '' && i === 0} className="group rounded-lg border border-[#E5E7EB]">
            <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden text-[15px] font-medium text-[#111827]">
              {f.q}<span className="text-[#94A3B8] transition-transform group-open:rotate-90 flex-shrink-0">{I.chevron()}</span>
            </summary>
            <p className="px-4 pb-4 text-[14px] leading-relaxed text-[#475569]">{f.a}</p>
          </details>
        ))}
        {items.length === 0 && <p className="py-6 text-center text-[14px] text-[#64748B]">No encontramos nada con “{q}”. Prueba con otra palabra o escríbenos.</p>}
      </div>
      <div className="mt-4 flex-shrink-0">
        {/* TODO: correo real de soporte */}
        <Button full variant="secondary">{I.mail(18)}Escribir a soporte</Button>
      </div>
    </Sheet>
  )
}
