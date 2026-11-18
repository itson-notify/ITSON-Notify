import type { ReactElement } from 'react'
import { I } from '@/components/icons'
import { Button } from '@/components/ui'
import type { StudentView } from '@/utils/student'
import type { Page, Settings } from '@/types'

export function ProfilePage({ student, matriculaHint = null, onGo, onLogout, onHelp }: {
  student: StudentView; settings: Settings; matriculaHint?: string | null; onGo: (p: Page) => void; onLogout: () => void; onHelp: (q: string) => void
}) {
  const options: { label: string; icon: ReactElement; action: () => void }[] = [
    { label: 'Cuentas y avisos', icon: I.settings(18), action: () => onGo('configuracion') },
    { label: 'Ayuda y soporte', icon: I.help(18), action: () => onHelp('') },
  ]
  return (
    <div className="py-5 md:px-8 md:py-8 lg:px-10 max-w-2xl">
      <div className="bg-white border-y md:border md:rounded-lg border-[#E5E7EB] px-4 py-6 flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-full bg-[#2563EB] flex items-center justify-center text-white text-[22px] font-semibold" aria-hidden="true">{student.initials || I.user(28)}</div>
        {/* ITN-58 - Sin mock la API no da el nombre: se muestra el correo de la sesión. */}
        <h1 className="mt-3 text-[20px] font-semibold text-[#111827] break-all">{student.name ?? student.email ?? 'Tu cuenta'}</h1>
        {student.name && student.email && <p className="text-[14px] text-[#64748B] mt-0.5 break-all">{student.email}</p>}
        {student.career && <p className="text-[14px] text-[#64748B] mt-0.5">{student.career}</p>}
        {/* ITN-55 - Solo la pista de /api/itson-profile, nunca la matrícula completa. */}
        <p className="text-[13px] text-[#94A3B8] mt-1">Matrícula {matriculaHint || '—'}</p>
      </div>

      <ul className="mt-4 bg-white border-y md:border md:rounded-lg border-[#E5E7EB] divide-y divide-[#F1F5F9]">
        {options.map(o => (
          <li key={o.label}>
            <button onClick={o.action} className="w-full flex items-center gap-3 px-4 py-4 hover:bg-[#F8FAFC] cursor-pointer text-left outline-none focus-visible:bg-[#EFF6FF]">
              <span className="text-[#64748B]">{o.icon}</span>
              <span className="flex-1 text-[15px] text-[#111827]">{o.label}</span>
              <span className="text-[#CBD5E1]">{I.chevron()}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4 px-4 md:px-0 space-y-3">
        <Button full variant="danger" onClick={onLogout}>{I.logout()}Cerrar sesión</Button>
        <p className="text-[12px] text-center text-[#94A3B8]">ITSON Notify es un proyecto estudiantil, no un servicio oficial de ITSON.</p>
      </div>
    </div>
  )
}
