import { I } from './icons'
import { Button, TypeIcon } from './ui'
import { TYPE_CFG } from '@/utils/notifTypes'
import { focusRing, linkCls } from '@/utils/styles'
import type { Filter, Notif, NotifType } from '@/types'

export function NotifRow({ n, selected, onClick }: { n: Notif; selected?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-current={selected ? 'true' : undefined}
      className={`w-full text-left flex items-center gap-3 px-4 py-3.5 md:px-6 md:gap-4 transition-colors cursor-pointer group outline-none focus-visible:bg-[#EFF6FF] ${selected ? 'bg-[#EFF6FF]' : 'hover:bg-[#F8FAFC]'}`}>
      <TypeIcon type={n.type} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-[15px] truncate ${n.unread ? 'font-semibold text-[#111827]' : 'font-medium text-[#334155]'}`}>{n.title}</span>
          {n.unread && <span className="w-2 h-2 rounded-full bg-[#2563EB] flex-shrink-0"><span className="sr-only">Sin leer</span></span>}
        </div>
        <div className="flex items-baseline justify-between gap-2 mt-0.5">
          <span className="text-[13px] text-[#64748B] truncate">{n.subject}</span>
          <span className="text-[12px] text-[#94A3B8] flex-shrink-0">{n.time}</span>
        </div>
      </div>
      <span className={`flex-shrink-0 transition-colors ${selected ? 'text-[#2563EB]' : 'text-[#CBD5E1] group-hover:text-[#2563EB]'}`}>{I.chevron()}</span>
    </button>
  )
}

export function NotifList({ items, selectedId, onOpen, emptyText }: { items: Notif[]; selectedId?: number | null; onOpen: (id: number) => void; emptyText?: string }) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center py-14 px-6 text-center text-[#64748B] gap-2">
        <span className="opacity-30">{I.bell(28)}</span>
        <p className="text-[14px]">{emptyText ?? 'No hay notificaciones aquí todavía.'}</p>
      </div>
    )
  }
  return (
    <ul className="divide-y divide-[#F1F5F9]">
      {items.map(n => <li key={n.id}><NotifRow n={n} selected={selectedId === n.id} onClick={() => onOpen(n.id)} /></li>)}
    </ul>
  )
}

export function FilterChips({ value, onChange, types, items }: { value: Filter; onChange: (f: Filter) => void; types: NotifType[]; items: Notif[] }) {
  const options: { key: Filter; label: string }[] = [{ key: 'todas', label: 'Todas' }, ...types.map(t => ({ key: t as Filter, label: TYPE_CFG[t].label }))]
  return (
    <div className="-mx-4 px-4 md:mx-0 md:px-0 flex gap-2 overflow-x-auto md:flex-wrap md:overflow-visible [scrollbar-width:none]" role="tablist" aria-label="Filtrar notificaciones">
      {options.map(o => {
        const active = value === o.key
        // [H6] El conteo deja ver qué hay en cada filtro sin tener que abrirlo
        const count = o.key === 'todas' ? items.length : items.filter(n => n.type === o.key).length
        return (
          <button key={o.key} role="tab" aria-selected={active} onClick={() => onChange(o.key)}
            className={`flex-shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-[14px] font-medium border transition-colors cursor-pointer ${focusRing} ${active ? 'bg-[#2563EB] text-white border-[#2563EB]' : 'bg-white text-[#64748B] border-[#E5E7EB] hover:border-[#2563EB] hover:text-[#2563EB]'}`}>
            {o.label}<span className={`text-[12px] ${active ? 'text-white/75' : 'text-[#94A3B8]'}`}>{count}</span>
          </button>
        )
      })}
    </div>
  )
}

export function NotifDetail({ n, onBack, onMarkUnread }: { n: Notif; onBack: () => void; onMarkUnread: () => void }) {
  const cfg = TYPE_CFG[n.type]
  return (
    <article className="px-4 py-4 md:px-8 md:py-8 max-w-xl lg:mx-auto">
      <button onClick={onBack} className={`lg:hidden -ml-2 mb-4 flex items-center gap-2 min-h-11 px-2 rounded-lg text-[15px] font-medium text-[#64748B] hover:text-[#111827] cursor-pointer ${focusRing}`}>
        {I.arrow()}Notificaciones
      </button>

      <div className="flex items-start gap-4">
        <TypeIcon type={n.type} size={48} />
        <div className="min-w-0 pt-0.5">
          <h1 className="text-[20px] md:text-[22px] leading-snug font-semibold text-[#111827] tracking-[-0.01em]">{n.title}</h1>
          <p className="text-[13px] text-[#94A3B8] mt-1">{n.time}, desde {cfg.source}</p>
        </div>
      </div>

      <p className="mt-5 text-[15px] leading-relaxed text-[#334155]">{n.body}</p>

      <dl className="mt-5 bg-white border border-[#E5E7EB] rounded-lg divide-y divide-[#F1F5F9]">
        {n.rows.map(r => (
          <div key={r.label} className="flex justify-between items-center gap-4 px-4 py-3">
            <dt className="text-[13px] text-[#64748B]">{r.label}</dt>
            <dd className="text-[14px] font-semibold text-[#111827] text-right">{r.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5">
        <Button full>{cfg.cta}{I.external()}</Button>
      </div>

      {/* [H3] Salida para quien la abrió por error o quiere revisarla luego */}
      <div className="mt-2 flex justify-center">
        <button onClick={onMarkUnread} className={`${linkCls} font-medium text-[#64748B] px-2`}>Marcar como no leída</button>
      </div>

      <p className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-[#94A3B8]">
        <span className="mt-0.5 flex-shrink-0">{I.info()}</span>{cfg.note}
      </p>
    </article>
  )
}
