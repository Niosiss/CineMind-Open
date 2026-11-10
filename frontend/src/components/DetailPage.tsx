import { useEffect, useRef, useState } from 'react'
import { ApiError, localStore } from '../localStore'
import { kindLabel } from '../i18n'
import { useGenreLabel } from '../genres'
import type { CastMember, CatalogDetails, CatalogItem, Kind, Mood } from '../types'
import { Poster, isLocalAssetUrl } from './Poster'
import { RatingBadges } from './RatingPill'
import { WorkActions } from './WorkActions'
import { ArrowLeftIcon, ExternalIcon } from './icons'
import { detailHref, isPlainClick } from '../navigation'

export interface DetailPageProps {
  /** In-memory known item; when null the page cold-loads via localStore.getCatalogItem. */
  item?: CatalogItem | null
  detailId: string
  reason?: string
  mood?: Mood
  watched?: boolean
  disliked?: boolean
  liked?: boolean
  busy?: boolean
  onWatch?: (item: CatalogItem) => void
  onDislike?: (item: CatalogItem) => void
  onLike?: (item: CatalogItem, mood?: Mood) => void
  onBack?: () => void
  /**
   * App's openDetail callback: related/similar titles open through it
   * so memory and back routing are preserved. Without it, real
   * #/title/:id links are used.
   */
  onOpenDetail?: (item: CatalogItem) => void
}

function similarHeading(kind: Kind): string {
  if (kind === 'anime') return 'Similar anime'
  if (kind === 'series') return 'Similar series'
  return 'Similar movies'
}

function castHeading(kind: Kind): string {
  if (kind === 'anime') return 'Voice cast'
  return 'Cast'
}

function ratingLabelFor(_kind: Kind): string {
  return 'Rating'
}

function initialForName(name: string): string {
  const trimmed = name.trim()
  return trimmed ? trimmed.charAt(0).toLocaleUpperCase('en-US') : '?'
}

function CastPhoto({ member }: { member: CastMember }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [member.id, member.imageUrl])
  // Only local asset URLs returned by the adapter are rendered.
  const photo = isLocalAssetUrl(member.imageUrl) ? member.imageUrl : undefined
  return (
    <span className="detail-cast-photo" aria-hidden="true">
      {photo && !failed ? (
        <img
          src={photo}
          alt=""
          loading="lazy"
          width={64}
          height={80}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="detail-cast-initial">{initialForName(member.name)}</span>
      )}
    </span>
  )
}

