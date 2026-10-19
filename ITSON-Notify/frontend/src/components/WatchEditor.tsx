import { useState } from 'react'
import { I } from './icons'
import { SUGGESTED_COURSES } from '@/services/mockData'
import { focusRing, norm } from '@/utils/styles'

/** Editor de materias vigiladas (se usa en onboarding y en configuración). */
export function WatchEditor({ list, onChange, onRemoved }: {
  list: string[]; onChange: (update: (l: string[]) => string[]) => void; onRemoved?: (name: string, undo: () => void) => void
}) {
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState('')

  const add = (name: string) => {
    const v = name.trim()
    if (!v) return
    const existing = list.find(x => norm(x) === norm(v))
    // [H5] + [H9] En vez de ignorar el duplicado en silencio, se explica
    if (existing) { setMsg(`Ya estás vigilando ${existing}.`); return }
    onChange(l => [...l, v])
    setQ('')
    setMsg('')
  }
  const remove = (m: string) => {
    onChange(l => l.filter(x => x !== m))
    onRemoved?.(m, () => onChange(l => (l.includes(m) ? l : [...l, m])))
  }

  // [H6] Autocompletado: el alumno reconoce su materia en vez de recordar el nombre exacto
  const nq = norm(q.trim())
  const matches = SUGGESTED_COURSES.filter(s => !list.includes(s) && (!nq || norm(s).includes(nq)))

  return (
    <div className="px-4 py-4 md:px-5 space-y-4">
      {list.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Materias vigiladas">
          {list.map(m => (
            <li key={m} className="inline-flex items-center gap-1 rounded-lg bg-[#FFF7ED] text-[#9A3412] border border-[#FED7AA] pl-3 pr-1 py-1 text-[14px]">
              {m}
              <button type="button" onClick={() => remove(m)} aria-label={`Dejar de vigilar ${m}`}
                className={`w-7 h-7 flex items-center justify-center rounded-md hover:bg-[#FFEDD5] cursor-pointer ${focusRing}`}>{I.x(14)}</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-[#64748B]">Todavía no vigilas ninguna materia.</p>
      )}

      <form onSubmit={e => { e.preventDefault(); add(q) }}>
        <div className="flex gap-2">
          <label htmlFor="watch-input" className="sr-only">Nombre o clave de la materia</label>
          <input id="watch-input" value={q} onChange={e => { setQ(e.target.value); setMsg('') }} placeholder="Nombre o clave de la materia"
            aria-describedby={msg ? 'watch-msg' : undefined}
            className="flex-1 min-w-0 h-11 rounded-lg border border-[#E5E7EB] px-3.5 text-[16px] md:text-[15px] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#2563EB] focus:ring-4 focus:ring-[#2563EB]/15" />
          <button type="submit" disabled={!q.trim()}
            className={`h-11 px-4 rounded-lg bg-[#111827] text-white text-[14px] font-medium disabled:bg-[#CBD5E1] cursor-pointer disabled:cursor-not-allowed ${focusRing}`}>Agregar</button>
        </div>
        {msg && <p id="watch-msg" role="status" className="mt-1.5 text-[13px] text-[#C2410C]">{msg}</p>}
      </form>

      {matches.length > 0 && (
        <div>
          <p className="text-[12px] text-[#64748B] mb-2">{nq ? 'Coincidencias en tus materias' : 'Materias de tu próximo periodo'}</p>
          <div className="flex flex-wrap gap-2">
            {matches.map(s => (
              <button key={s} type="button" onClick={() => add(s)}
                className={`inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[#CBD5E1] px-3 py-2 text-[13px] text-[#334155] hover:border-[#2563EB] hover:text-[#2563EB] cursor-pointer ${focusRing}`}>
                {I.plus(14)}{s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
