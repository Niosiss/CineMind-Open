import { useState, type CSSProperties, type MouseEvent } from 'react'
import { kindLabel } from '../i18n'
import { useGenreLabel } from '../genres'
import type { Preference, Recommendation } from '../types'
import { detailHref } from '../navigation'
import { Poster } from './Poster'
import { RatingBadges } from './RatingPill'
import { WorkActions } from './WorkActions'
import { ExternalIcon } from './icons'

interface CardProps {
  item: Recommendation
  preference: Preference | undefined
  watched?: boolean
  disliked?: boolean
  busy?: boolean
  onOpen: (item: Recommendation) => void
  onWatch: (item: Recommendation) => void
  onDislike: (item: Recommendation) => void
  onLike: (item: Recommendation, liked: boolean) => void
  index: number
  /**
   * Entry delay (ms) for a card that appears for the first time. When set,
   * `.catalog-enter` runs through `--catalog-entry-delay`. It does not
   * replay while the same card stays mounted.
   */
  entryDelayMs?: number
  /** First three picks: same 160×240 poster as the rest of the short list grid. */
  featured?: boolean
  /** Compatibility: the old `spotlight` variant maps to `featured`. */
  variant?: 'default' | 'spotlight'
}

const GENRE_VISIBLE = 3

/** Only an unmodified primary click is intercepted; modifiers and middle click stay native. */
function openOnPlainClick(onOpen: () => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onOpen()
  }
}

/**
 * Recommendation card: a horizontal row on desktop (poster | title,
 * meta, genres, reason). On mobile the poster and heading stack first,
 * then genres and the real reason flow full-width below. There is no
 * hidden footer and the reason is never clipped. Links target the real
 * `#/title/:id` route; there is no synopsis or fake missing-rating text.
 */
export function RecommendationCard({
  item,
  preference,
  watched,
  disliked,
  busy,
  onOpen,
  onWatch,
  onDislike,
  onLike,
  index: _index,
  entryDelayMs,
  featured,
  variant = 'default',
}: CardProps) {
  const genreLabel = useGenreLabel()
  const [genresExpanded, setGenresExpanded] = useState(false)
  const hasSource = /^https?:\/\//i.test(item.sourceUrl ?? '')
  const isFeatured = featured ?? variant === 'spotlight'
  const href = detailHref(item.id)
  const open = openOnPlainClick(() => onOpen(item))

  const genres = Array.isArray(item.genres) ? item.genres : []
  const visibleGenres = genresExpanded ? genres : genres.slice(0, GENRE_VISIBLE)
  const hiddenCount = genres.length - GENRE_VISIBLE

  const delayStyle =
    entryDelayMs !== undefined
      ? ({ '--catalog-entry-delay': `${entryDelayMs}ms` } as CSSProperties)
      : undefined

  return (
    <article
      className={`rec-card${entryDelayMs !== undefined ? ' catalog-enter' : ''}${isFeatured ? ' rec-card-featured' : ''}`}
      style={delayStyle}
    >
      {isFeatured ? <span className="visually-hidden">Featured recommendation.</span> : null}
      <a
        className="rec-poster"
        href={href}
        onClick={open}
        aria-label={`Open details for ${item.title}`}
        title={item.title}
      >
        <Poster src={item.posterUrl} title={item.title} />
      </a>

      <div className="rec-content">
        <div className="rec-top">
          <div className="rec-head">
            <h3 className="rec-title">
              <a
                className="rec-title-link"
                href={href}
                onClick={open}
                aria-label={item.title}
                title={item.title}
                data-work-id={item.id}
              >
                {item.title}
              </a>
            </h3>
            {hasSource ? (
              <a
                className="source-link rec-source"
                href={item.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Open source link"
                title="Open source link"
              >
                <ExternalIcon size={16} />
              </a>
            ) : null}
          </div>

          <div className="rec-meta-row">
            <div className="rec-meta">
              <span className="badge">{kindLabel(item.kind)}</span>
              {item.year ? <span className="rec-year">{item.year}</span> : null}
              <RatingBadges
                ratings={item.ratings}
                rating={item.rating}
                ratingSource={item.ratingSource}
                ratingCount={item.ratingCount}
              />
            </div>

            <div className="rec-actions">
              <WorkActions
                watched={watched}
                disliked={disliked}
                liked={preference === 'liked'}
                showLike
                busy={busy}
                onWatch={() => onWatch(item)}
                onDislike={() => onDislike(item)}
                onLike={() => onLike(item, true)}
              />
            </div>
          </div>
        </div>

        {genres.length > 0 ? (
          <ul className="tag-row" aria-label="Genres">
            {visibleGenres.map((g) => (
              <li key={g} className="tag">{genreLabel(g)}</li>
            ))}
            {!genresExpanded && hiddenCount > 0 ? (
              <li>
                <button
                  type="button"
                  className="tag tag-more"
                  onClick={() => setGenresExpanded(true)}
                  aria-expanded={false}
                  aria-label={`Show all ${genres.length} genres`}
                >
                  +{hiddenCount}
                </button>
              </li>
            ) : null}
            {genresExpanded && hiddenCount > 0 ? (
              <li>
                <button
                  type="button"
                  className="tag tag-more"
                  onClick={() => setGenresExpanded(false)}
                  aria-expanded={true}
                  aria-label="Collapse genres"
                >
                  Show less
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}

        {item.reason ? (
          <div className="rec-reason">
            <span className="reason-label">Why it fits</span>
            <p title={item.reason}>{item.reason}</p>
          </div>
        ) : null}
      </div>
    </article>
  )
}
