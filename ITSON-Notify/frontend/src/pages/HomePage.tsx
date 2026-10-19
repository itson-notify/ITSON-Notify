import { I } from '@/components/icons'
import { TypeIcon } from '@/components/ui'
import { PageTitle } from '@/components/PageTitle'
import { SyncStatus } from '@/components/SyncStatus'
import { NotifList } from '@/components/notifications'
import { SkeletonList } from '@/components/ui'
import { STUDENT } from '@/services/mockData'
import { activeCategories, TYPE_CFG } from '@/utils/notifTypes'
import { focusRing, linkCls } from '@/utils/styles'
import type { Filter, Notif, Page, Settings, SyncProps } from '@/types'

export function HomePage({ notifs, settings, sync, onOpen, onFilter, onGo, showClassroomPrompt, onDismissPrompt }: {
  notifs: Notif[]; settings: Settings; sync: SyncProps
  onOpen: (id: number) => void; onFilter: (f: Filter) => void; onGo: (p: Page) => void; showClassroomPrompt: boolean; onDismissPrompt: () => void
}) {
  const enabled = activeCategories(settings)
  return (
    <div className="py-5 md:px-8 md:py-8 lg:px-10 max-w-5xl">
      <PageTitle title={`Hola, ${STUDENT.name.split(' ')[0]}`} subtitle="Esto es lo nuevo desde tu última visita." />

      <div className="mt-4 px-4 md:px-0">
        <SyncStatus status={settings.itsonStatus} {...sync} />
      </div>

      {showClassroomPrompt && (
        <div className="mt-4 mx-4 md:mx-0 flex items-center gap-3 rounded-lg border border-[#E5E7EB] bg-white pl-3.5 pr-1.5 py-2">
          <span className="w-9 h-9 rounded-lg bg-[#F5F3FF] text-[#7C3AED] flex items-center justify-center flex-shrink-0">{I.book(18)}</span>
          <p className="flex-1 min-w-0 text-[13px] text-[#475569]">Conecta Google Classroom para recibir tus tareas.</p>
          <button onClick={() => onGo('configuracion')} className={`${linkCls} px-2 text-[#2563EB] flex-shrink-0`}>Conectar</button>
          {/* [H3] + [H8] Se puede quitar si no le interesa */}
          <button onClick={onDismissPrompt} aria-label="Ocultar sugerencia" className={`w-9 h-9 flex items-center justify-center rounded-md text-[#94A3B8] hover:text-[#111827] cursor-pointer flex-shrink-0 ${focusRing}`}>{I.x(16)}</button>
        </div>
      )}

      <div className="mt-5 px-4 md:px-0 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {enabled.map(t => {
          const count = notifs.filter(n => n.type === t && n.unread).length
          return (
            <button key={t} onClick={() => { onFilter(t); onGo('notificaciones') }} disabled={sync.firstRun}
              className={`text-left bg-white border border-[#E5E7EB] rounded-lg p-4 hover:border-[#CBD5E1] transition-colors cursor-pointer disabled:cursor-default ${focusRing}`}>
              <div className="flex items-center justify-between">
                {sync.firstRun
                  ? <span className="h-7 w-8 rounded bg-[#F1F5F9] motion-safe:animate-pulse" aria-hidden="true" />
                  : <span className={`text-[28px] font-semibold leading-none ${count ? 'text-[#111827]' : 'text-[#CBD5E1]'}`}>{count}</span>}
                <TypeIcon type={t} size={30} />
              </div>
              <p className="text-[13px] text-[#64748B] mt-2 leading-snug">{TYPE_CFG[t].stat.charAt(0).toUpperCase() + TYPE_CFG[t].stat.slice(1)}</p>
            </button>
          )
        })}
      </div>

      <div className="mt-8 mb-3 px-4 md:px-0 flex items-center justify-between">
        <h2 className="text-[18px] md:text-[20px] font-semibold text-[#111827]">Actividad reciente</h2>
        <button onClick={() => { onFilter('todas'); onGo('notificaciones') }} className={`${linkCls} font-medium px-2 -mr-2 text-[#2563EB]`}>Ver todas</button>
      </div>
      <div className="bg-white border-y md:border md:rounded-lg border-[#E5E7EB] overflow-hidden">
        {sync.firstRun ? <SkeletonList /> : <NotifList items={notifs.slice(0, 5)} onOpen={onOpen} />}
      </div>
    </div>
  )
}
