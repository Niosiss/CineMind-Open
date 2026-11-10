import { CATALOG_SOURCE_INFO } from '../i18n'
import type { CatalogSource } from '../types'

/**
 * Catalog source indicator: tells the user where the current catalog
 * or recommendations come from without vendor claims.
 */
export function SourceBadge({ source }: { source: CatalogSource | undefined | null }) {
  if (!source) return null
  const info = CATALOG_SOURCE_INFO[source]
  return (
    <span
      className={`source-badge ${source === 'live' ? 'source-badge-live' : 'source-badge-local'}`}
      title={info.hint}
      aria-label={`Data source: ${info.label}. ${info.hint}`}
    >
      <span className="source-dot" aria-hidden="true" />
      {info.label}
    </span>
  )
}
