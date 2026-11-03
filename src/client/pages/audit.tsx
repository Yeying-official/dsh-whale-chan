/** Audit tab. */
import { Skeleton } from '../controls.tsx'
import { usePanel } from '../provider.tsx'

export function AuditPage() {
  const { t } = usePanel()
  return <Skeleton label={t('common.loading')} />
}
