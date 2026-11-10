import { ratingSourceLabel } from '../i18n'
import type { Kind, RatingEntry } from '../types'
import { StarIcon } from './icons'

function normalizeSource(source?: string): string {
  return typeof source === 'string' ? source.trim().toLowerCase().replace(/[\s_-]+/g, '') : ''
}

interface RatingPillProps {
  rating?: number
  ratingSource?: string
  ratingCount?: number
  scale?: number
  compact?: boolean
  /** Kept for caller compatibility; sources are no longer filtered. */
  kind?: Kind
  allowAnimeSources?: boolean
}

function formatRating(rating: number): string {
  return rating.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function formatVotes(count: number): string {
  return count.toLocaleString('en-US')
}

function resolveScale(scale: number | undefined): number {
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 10
}

/**
 * Source-labelled rating badge: "7.4/10 · IMDb" or "81% · Rotten Tomatoes".
 * Any rating source supplied by the local catalog is shown as-is; no
 * source is invented or relabelled as another provider.
 */
export function RatingPill({
  rating,
  ratingSource,
  ratingCount,
  scale,
  compact,
}: RatingPillProps) {
  const resolvedScale = resolveScale(scale)
  if (typeof rating !== 'number' || !Number.isFinite(rating)) return null
  if (rating < 0 || rating > resolvedScale) return null

  const source = ratingSourceLabel(ratingSource) || ratingSource?.trim() || ''
  if (source === '') return null
  const display =
    resolvedScale === 100
      ? `${formatRating(rating)}%`
      : `${formatRating(rating)}/${formatRating(resolvedScale)}`
  const parts = [
    display,
    source,
    typeof ratingCount === 'number' ? `${formatVotes(ratingCount)} votes` : '',
  ].filter(Boolean)
  const ariaText = `${source} rating: ${parts.join(' — ')}`

  return (
    <span
      className={`rating-pill${compact ? ' rating-pill-compact' : ''}`}
      title={ariaText}
    >
      <span className="rating-star" aria-hidden="true"><StarIcon size={12} /></span>
      <span className="rating-value">
        {formatRating(rating)}
        <span className="rating-max">{resolvedScale === 100 ? '%' : `/${formatRating(resolvedScale)}`}</span>
      </span>
      <span className="rating-source">{source}</span>
      {typeof ratingCount === 'number' ? (
        <span className="rating-votes">({formatVotes(ratingCount)})</span>
      ) : null}
      <span className="visually-hidden">{ariaText}</span>
    </span>
  )
}

interface RatingBadgesProps {
  ratings?: RatingEntry[]
  rating?: number
  ratingSource?: string
  ratingCount?: number
  limit?: number
  compact?: boolean
  className?: string
  /** Show a quiet placeholder when there is no rating. */
  showMissing?: boolean
  /** Kept for caller compatibility; sources are no longer filtered. */
  kind?: Kind
  allowAnimeSources?: boolean
}

/**
 * Source-labelled rating badges. Any valid rating entry from the local
 * catalog is shown; the primary rating is used as a fallback. Missing
 * ratings never produce a made-up value.
 */
export function RatingBadges({
  ratings,
  rating,
  ratingSource,
  ratingCount,
  limit,
  compact,
  className = '',
  showMissing,
}: RatingBadgesProps) {
  const valid = Array.isArray(ratings)
    ? ratings.filter(
        (r) =>
          r &&
          typeof r.source === 'string' &&
          r.source.trim() !== '' &&
          typeof r.value === 'number' &&
          Number.isFinite(r.value) &&
          typeof r.scale === 'number' &&
          Number.isFinite(r.scale) &&
          r.scale > 0 &&
          r.value >= 0 &&
          r.value <= r.scale,
      )
    : []

  if (valid.length > 0) {
    const visible = typeof limit === 'number' ? valid.slice(0, limit) : valid
    const firstLabel = ratingSourceLabel(valid[0].source) || valid[0].source
    return (
      <div
        className={`rating-badges${className ? ` ${className}` : ''}`}
        aria-label={valid.length === 1 ? `${firstLabel} rating` : 'Ratings'}
      >
        {visible.map((r) => (
          <RatingPill
            key={normalizeSource(r.source) || r.source}
            rating={r.value}
            ratingSource={r.source}
            ratingCount={typeof r.votes === 'number' ? r.votes : undefined}
            scale={r.scale}
            compact={compact}
          />
        ))}
      </div>
    )
  }

  if (
    typeof rating === 'number' &&
    Number.isFinite(rating) &&
    rating >= 0 &&
    rating <= 10 &&
    typeof ratingSource === 'string' &&
    ratingSource.trim() !== ''
  ) {
    return (
      <RatingPill
        rating={rating}
        ratingSource={ratingSource}
        ratingCount={ratingCount}
        scale={10}
        compact={compact}
      />
    )
  }

  if (showMissing) {
    return <span className="rating-missing">No rating</span>
  }

  return null
}