/** Addressable full-page detail. */
export function DetailPage({
  item,
  detailId,
  reason,
  mood,
  watched,
  disliked,
  liked,
  busy,
  onWatch,
  onDislike,
  onLike,
  onBack,
  onOpenDetail,
}: DetailPageProps) {
  const genreLabel = useGenreLabel()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [fetched, setFetched] = useState<{ id: string; item: CatalogItem } | null>(null)
  const [loading, setLoading] = useState<boolean>(!item)
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)

  const [extras, setExtras] = useState<{ id: string; details: CatalogDetails } | null>(null)
  const [extrasLoading, setExtrasLoading] = useState(false)
  const [extrasError, setExtrasError] = useState<string | null>(null)
  const [extrasRetryCount, setExtrasRetryCount] = useState(0)
  const extrasRequestedRef = useRef<string>('')

  // Known cached item wins; a fetched item only counts for the current id.
  const known = item ?? (fetched && fetched.id === detailId ? fetched.item : null)

  useEffect(() => {
    if (item) {
      setLoading(false)
      setError(null)
      setFetched(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setFetched(null)
    void localStore
      .getCatalogItem(detailId)
      .then((res) => {
        if (cancelled) return
        setFetched({ id: detailId, item: res })
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setLoading(false)
        const msg = e instanceof ApiError ? e.message : "Couldn't load this title."
        setError(msg)
      })
    return () => {
      cancelled = true
    }
  }, [item, detailId, retryCount])

  // Extras: fetch for each detail id; never block the base page, cancel
  // stale requests, and keep retries quiet.
  const knownKind: Kind | undefined = known?.kind ?? item?.kind
  useEffect(() => {
    if (!known || !knownKind) {
      setExtrasLoading(false)
      return
    }
    const activeExtrasKey = `${detailId}:${extrasRetryCount}`
    if (extrasRequestedRef.current === activeExtrasKey && extras) {
      return
    }
    let cancelled = false
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    extrasRequestedRef.current = activeExtrasKey
    setExtrasLoading(true)
    setExtrasError(null)
    void localStore
      .getCatalogDetails(detailId, { kind: knownKind, signal: controller?.signal })
      .then((details) => {
        if (cancelled) return
        // Do not use an old response after moving to another detail id.
        if (details.id && details.id !== detailId) return
        setExtras({ id: detailId, details })
        setExtrasLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof DOMException && e.name === 'AbortError') return
        if (e instanceof ApiError) {
          if (e.name === 'AbortError') return
        }
        setExtrasLoading(false)
        const msg = e instanceof ApiError ? e.message : "Couldn't load extra details."
        // Quiet failure: never block the page; small note + silent retry.
        setExtrasError(msg)
        setExtras((prev) => (prev && prev.id === detailId ? prev : null))
      })
    return () => {
      cancelled = true
      controller?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId, knownKind, extrasRetryCount, known?.id])

  // Clear stale extras when the id/detail changes.
  useEffect(() => {
    setExtras(null)
    setExtrasError(null)
    setExtrasLoading(Boolean(known))
    extrasRequestedRef.current = ''
  }, [detailId])

  useEffect(() => {
    if (!loading) headingRef.current?.focus({ preventScroll: true })
  }, [loading, known])

  const handleBackClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(e)) return
    e.preventDefault()
    onBack?.()
  }

  const handleOpenDetailClick =
    (target: CatalogItem) => (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!onOpenDetail) return
      if (!isPlainClick(e)) return
      e.preventDefault()
      onOpenDetail(target)
    }

  const backHref = '#/discover'

  if (loading && !known) {
    return (
      <section className="detail-page" aria-busy="true" aria-live="polite">
        <a href={backHref} className="detail-back" onClick={handleBackClick}>
          <ArrowLeftIcon size={16} /> Back
        </a>
        <p className="status-line muted">Loading title…</p>
        <div className="detail-hero">
          <div className="detail-poster">
            <div className="skeleton skeleton-poster detail-hero-skeleton-poster" aria-hidden="true" />
          </div>
          <div className="detail-content">
            <div className="skeleton-lines">
              <div className="skeleton line w-70" />
              <div className="skeleton line w-40" />
              <div className="skeleton line w-95" />
            </div>
          </div>
        </div>
      </section>
    )
  }

  if (!known && error) {
    const isNotFound = /404|not found|no longer|doesn't exist/i.test(error)
    return (
      <section className="detail-page" aria-labelledby="detail-notfound-title">
        <a href={backHref} className="detail-back" onClick={handleBackClick}>
          <ArrowLeftIcon size={16} /> Back
        </a>
        <h1 id="detail-notfound-title" ref={headingRef} tabIndex={-1}>
          {isNotFound ? 'Title not found' : "Couldn't load this title"}
        </h1>
        <p className="muted">{error}</p>
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setRetryCount((n) => n + 1)}>
            Try again
          </button>
          <a href={backHref} className="btn btn-ghost" onClick={handleBackClick}>
            Back to Discover
          </a>
        </div>
      </section>
    )
  }

  if (!known) {
    return (
      <section className="detail-page" aria-labelledby="detail-empty-title">
        <a href={backHref} className="detail-back" onClick={handleBackClick}>
          <ArrowLeftIcon size={16} /> Back
        </a>
        <h1 id="detail-empty-title" ref={headingRef} tabIndex={-1}>
          Title not found
        </h1>
        <p className="muted">This title is no longer in your catalog.</p>
      </section>
    )
  }

  const hasSource = /^https?:\/\//i.test(known.sourceUrl ?? '')
  const extrasForId = extras && extras.id === detailId ? extras.details : null

  const baseHasRating =
    (Array.isArray(known.ratings) && known.ratings.length > 0) ||
    typeof known.rating === 'number'
  const effectiveRatings =
    baseHasRating
      ? known.ratings
      : extrasForId && extrasForId.ratings.length > 0
        ? extrasForId.ratings
        : known.ratings
  const effectiveRating = baseHasRating ? known.rating : undefined
  const effectiveRatingSource = baseHasRating ? known.ratingSource : undefined
  const effectiveRatingCount = baseHasRating ? known.ratingCount : undefined

  const extraFacts = extrasForId?.facts ?? []
  const visibleExtraFacts = extraFacts.filter((f) => {
    const label = f.label.trim().toLocaleLowerCase('en-US')
    if (label === 'format' || label === 'year' || label === 'yıl') return false
    if (label === 'rating' || label === 'imdb rating' || label === 'score' || label === 'puan') return false
    return true
  })

  const cast = extrasForId?.cast ?? []
  const related = extrasForId?.related ?? []
  const similar = extrasForId?.similar ?? []
  const sources = extrasForId?.sources ?? []
  const extrasNotice = extrasForId?.notice

  return (
    <section className="detail-page" aria-labelledby="detail-title">
      <a href={backHref} className="detail-back" onClick={handleBackClick}>
        <ArrowLeftIcon size={16} /> Back
      </a>
      <div className="detail-hero">
        <div className="detail-poster">
          <Poster src={known.posterUrl} title={known.title} />
        </div>
        <div className="detail-content">
          <h1 id="detail-title" ref={headingRef} tabIndex={-1}>
            {known.title}
          </h1>
          {known.genres.length > 0 ? (
            <ul className="tag-row detail-genres" aria-label="Genres">
              {known.genres.map((g) => (
                <li key={g} className="tag">
                  {genreLabel(g)}
                </li>
              ))}
            </ul>
          ) : null}
          <dl className="detail-facts detail-facts-horizontal">
            <div>
              <dt>Format</dt>
              <dd>{kindLabel(known.kind)}</dd>
            </div>
            {known.year ? (
              <div>
                <dt>Year</dt>
                <dd>{known.year}</dd>
              </div>
            ) : null}
            <div>
              <dt>{ratingLabelFor(known.kind)}</dt>
              <dd>
                <RatingBadges
                  ratings={effectiveRatings}
                  rating={effectiveRating}
                  ratingSource={effectiveRatingSource}
                  ratingCount={effectiveRatingCount}
                  kind={known.kind}
                  allowAnimeSources={known.kind === 'anime'}
                  showMissing={!extrasLoading}
                />
              </dd>
            </div>
            {visibleExtraFacts.map((fact, idx) => (
              <div key={`${fact.label}-${idx}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
            {watched || disliked ? (
              <div>
                <dt>Status</dt>
                <dd>
                  <span className="detail-status">
                    {watched ? 'Watched' : ''}
                    {watched && disliked ? ' • ' : ''}
                    {disliked ? 'Disliked' : ''}
                  </span>
                </dd>
              </div>
            ) : null}
          </dl>
          {extrasLoading && !extrasForId ? (
            <p className="detail-extras-loading muted" role="status">
              Loading details…
            </p>
          ) : null}
          {extrasError && !extrasLoading ? (
            <p className="detail-extras-note muted" role="status">
              {extrasError}{' '}
              <button
                type="button"
                className="link-btn detail-extras-retry"
                onClick={() => {
                  extrasRequestedRef.current = ''
                  setExtrasRetryCount((n) => n + 1)
                }}
              >
                Try again
              </button>
            </p>
          ) : null}
          {extrasNotice && !extrasError ? (
            <p className="detail-extras-note muted">{extrasNotice}</p>
          ) : null}
          <div className="detail-actions">
            {onWatch || onDislike ? (
              <WorkActions
                watched={watched}
                disliked={disliked}
                liked={liked}
                showLike={Boolean(onLike)}
                busy={busy}
                onWatch={() => onWatch?.(known)}
                onDislike={() => onDislike?.(known)}
                onLike={onLike ? () => onLike(known, mood) : undefined}
              />
            ) : null}
            {hasSource ? (
              <a href={known.sourceUrl} target="_blank" rel="noreferrer noopener" className="source-link detail-source">
                Open source <ExternalIcon size={14} />
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="detail-main">
        <section className="detail-description" aria-label="Overview">
          <h2>Overview</h2>
          {known.description?.trim() ? (
            <p>{known.description}</p>
          ) : (
            <p className="muted">No overview available for this title.</p>
          )}
        </section>

        {reason?.trim() ? (
          <section className="detail-reason" aria-label="Why it fits">
            <h2>Why it fits</h2>
            <p>{reason}</p>
          </section>
        ) : null}

        {extrasLoading && !extrasForId ? (
          <section aria-label="Additional details" aria-busy="true" aria-live="polite" className="detail-extras-skeleton">
            <div className="skeleton-lines">
              <div className="skeleton line w-40" />
              <div className="skeleton line w-70" />
            </div>
          </section>
        ) : null}

        {cast.length > 0 ? (
          <section aria-label={castHeading(known.kind)}>
            <h2>{castHeading(known.kind)}</h2>
            <ul className="detail-cast-grid">
              {cast.map((member) => {
                const subtitle = member.character ?? member.role
                const second = member.character && member.role ? member.role : undefined
                return (
                  <li key={member.id} className="detail-cast-item">
                    <CastPhoto key={member.id} member={member} />
                    <span className="detail-cast-text">
                      <span className="detail-cast-name">
                        {member.sourceUrl && /^https?:\/\//i.test(member.sourceUrl) ? (
                          <a
                            href={member.sourceUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="detail-cast-link"
                          >
                            {member.name}
                          </a>
                        ) : (
                          member.name
                        )}
                      </span>
                      {subtitle ? <span className="detail-cast-role">{subtitle}</span> : null}
                      {second ? <span className="detail-cast-sub">{second}</span> : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}

        {related.length > 0 ? (
          <section aria-label="Related titles">
            <h2>Related titles</h2>
            <ul className="detail-related-grid">
              {related.map((entry) => (
                <li key={entry.item.id} className="detail-related-item">
                  <a
                    className="detail-related-poster"
                    href={detailHref(entry.item.id)}
                    onClick={handleOpenDetailClick(entry.item)}
                    aria-label={`Open details for ${entry.item.title}`}
                    title={entry.item.title}
                  >
                    <Poster src={entry.item.posterUrl} title={entry.item.title} />
                  </a>
                  <div className="detail-related-body">
                    <h3 className="detail-related-title">
                      <a
                        className="detail-related-link"
                        href={detailHref(entry.item.id)}
                        onClick={handleOpenDetailClick(entry.item)}
                        title={entry.item.title}
                        data-work-id={entry.item.id}
                      >
                        {entry.item.title}
                      </a>
                    </h3>
                    <div className="detail-related-meta">
                      <span className="badge">{kindLabel(entry.item.kind)}</span>
                      {entry.item.year ? <span className="rec-year">{entry.item.year}</span> : null}
                    </div>
                    {entry.relation ? (
                      <p className="detail-related-relation">{entry.relation}</p>
                    ) : null}
                    <RatingBadges
                      ratings={entry.item.ratings}
                      rating={entry.item.rating}
                      ratingSource={entry.item.ratingSource}
                      ratingCount={entry.item.ratingCount}
                      kind={entry.item.kind}
                      allowAnimeSources={entry.item.kind === 'anime'}
                      compact
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {similar.length > 0 ? (
          <section aria-label={similarHeading(known.kind)}>
            <h2>{similarHeading(known.kind)}</h2>
            <ul className="detail-related-grid">
              {similar.map((itemEntry) => (
                <li key={itemEntry.id} className="detail-related-item">
                  <a
                    className="detail-related-poster"
                    href={detailHref(itemEntry.id)}
                    onClick={handleOpenDetailClick(itemEntry)}
                    aria-label={`Open details for ${itemEntry.title}`}
                    title={itemEntry.title}
                  >
                    <Poster src={itemEntry.posterUrl} title={itemEntry.title} />
                  </a>
                  <div className="detail-related-body">
                    <h3 className="detail-related-title">
                      <a
                        className="detail-related-link"
                        href={detailHref(itemEntry.id)}
                        onClick={handleOpenDetailClick(itemEntry)}
                        title={itemEntry.title}
                        data-work-id={itemEntry.id}
                      >
                        {itemEntry.title}
                      </a>
                    </h3>
                    <div className="detail-related-meta">
                      <span className="badge">{kindLabel(itemEntry.kind)}</span>
                      {itemEntry.year ? <span className="rec-year">{itemEntry.year}</span> : null}
                    </div>
                    <RatingBadges
                      ratings={itemEntry.ratings}
                      rating={itemEntry.rating}
                      ratingSource={itemEntry.ratingSource}
                      ratingCount={itemEntry.ratingCount}
                      kind={itemEntry.kind}
                      allowAnimeSources={itemEntry.kind === 'anime'}
                      compact
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {sources.length > 0 ? (
          <section aria-label="Sources">
            <h2>Sources</h2>
            <ul className="detail-sources-list">
              {sources.map((s) => (
                <li key={`${s.name}-${s.url}`}>
                  <a href={s.url} target="_blank" rel="noreferrer noopener" className="source-link detail-source-item">
                    {s.name} <ExternalIcon size={14} />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </section>
  )
}
