/** Settings tab. */
import { Skeleton } from '../controls.tsx'
import { usePanel } from '../provider.tsx'

export function SettingsPage() {
  const { t } = usePanel()
  return <Skeleton label={t('common.loading')} />
}
