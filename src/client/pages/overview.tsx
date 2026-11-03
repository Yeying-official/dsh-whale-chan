/** Overview tab. */
import { Skeleton } from '../controls.tsx'
import { usePanel } from '../provider.tsx'

export function OverviewPage() {
  const { t } = usePanel()
  return <Skeleton label={t('common.loading')} />
}
