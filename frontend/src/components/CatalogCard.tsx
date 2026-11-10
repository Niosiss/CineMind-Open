import type { CSSProperties, MouseEvent } from 'react'
import type { CatalogItem } from '../types'
import { kindLabel } from '../i18n'
import { detailHref } from '../navigation'
import { Poster } from './Poster'
import { RatingBadges } from './RatingPill'

interface CatalogCardProps {
  item: CatalogItem
  index: number
  watched?: boolean
  disliked?: boolean
  busy?: boolean
  /**
   * Entry delay (ms) for a card that appears for the first time. When set,
   * `.catalog-enter` runs through `--catalog-entry-delay`. It does not
   * replay while the same card stays mounted.
   */
  entryDelayMs?: number
  onOpen: (item: CatalogItem) => void
  onWatch: (item: CatalogItem) => void
  onDislike: (item: CatalogItem) => void
}

/** Only an unmodified primary click is intercepted; modifiers and middle click stay native. */
function openOnPlainClick(onOpen: () => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onOpen()
  }
}

/**
 * Catalog card: vertical poster for the discover grid.
 * Title, year, ratings, and watched status; no synopsis or action row.
 * onWatch/onDislike/busy are accepted for compatibility (actions live on detail).
 */
export function CatalogCard({
  item,
  index: _index,
  watched,
  disliked,
  busy: _busy,
  entryDelayMs,
  onOpen,
  onWatch: _onWatch,
  onDislike: _onDislike,
}: CatalogCardProps) {
  const href = detailHref(item.id)
  const open = openOnPlainClick(() => onOpen(item))
  const delayStyle =
    entryDelayMs !== undefined
      ? ({ '--catalog-entry-delay': `${entryDelayMs}ms` } as CSSProperties)
      : undefined

  return (
    <article
      className={entryDelayMs !== undefined ? 'catalog-card catalog-enter' : 'catalog-card'}
      style={delayStyle}
    >
      <a
        className="catalog-poster"
        href={href}
        onClick={open}
        aria-label={`Open details for ${item.title}`}
        title={item.title}
      >
        <Poster src={item.posterUrl} title={item.title} />
      </a>

      <div className="catalog-body">
        <div className="catalog-meta">
          <span className="badge">{kindLabel(item.kind)}</span>
          {item.year ? <span className="rec-year">{item.year}</span> : null}
        </div>

        <h3 className="catalog-title">
          <a
            className="catalog-title-link"
            href={href}
            onClick={open}
            aria-label={item.title}
            title={item.title}
            data-work-id={item.id}
          >
            {item.title}
          </a>
        </h3>

        <RatingBadges
          ratings={item.ratings}
          rating={item.rating}
          ratingSource={item.ratingSource}
          ratingCount={item.ratingCount}
        />

        {(watched || disliked) ? (
          <p className="card-status" aria-live="polite">
            {watched ? 'Watched' : ''}{watched && disliked ? ' • ' : ''}{disliked ? 'Disliked' : ''}
          </p>
        ) : null}
      </div>
    </article>
  )
}
