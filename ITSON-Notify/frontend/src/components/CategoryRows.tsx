import { SettingRow, Toggle, TypeIcon } from './ui'
import { activeCategories, TYPE_CFG, TYPES } from '@/utils/notifTypes'
import type { SetSettings, Settings } from '@/types'

export function CategoryRows({ settings, setSettings }: { settings: Settings; setSettings: SetSettings }) {
  const active = activeCategories(settings)
  return (
    <>
      {TYPES.map(t => {
        const blocked = t === 'tareas' && !settings.classroomConnected
        const on = settings.categories[t] && !blocked
        const isLast = on && active.length === 1
        return (
          <SettingRow key={t} icon={<TypeIcon type={t} size={36} />} title={TYPE_CFG[t].label}
            subtitle={blocked ? 'Requiere conectar Google Classroom' : isLast ? 'Debe quedar al menos una activada' : TYPE_CFG[t].desc}>
            <Toggle label={TYPE_CFG[t].label} on={on} disabled={blocked || isLast}
              onChange={v => setSettings(s => ({ ...s, categories: { ...s.categories, [t]: v } }))} />
          </SettingRow>
        )
      })}
    </>
  )
}
