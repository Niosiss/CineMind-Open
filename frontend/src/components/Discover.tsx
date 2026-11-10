import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, localStore } from '../localStore'
import { CatalogPager, type PagerSnapshot } from '../catalogPager'
import { KIND_OPTIONS } from '../i18n'
import type { CatalogItem, Kind } from '../types'
import { CatalogCard } from './CatalogCard'
import { NoticeBar } from './NoticeBar'
import { CloseIcon, SearchIcon } from './icons'

interface DiscoverProps {
  onOpenDetail: (item: CatalogItem) => void
  getStatus: (id: string) => { watched: boolean; disliked: boolean }
  onWatch: (item: CatalogItem) => void
  onDislike: (item: CatalogItem) => void
  isBusy: (id: string) => boolean
  /** Called after a successful catalog import so App can invalidate recommendations. */
  onCatalogImported?: () => void
}

function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    return e.message.includes('404')
      ? "The catalog isn't available right now. Try again in a moment."
      : e.message
  }
  return "Couldn't load the catalog."
}

/**
 * Catalog: browse one format at a time and search titles.
 * The pager shows 42 items first, then 14 at a time; extra records
 * come from the buffer or the next page. There is no "load more"
 * button: the sentinel at the end of the list (IntersectionObserver,
 * ~400px root margin) continues automatically. When the source runs
 * out, the list ends honestly with the real number of records.
 */
