import { I } from '@/components/icons'
import { SkeletonList } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { FilterChips, NotifDetail, NotifList } from '@/components/notifications'
import { activeCategories, TYPE_CFG } from '@/utils/notifTypes'
import { linkCls } from '@/utils/styles'
import type { Filter, Notif, Settings, SyncProps } from '@/types'

export function NotificationsPage({ notifs, settings, filter, setFilter, selectedId, onOpen, onClose, onMarkAll, onMarkUnread, sync }: {
  notifs: Notif[]; settings: Settings; filter: Filter; setFilter: (f: Filter) => void; selectedId: number | null
  onOpen: (id: number) => void; onClose: () => void; onMarkAll: () => void; onMarkUnread: (id: number) => void; sync: SyncProps
}) {
  const enabled = activeCategories(settings)
  const filtered = filter === 'todas' ? notifs : notifs.filter(n => n.type === filter)
  const selected = notifs.find(n => n.id === selectedId) ?? null
  const unread = notifs.filter(n => n.unread).length

  return (
    <div className="lg:flex lg:h-dvh">
      <section className={`${selected ? 'hidden lg:flex' : 'flex'} flex-col lg:w-[420px] lg:flex-shrink-0 lg:border-r border-[#E5E7EB] lg:bg-white`}>
        <div className="px-4 pt-5 pb-4 md:px-8 md:pt-8 lg:px-6 lg:pt-7 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-[24px] md:text-[28px] leading-tight font-semibold text-[#111827] tracking-[-0.02em]">Notificaciones</h1>
              {/* [H8] El subtítulo decorativo se quita en móvil, donde el espacio es más valioso */}
              <p className="hidden md:block text-[14px] text-[#64748B] mt-1">Mantente al día con tu información académica.</p>
            </div>
            {/* [H7] Atajo para quien revisa todo de un vistazo */}
            {unread > 0 && !sync.firstRun && (
              <button onClick={onMarkAll} className={`${linkCls} font-medium px-2 -mr-2 text-[#2563EB] whitespace-nowrap`}>{I.check(16)}Marcar todo leído</button>
            )}
          </div>
          <SyncStatus status={settings.itsonStatus} {...sync} />
          <FilterChips value={filter} onChange={setFilter} types={enabled} items={notifs} />
        </div>
        <div className="bg-white border-y md:border md:mx-8 md:rounded-lg lg:mx-0 lg:border-0 lg:border-t lg:rounded-none border-[#E5E7EB] lg:flex-1 lg:overflow-y-auto">
          {sync.firstRun
            ? <SkeletonList rows={6} />
            : <NotifList items={filtered} selectedId={selectedId} onOpen={onOpen}
                emptyText={filter === 'todas' ? undefined : `No tienes notificaciones de ${TYPE_CFG[filter].label.toLowerCase()} por ahora.`} />}
        </div>
      </section>

      <section className={`${selected ? 'block' : 'hidden lg:flex'} lg:flex-1 lg:overflow-y-auto bg-white lg:bg-[#F8FAFC] min-h-[calc(100dvh-57px)] md:min-h-dvh lg:min-h-0`}>
        {selected ? (
          <NotifDetail n={selected} onBack={onClose} onMarkUnread={() => onMarkUnread(selected.id)} />
        ) : (
          <div className="m-auto flex flex-col items-center gap-3 p-8 text-[#64748B]">
            <span className="opacity-20">{I.bell(36)}</span>
            <p className="text-[14px] text-center">Selecciona una notificación para ver su detalle.</p>
          </div>
        )}
      </section>
    </div>
  )
}
