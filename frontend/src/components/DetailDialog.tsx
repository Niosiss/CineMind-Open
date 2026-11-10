import { kindLabel } from '../i18n'
import { useGenreLabel } from '../genres'
import type { CatalogItem, Mood } from '../types'
import { Dialog } from './Dialog'
import { Poster } from './Poster'
import { RatingBadges } from './RatingPill'
import { WorkActions } from './WorkActions'
import { ExternalIcon } from './icons'

export interface DetailData {
  item: CatalogItem
  reason?: string
  /** Mood from the recommendation card; needed for dislike feedback. */
  mood?: Mood
}

interface DetailDialogProps {
  detail: DetailData | null
  onClose: () => void
  watched?: boolean
  disliked?: boolean
  liked?: boolean
  busy?: boolean
  onWatch?: (item: CatalogItem) => void
  onDislike?: (item: CatalogItem) => void
  onLike?: (item: CatalogItem, mood?: Mood) => void
}

/** Detail: full synopsis, large poster, facts, rating, and actions. */
export function DetailDialog({ detail, onClose, watched, disliked, liked, busy, onWatch, onDislike, onLike }: DetailDialogProps) {
  const genreLabel = useGenreLabel()
  if (!detail) return null
  const { item } = detail
  const hasSource = /^https?:\/\//i.test(item.sourceUrl ?? '')

  return (
    <Dialog open title={item.title} onClose={onClose} wide>
      <div className="detail">
        <div className="detail-head">
          <div className="detail-poster">
            <Poster src={item.posterUrl} title={item.title} className="poster-xl" />
          </div>
          <dl className="detail-facts">
            <div>
              <dt>Format</dt>
              <dd>{kindLabel(item.kind)}</dd>
            </div>
            {item.year ? (
              <div>
                <dt>Year</dt>
                <dd>{item.year}</dd>
              </div>
            ) : null}
            {item.genres.length > 0 ? (
              <div>
                <dt>Genres</dt>
                <dd>
                  <ul className="tag-row">
                    {item.genres.map((g) => (
                      <li key={g} className="tag">{genreLabel(g)}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Rating</dt>
              <dd>
                <RatingBadges
                  ratings={item.ratings}
                  rating={item.rating}
                  ratingSource={item.ratingSource}
                  ratingCount={item.ratingCount}
                  showMissing
                />
              </dd>
            </div>
            {(watched || disliked) && (
              <div>
                <dt>Status</dt>
                <dd>
                  <span className="detail-status">
                    {watched ? 'Watched' : ''}{watched && disliked ? ' • ' : ''}{disliked ? 'Disliked' : ''}
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </div>

        {item.description ? (
          <div className="detail-synopsis">
            <h3 className="detail-synopsis-title">Overview</h3>
            <p className="detail-desc">{item.description}</p>
          </div>
        ) : (
          <p className="muted detail-desc">No overview available for this title.</p>
        )}

        {detail.reason ? (
          <div className="rec-reason detail-reason">
            <span className="reason-label">Why it fits</span>
            <p>{detail.reason}</p>
          </div>
        ) : null}

        <div className="detail-actions">
          {(onWatch || onDislike) && (
            <WorkActions
              watched={watched}
              disliked={disliked}
              liked={liked}
              showLike={Boolean(onLike)}
              busy={busy}
              onWatch={() => onWatch?.(item)}
              onDislike={() => onDislike?.(item)}
              onLike={onLike ? () => onLike(item, detail.mood) : undefined}
            />
          )}
          {hasSource ? (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="source-link detail-source"
            >
              Open source
              <ExternalIcon size={14} />
            </a>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