export function Discover({ onOpenDetail, getStatus, onWatch, onDislike, isBusy, onCatalogImported }: DiscoverProps) {
  const [kind, setKind] = useState<Kind>('movie')
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<CatalogItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importNotice, setImportNotice] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Entry delays are stored per card id; existing cards keep their stable
  // key and therefore do not replay their entrance animation.
  const [entryDelayById, setEntryDelayById] = useState<Record<string, number>>({})

  // One pager instance per format/search key: when the key changes a new
  // pager is built and old responses are rejected by epoch + seq guards.
  const pagerRef = useRef<CatalogPager | null>(null)
  const pagerKeyRef = useRef('')
  const seqRef = useRef(0)
  const loadingMoreRef = useRef(false)
  // Stable ref mirrors for infinite-scroll triggers, so observer callbacks
  // and effects always read the current state instead of a stale render.
  const hasMoreRef = useRef(false)
  const loadingRef = useRef(true)
  const itemsLengthRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const sentinelVisibleRef = useRef(false)
  // The item count at the last automatic attempt: the sentinel cannot
  // retry automatically until new unique records arrive (prevents
  // error/empty-scan storms).
  const lastAttemptLengthRef = useRef(-1)
  const prevIdsRef = useRef<Set<string>>(new Set())

  hasMoreRef.current = hasMore
  loadingRef.current = loading
  itemsLengthRef.current = items.length

  const pagerFor = useCallback((k: Kind, q: string): CatalogPager => {
    const key = k + '|' + q
    if (pagerRef.current === null || pagerKeyRef.current !== key) {
      pagerRef.current = new CatalogPager((page) => localStore.getCatalog(k, page, q))
      pagerKeyRef.current = key
      // New format/search flow: reset the delay map and previous id set so
      // the first 42-item batch enters at 10ms steps and the old flow's
      // 18ms batches do not carry over. Preserved navigation keeps state.
      prevIdsRef.current = new Set()
      setEntryDelayById({})
    }
    return pagerRef.current
  }, [])

  const applySnapshot = useCallback((snap: PagerSnapshot) => {
    setItems(snap.visible)
    setHasMore(snap.hasMore)
    setNotice(snap.notice)
    // Entry delay: index*10ms in the first 42-item batch, index*18ms
    // within each new 14-item batch. Existing ids keep their delay.
    const prev = prevIdsRef.current
    const newBatch = snap.visible.filter((it) => !prev.has(it.id))
    const step = prev.size === 0 ? 10 : 18
    const freshDelay: Record<string, number> = {}
    newBatch.forEach((it, i) => {
      freshDelay[it.id] = i * step
    })
    setEntryDelayById((prevMap) => {
      const nextMap: Record<string, number> = {}
      for (const it of snap.visible) {
        nextMap[it.id] = prev.has(it.id) ? prevMap[it.id] ?? 0 : freshDelay[it.id] ?? 0
      }
      return nextMap
    })
    prevIdsRef.current = new Set(snap.visible.map((it) => it.id))
  }, [])

  const loadFirst = useCallback(async () => {
    const pager = pagerFor(kind, query)
    const seq = ++seqRef.current
    // If the format/search changes during loadMore, the old operation's
    // finally block cannot clear the lock because its seq no longer
    // matches; reset it here so continuation never stays locked.
    loadingMoreRef.current = false
    setLoadingMore(false)
    lastAttemptLengthRef.current = -1
    setLoading(true)
    setError(null)
    try {
      const snap = await pager.loadFirst()
      if (seqRef.current !== seq || pagerRef.current !== pager) return
      applySnapshot(snap)
    } catch (e) {
      if (seqRef.current !== seq || pagerRef.current !== pager) return
      // Error on first load: empty list + retry. The pager keeps its
      // partial buffer and continues from the same page on retry.
      setItems([])
      setHasMore(false)
      setNotice('')
      prevIdsRef.current = new Set()
      setEntryDelayById({})
      setError(friendlyError(e))
    } finally {
      if (seqRef.current === seq && pagerRef.current === pager) setLoading(false)
    }
  }, [kind, query, pagerFor, applySnapshot])

  useEffect(() => {
    void loadFirst()
  }, [loadFirst])

  // Invalidate pending work on unmount: late responses (or finally
  // blocks) must not update state.
  useEffect(
    () => () => {
      seqRef.current += 1
      loadingMoreRef.current = false
    },
    [],
  )

  /** Reload the same format/search from the beginning. */
  const reloadFresh = useCallback(() => {
    const pager = pagerFor(kind, query)
    pager.reset()
    prevIdsRef.current = new Set()
    setEntryDelayById({})
    setItems([])
    setHasMore(false)
    setNotice('')
    void loadFirst()
  }, [kind, query, pagerFor, loadFirst])

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return
    setImporting(true)
    setImportError(null)
    setImportNotice('')
    try {
      await localStore.importCatalog(file)
      onCatalogImported?.()
      setImportNotice(`Imported ${file.name}.`)
      reloadFresh()
    } catch (e) {
      const message = e instanceof ApiError
        ? e.message
        : "Couldn't import that file. Make sure it is a valid JSON catalog."
      setImportError(message)
    } finally {
      setImporting(false)
    }
  }

  const openFilePicker = () => {
    if (importing) return
    fileInputRef.current?.click()
  }

  const submitSearch = (e: FormEvent) => {
    e.preventDefault()
    const next = searchInput.trim()
    if (next === query) reloadFresh()
    else setQuery(next)
  }

  const clearSearch = () => {
    setSearchInput('')
    if (query !== '') setQuery('')
    else reloadFresh()
  }

  /**
   * Single continuation request. `force` comes only from the inline
   * "Try again" button; automatic triggers (observer + items.length)
   * do not retry until new unique records arrive.
   */
  const beginLoadMore = useCallback(
    (force = false): boolean => {
      if (loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) return false
      if (!force) {
        // The automatic path trusts only fresh geometry: when the first
        // 42 skeletons are replaced, the observer may not have delivered
        // a false update yet, so read current bounds now.
        const node = sentinelRef.current
        if (node !== null) {
          const rect = node.getBoundingClientRect()
          const viewportHeight =
            window.innerHeight || document.documentElement?.clientHeight || 0
          const withinViewport =
            rect.bottom + 400 >= 0 && rect.top - 400 <= viewportHeight
          sentinelVisibleRef.current = withinViewport
          if (!withinViewport) return false
        } else if (!sentinelVisibleRef.current) {
          return false
        }
      }
      if (!force && itemsLengthRef.current === lastAttemptLengthRef.current) return false
      lastAttemptLengthRef.current = itemsLengthRef.current
      const pager = pagerRef.current
      if (pager === null) return false
      const seq = ++seqRef.current
      loadingMoreRef.current = true
      setLoadingMore(true)
      setError(null)
      void (async () => {
        try {
          const snap = await pager.loadMore()
          if (seqRef.current !== seq || pagerRef.current !== pager) return
          applySnapshot(snap)
        } catch (e) {
          // On a load-more error the current list stays untouched; the
          // same page is read again only when the user retries.
          if (seqRef.current !== seq || pagerRef.current !== pager) return
          setError(friendlyError(e))
        } finally {
          if (seqRef.current === seq && pagerRef.current === pager) {
            loadingMoreRef.current = false
            setLoadingMore(false)
          }
        }
      })()
      return true
    },
    [applySnapshot],
  )

  // The sentinel observer is installed once; it is not rebuilt when
  // loadingMore changes (beginLoadMore is stable and refs are current).
  useEffect(() => {
    const node = sentinelRef.current
    if (node === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target !== node) continue
          sentinelVisibleRef.current = entry.isIntersecting
          if (entry.isIntersecting) beginLoadMore(false)
        }
      },
      { rootMargin: '400px' },
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
      sentinelVisibleRef.current = false
    }
  }, [beginLoadMore])

  // If the sentinel is still visible after the list grows, continue in a
  // chain: when no new unique record arrives (items.length unchanged) the
  // effect does not run again and no automatic request storm forms.
  useEffect(() => {
    if (sentinelVisibleRef.current) beginLoadMore(false)
  }, [items.length, beginLoadMore])

  const retryMore = () => {
    beginLoadMore(true)
  }

  const showErrorPanel = Boolean(error) && items.length === 0 && !loading

  return (
    <section className="discover" aria-label="Discover catalog">
      <header className="section-head">
        <div>
          <h2 className="section-title">Discover the catalog</h2>
          <p className="muted section-sub">Choose a format and search your imported titles.</p>
        </div>
        <div className="discover-import">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="visually-hidden"
            aria-label="Catalog JSON file"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              void handleImportFile(file)
            }}
          />
          <button type="button" className="btn btn-ghost" onClick={openFilePicker} disabled={importing}>
            {importing ? 'Importing…' : 'Import catalog'}
          </button>
        </div>
      </header>

      {importNotice ? (
        <p className="status-line muted" role="status">{importNotice}</p>
      ) : null}
      {importError ? (
        <div className="notice-bar notice-bar-error" role="alert">
          <span>{importError}</span>
        </div>
      ) : null}

      <form className="searchbar" role="search" onSubmit={submitSearch}>
        <span className="search-icon" aria-hidden="true"><SearchIcon size={18} /></span>
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search titles"
          aria-label="Search the catalog by title"
          autoComplete="off"
        />
        {searchInput ? (
          <button
            type="button"
            className="icon-btn search-clear"
            onClick={clearSearch}
            aria-label="Clear search"
          >
            <CloseIcon size={16} />
          </button>
        ) : null}
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      <div className="segmented discover-filter" role="group" aria-label="Choose format">
        {KIND_OPTIONS.map((k) => (
          <button
            key={k.value}
            type="button"
            className={`segment${kind === k.value ? ' segment-selected' : ''}`}
            aria-pressed={kind === k.value}
            onClick={() => setKind(k.value)}
          >
            {k.label}
          </button>
        ))}
      </div>

      <NoticeBar notice={notice} />

      {showErrorPanel ? (
        <div className="splash panel-error" role="alert">
          <h3>Catalog couldn't load</h3>
          <p className="muted">{error}</p>
          <div className="form-actions centered">
            <button type="button" className="btn btn-primary" onClick={() => void loadFirst()}>
              Try again
            </button>
          </div>
        </div>
      ) : loading ? (
        <>
          <p className="status-line muted" aria-live="polite">Loading catalog…</p>
          <SkeletonGrid />
        </>
      ) : items.length === 0 ? (
        <div className="splash">
          <h3>{query ? 'No matches' : 'Your catalog is empty'}</h3>
          <p className="muted">
            {query
              ? `No records for “${query}”. Try a different title, or import more data.`
              : "Import a JSON catalog to browse titles and get recommendations. CineMind doesn't include or fetch titles; you supply your own data."}
          </p>
          <div className="form-actions centered">
            {query ? (
              <button type="button" className="btn btn-ghost" onClick={clearSearch}>
                Clear search
              </button>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={openFilePicker} disabled={importing}>
              {importing ? 'Importing…' : 'Import catalog'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="results-head">
            <p className="count-line muted">
              {items.length} titles{query ? ` — search for “${query}”` : ''}
            </p>
          </div>
          <div className="catalog-grid">
            {items.map((item, i) => {
              const st = getStatus(item.id)
              return (
                <CatalogCard
                  key={item.id}
                  item={item}
                  index={i}
                  watched={st.watched}
                  disliked={st.disliked}
                  busy={isBusy(item.id)}
                  entryDelayMs={entryDelayById[item.id] ?? 0}
                  onOpen={onOpenDetail}
                  onWatch={onWatch}
                  onDislike={onDislike}
                />
              )
            })}
          </div>
          {loadingMore ? (
            <p className="status-line muted" aria-live="polite">
              Loading more…
            </p>
          ) : null}
          {error && !loading ? (
            <div className="notice-bar notice-bar-error" role="alert">
              <span>{error}</span>
              <button type="button" className="btn btn-ghost" onClick={retryMore}>
                Try again
              </button>
            </div>
          ) : null}
          {!hasMore && !error ? (
            <p className="count-line muted">
              No more titles — all {items.length} records in your catalog are shown.
            </p>
          ) : null}
        </>
      )}

      {/* Infinite scroll sentinel: always rendered, the node is stable. */}
      <div
        ref={sentinelRef}
        className="catalog-sentinel"
        aria-hidden="true"
        style={{ minHeight: '1px' }}
      />
    </section>
  )
}

function SkeletonGrid() {
  return (
    <div className="catalog-grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="catalog-card skeleton-card">
          <div className="skeleton skeleton-poster" />
          <div className="skeleton-lines">
            <div className="skeleton line w-70" />
            <div className="skeleton line w-40" />
            <div className="skeleton line w-95" />
            <div className="skeleton line w-80" />
          </div>
        </div>
      ))}
    </div>
  )
}
