/** Persona tab. */
import { Skeleton } from '../controls.tsx'
import { usePanel } from '../provider.tsx'

export function PersonaPage() {
  const { t } = usePanel()
  return <Skeleton label={t('common.loading')} />
}
