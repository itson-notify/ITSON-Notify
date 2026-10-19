import type { ReactNode } from 'react'
import { I, type IconFn } from '@/components/icons'
import { STUDENT } from '@/services/mockData'
import { focusRing } from '@/utils/styles'
import type { Page } from '@/types'

/* Estilos base = teléfono. `md:` (≥768px) agrega sidebar; en móvil hay header y barra inferior. */

const NAV: { key: Page; label: string; icon: IconFn }[] = [
  { key: 'inicio', label: 'Inicio', icon: I.house },
  { key: 'notificaciones', label: 'Notificaciones', icon: I.bell },
  { key: 'configuracion', label: 'Configuración', icon: I.settings },
  { key: 'perfil', label: 'Perfil', icon: I.user },
]

export function AppLayout({ page, unread, itsonError, onGo, onHelp, onLogout, children }: {
  page: Page; unread: number; itsonError: boolean; onGo: (p: Page) => void; onHelp: () => void; onLogout: () => void; children: ReactNode
}) {
  // [H4] Mismo color con el mismo significado en sidebar, barra inferior y encabezado:
  // azul = sin leer, naranja = requiere atención
  const badge = (key: Page) =>
    key === 'notificaciones' && unread > 0 ? { text: String(unread), label: `${unread} sin leer`, tone: 'bg-[#2563EB]' }
    : key === 'configuracion' && itsonError ? { text: '!', label: 'Requiere atención', tone: 'bg-[#F97316]' }
    : null

  return (
    <div className="min-h-dvh bg-[#F8FAFC] md:flex">
      {/* Sidebar (md+) */}
      <aside className="hidden md:flex md:flex-col md:sticky md:top-0 md:h-dvh w-[230px] flex-shrink-0 bg-white border-r border-[#E5E7EB]">
        <div className="px-5 py-5 border-b border-[#E5E7EB] flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-[#2563EB] text-white flex items-center justify-center">{I.bell(15)}</span>
          <span className="text-[15px] font-semibold text-[#111827] tracking-[-0.01em]">ITSON Notify</span>
        </div>
        <nav className="flex-1 px-3 py-4 flex flex-col gap-1" aria-label="Principal">
          {NAV.map(item => {
            const b = badge(item.key)
            const active = page === item.key
            return (
              <button key={item.key} onClick={() => onGo(item.key)} aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-[15px] font-medium transition-colors cursor-pointer ${focusRing} ${active ? 'bg-[#EFF6FF] text-[#2563EB]' : 'text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#111827]'}`}>
                {item.icon()}<span className="flex-1 text-left">{item.label}</span>
                {b && <span aria-label={b.label} className={`min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold flex items-center justify-center text-white ${b.tone}`}>{b.text}</span>}
              </button>
            )
          })}
        </nav>
        <div className="border-t border-[#E5E7EB] px-4 py-5">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-9 h-9 rounded-full bg-[#2563EB] text-white text-[13px] font-semibold flex items-center justify-center flex-shrink-0">{STUDENT.initials}</span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[#111827] truncate">{STUDENT.name}</p>
              <p className="text-[11px] text-[#64748B] truncate">{STUDENT.career}</p>
            </div>
          </div>
          <button onClick={onHelp} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#111827] cursor-pointer ${focusRing}`}>
            {I.help(18)}Ayuda
          </button>
          <button onClick={onLogout} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-[#64748B] hover:bg-[#FEF2F2] hover:text-[#DC2626] cursor-pointer ${focusRing}`}>
            {I.logout()}Cerrar sesión
          </button>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Header móvil */}
        <header className="md:hidden sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-[#E5E7EB] px-4 pt-[env(safe-area-inset-top)]">
          <div className="h-14 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-[#2563EB] text-white flex items-center justify-center">{I.bell(13)}</span>
              <span className="text-[15px] font-semibold text-[#111827]">ITSON Notify</span>
            </div>
            <button onClick={() => onGo('notificaciones')} aria-label={`Notificaciones, ${unread} sin leer`}
              className={`relative w-11 h-11 -mr-2 flex items-center justify-center rounded-lg text-[#64748B] hover:text-[#2563EB] cursor-pointer ${focusRing}`}>
              {I.bell(21)}
              {unread > 0 && <span className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-[#2563EB] ring-2 ring-white" />}
            </button>
          </div>
        </header>

        <main className="flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] md:pb-0">{children}</main>
      </div>

      {/* Bottom navigation (móvil) */}
      <nav aria-label="Principal" className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-[#E5E7EB] flex pb-[env(safe-area-inset-bottom)]">
        {NAV.map(item => {
          const b = badge(item.key)
          const active = page === item.key
          return (
            <button key={item.key} onClick={() => onGo(item.key)} aria-current={active ? 'page' : undefined}
              className={`relative flex-1 flex flex-col items-center gap-1 pt-2.5 pb-2 min-h-[60px] cursor-pointer ${focusRing} ${active ? 'text-[#2563EB]' : 'text-[#64748B]'}`}>
              <span className="relative">
                {item.icon(22)}
                {b && <span aria-label={b.label} className={`absolute -top-1.5 -right-2.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold text-white flex items-center justify-center ring-2 ring-white ${b.tone}`}>{b.text}</span>}
              </span>
              <span className="text-[11px] font-medium">{item.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
