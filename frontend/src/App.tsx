import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ApiError, isDefaultProfile, localStore } from './localStore'
import { ProfileEditor } from './components/ProfileEditor'
import { RecommendationCard } from './components/RecommendationCard'
import { Discover } from './components/Discover'
import { LibraryView } from './components/LibraryView'
import { NoticeBar } from './components/NoticeBar'
import { DetailPage } from './components/DetailPage'
import { Onboarding } from './components/Onboarding'
import { SlidingNav } from './components/SlidingNav'
import { KIND_OPTIONS, MOOD_OPTIONS, kindLabel, moodLabel } from './i18n'
import { parseRoute, routeToPath, detailHref, isPlainClick, type Route } from './navigation'
import type { CatalogItem, CatalogSource, FeedbackMap, Kind, LibraryEntry, Mood, Preference, Profile, Recommendation } from './types'

type Phase = 'boot' | 'bootError' | 'onboarding' | 'ready'

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | {
      status: 'done'
      items: Recommendation[]
      source?: CatalogSource
      notice?: string
      page: number
      hasMore: boolean
      nextPage: number
    }

const REQUEST_TEXT_MAX = 2000

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

interface ActiveRequest {
  mood: Mood
  kind: Kind
  requestText: string
}

interface PendingUndo {
  item: CatalogItem
  recommendation?: Recommendation
  index: number
  kind: 'watched' | 'disliked'
  prevWatched: boolean
  prevDisliked: boolean
  feedbackKey?: string
  prevFeedback?: Preference
  requestGeneration: number
  snapshot: ActiveRequest | null
}

const FEEDBACK_KEY = 'cinemind:feedback:v1'

function loadFeedback(): FeedbackMap {
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as FeedbackMap
    }
  } catch {
    /* corrupt data is ignored */
  }
  return {}
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('boot')
  const [bootError, setBootError] = useState('')
  const [profile, setProfile] = useState<Profile>({ name: '', genres: [], preferences: '' })

  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  const requestedPathRef = useRef<string>(routeToPath(parseRoute(window.location.hash)))
  const onboardResolvedRef = useRef(false)
  const mainRef = useRef<HTMLElement | null>(null)
  const autoLoadTriedRef = useRef(false)
  const detailMemoryRef = useRef<Map<string, { item: CatalogItem; reason?: string; mood?: Mood }>>(new Map())
  const detailPushedRef = useRef(false)
  const scrollMapRef = useRef<Map<string, number>>(new Map())
  const originHrefRef = useRef<string | null>(null)
  const originTitleRef = useRef<string | null>(null)
  const originWorkIdRef = useRef<string | null>(null)
  const prevRouteRef = useRef<Route>(parseRoute(window.location.hash))

  const [hasVisitedDiscover, setHasVisitedDiscover] = useState(false)
  const [hasVisitedLibrary, setHasVisitedLibrary] = useState(false)

  const [selection, setSelection] = useState<{ mood: Mood; kind: Kind } | null>(null)
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })
  // Temporary request text: not saved to the profile; it only shapes this request.
  const [requestText, setRequestText] = useState('')
  // Composer selections persist for the session (defaults movie + relax).
  const [composerMood, setComposerMood] = useState<Mood>('relax')
  const [composerKind, setComposerKind] = useState<Kind>('movie')
  const [composerOpen, setComposerOpen] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [entryDelayById, setEntryDelayById] = useState<Record<string, number>>({})

  const [feedback, setFeedback] = useState<FeedbackMap>(loadFeedback)
  const [library, setLibrary] = useState<Record<string, LibraryEntry>>({})
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState('')
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const recommendSeq = useRef(0)
  const requestGenerationRef = useRef(0)
  const activeRequestRef = useRef<ActiveRequest | null>(null)
  const shownIdsRef = useRef<string[]>([])
  const shownIdSetRef = useRef<Set<string>>(new Set())
  const nextPageRef = useRef(1)
  const hasMoreRef = useRef(false)
  const loadingMoreRef = useRef(false)
  const libraryInflightRef = useRef(false)
  const feedbackRef = useRef<FeedbackMap>(feedback)
  const libraryRef = useRef<Record<string, LibraryEntry>>(library)
  const pendingUndoRef = useRef<PendingUndo | null>(null)
  const loadRef = useRef<LoadState>(load)
  const entryPrevIdsRef = useRef<Set<string>>(new Set())
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const sentinelVisibleRef = useRef(false)
  const lastAutoAttemptRef = useRef<{ generation: number; length: number } | null>(null)
  const phaseRef = useRef<Phase>(phase)
  const routeNameRef = useRef<Route['name']>(route.name)
  const composerOpenRef = useRef(composerOpen)
  const moreErrorRef = useRef<string | null>(null)

  feedbackRef.current = feedback
  libraryRef.current = library
  pendingUndoRef.current = pendingUndo
  loadRef.current = load
  phaseRef.current = phase
  routeNameRef.current = route.name
  composerOpenRef.current = composerOpen
  moreErrorRef.current = moreError

  useEffect(() => {
    try {
      localStorage.setItem(FEEDBACK_KEY, JSON.stringify(feedback))
    } catch {
      /* stays session-only if persistence fails */
    }
  }, [feedback])

  const clearToastTimer = useCallback(() => {
    window.clearTimeout(toastTimer.current)
  }, [])

  const showToast = useCallback(
    (msg: string, undo?: PendingUndo | null) => {
      setToast(msg)
      if (undo !== undefined) setPendingUndo(undo)
      clearToastTimer()
      const ttl = undo ? 5000 : 3500
      toastTimer.current = window.setTimeout(() => {
        setToast('')
        setPendingUndo(null)
      }, ttl)
    },
    [clearToastTimer],
  )

  useEffect(() => () => clearToastTimer(), [clearToastTimer])

  const boot = useCallback(async () => {
    setPhase('boot')
    try {
      await localStore.health()
      const p = await localStore.getProfile()
      setProfile(p)
      // The catalog and details stay open for the default profile; onboarding
      // is entered only when recommendations are requested (open #/recommendations).
      if (isDefaultProfile(p) && parseRoute(window.location.hash).name === 'recommend') {
        requestedPathRef.current = routeToPath(parseRoute(window.location.hash))
        setPhase('onboarding')
      } else {
        setPhase('ready')
      }
    } catch (e) {
      setBootError(e instanceof ApiError ? e.message : 'Something went wrong while starting CineMind.')
      setPhase('bootError')
    }
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  // Native scroll restoration is manual while mounted so saved scroll wins on back.
  useEffect(() => {
    if ('scrollRestoration' in history) {
      const prev = history.scrollRestoration
      history.scrollRestoration = 'manual'
      return () => {
        history.scrollRestoration = prev
      }
    }
    return undefined
  }, [])

  // Normalize the root URL to #/discover once ready; preserve the requested
  // route through onboarding.
  useEffect(() => {
    if (phase !== 'ready') return
    const hash = window.location.hash
    if (hash === '' || hash === '#' || hash === '#/') {
      window.history.replaceState(null, '', '#/discover')
      setRoute(parseRoute('#/discover'))
    }
  }, [phase])

  // A visitor with the default profile can browse Discover; asking for
  // recommendations (link, CTA, top/mobile nav) enters onboarding while
  // preserving #/recommendations. The gate is never applied again after
  // it has been resolved.
  useEffect(() => {
    if (phase !== 'ready') return
    if (!onboardResolvedRef.current && route.name === 'recommend' && isDefaultProfile(profile)) {
      requestedPathRef.current = '#/recommendations'
      setPhase('onboarding')
    }
  }, [phase, route, profile])

  // Track first visits for Discover/Library mounts.
  useEffect(() => {
    if (route.name === 'discover') setHasVisitedDiscover(true)
    if (route.name === 'library') setHasVisitedLibrary(true)
  }, [route])

  // Scroll + origin focus restoration on route changes.
  useEffect(() => {
    const path = routeToPath(route)
    const prev = prevRouteRef.current
    const wasDetail = prev.name === 'detail'
    const isDetail = route.name === 'detail'
    if (!isDetail) {
      const saved = scrollMapRef.current.get(path)
      window.scrollTo(0, saved ?? 0)
      if (wasDetail && originWorkIdRef.current) {
        const workId = originWorkIdRef.current
        const title = originTitleRef.current
        originHrefRef.current = null
        originTitleRef.current = null
        originWorkIdRef.current = null
        window.setTimeout(() => {
          const escapedWorkId = workId.replace(/"/g, '\\"')
          const candidates = Array.from(
            document.querySelectorAll<HTMLAnchorElement>(`a[data-work-id="${escapedWorkId}"]`),
          )
          const visible = candidates.find((el) => {
            if (el.closest('[hidden]')) return false
            const rect = el.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0) return false
            const style = window.getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden') return false
            let node: HTMLElement | null = el
            while (node) {
              if ((node as HTMLElement).hidden) return false
              const s = window.getComputedStyle(node)
              if (s.display === 'none' || s.visibility === 'hidden') return false
              node = node.parentElement
            }
            return true
          })
          if (visible) {
            visible.focus({ preventScroll: true })
            return
          }
          if (title) {
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            const match = buttons.find((b) => {
              if (b.closest('[hidden]')) return false
              const rect = b.getBoundingClientRect()
              if (rect.width === 0 && rect.height === 0) return false
              return b.textContent?.trim() === title
            })
            match?.focus({ preventScroll: true })
          }
        }, 0)
      } else if (wasDetail && originHrefRef.current) {
        // Fallback when work id unavailable: only focus a visible matching href.
        const href = originHrefRef.current
        originHrefRef.current = null
        originTitleRef.current = null
        window.setTimeout(() => {
          const escaped = href.replace(/"/g, '\\"')
          const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(`a[href="${escaped}"]`))
          const visible = anchors.find((el) => !el.closest('[hidden]') && el.getBoundingClientRect().width > 0)
          visible?.focus({ preventScroll: true })
        }, 0)
      }
    } else {
      window.scrollTo(0, 0)
    }
    prevRouteRef.current = route
  }, [route])

  // Hash changes: restore the route and keep in-memory state. This covers
  // direct hash links plus browser back/forward on static hosting.
  useEffect(() => {
    const onHashChange = () => {
      const curPath = window.location.hash || '#/discover'
      const prevPath = routeToPath(prevRouteRef.current)
      const currentScroll = window.scrollY
      scrollMapRef.current.set(prevPath, currentScroll)
      // Detail back via history: clear detailPushed once we leave detail.
      if (prevRouteRef.current.name === 'detail' && parseRoute(curPath).name !== 'detail') {
        detailPushedRef.current = false
      }
      setRoute(parseRoute(curPath))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigateTo = useCallback((path: string) => {
    const parsed = parseRoute(path)
    const target = routeToPath(parsed)
    const normalized = target.startsWith('#') ? target : `#${target}`
    const curPath = routeToPath(prevRouteRef.current)
    scrollMapRef.current.set(curPath, window.scrollY)
    window.history.pushState(null, '', normalized)
    setRoute(parseRoute(normalized))
  }, [])

  const handleBackFromDetail = useCallback(() => {
    if (detailPushedRef.current) {
      detailPushedRef.current = false
      window.history.back()
      return
    }
    // Direct entry fallback: return to Discover.
    const curPath = routeToPath(prevRouteRef.current)
    scrollMapRef.current.set(curPath, window.scrollY)
    window.history.replaceState(null, '', '#/discover')
    setRoute({ name: 'discover' })
  }, [])

  const libraryLoadedRef = useRef(false)

  const loadLibrary = useCallback(async () => {
    if (libraryInflightRef.current) return
    libraryInflightRef.current = true
    const isFirstLoad = !libraryLoadedRef.current
    if (isFirstLoad) setLibraryLoading(true)
    try {
      const { items } = await localStore.getLibrary()
      const map: Record<string, LibraryEntry> = {}
      for (const entry of items) {
        if (entry?.item?.id) map[entry.item.id] = entry
      }
      setLibrary(map)
      libraryLoadedRef.current = true
    } catch (e) {
      showToast(e instanceof ApiError ? `Couldn't load the library: ${e.message}` : "Couldn't load the library. Try again.", null)
    } finally {
      libraryInflightRef.current = false
      if (isFirstLoad) setLibraryLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    if (phase === 'ready') void loadLibrary()
  }, [phase, loadLibrary])

  useEffect(() => {
    if (phase === 'ready' && route.name === 'library') void loadLibrary()
  }, [phase, route, loadLibrary])

  const libraryEntries = useMemo(() => Object.values(library), [library])

  // A new catalog invalidates in-flight and cached recommendations. The next
  // visit to Recommendations starts a fresh request against the imported data.
  const handleCatalogImported = useCallback(() => {
    recommendSeq.current += 1
    requestGenerationRef.current += 1
    activeRequestRef.current = null
    shownIdsRef.current = []
    shownIdSetRef.current = new Set()
    nextPageRef.current = 1
    hasMoreRef.current = false
    loadingMoreRef.current = false
    autoLoadTriedRef.current = false
    lastAutoAttemptRef.current = null
    sentinelVisibleRef.current = false
    entryPrevIdsRef.current = new Set()
    setEntryDelayById({})
    setSelection(null)
    setLoad({ status: 'idle' })
    setLoadingMore(false)
    setMoreError(null)
    setComposerOpen(true)
  }, [])

  const isBusy = useCallback((id: string) => busyIds.has(id), [busyIds])

  const getStatus = useCallback(
    (id: string) => {
      const e = library[id]
      return { watched: Boolean(e?.watched), disliked: Boolean(e?.disliked) }
    },
    [library],
  )

  const handleOnboard = useCallback(
    async (p: Profile) => {
      const saved = await localStore.saveProfile(p)
      setProfile(saved)
      onboardResolvedRef.current = true
      setPhase('ready')
      showToast(saved.name ? `Welcome, ${saved.name}!` : "You're all set!", null)
      // Preserve the requested route through onboarding.
      const requested = requestedPathRef.current || '#/discover'
      const parsed = parseRoute(requested)
      if (parsed.name === 'unknown') {
        window.history.replaceState(null, '', '#/discover')
        setRoute({ name: 'discover' })
        return
      }
      const target = routeToPath(parsed)
      if (window.location.hash !== target) {
        window.history.replaceState(null, '', target)
        setRoute(parsed)
      } else {
        setRoute(parsed)
      }
    },
    [showToast],
  )

  const saveProfile = useCallback(
    async (p: Profile) => {
      const saved = await localStore.saveProfile(p)
      setProfile(saved)
      showToast('Profile saved.', null)
    },
    [showToast],
  )

  const removeRecommendation = useCallback((id: string) => {
    setLoad((prev) =>
      prev.status === 'done'
        ? { ...prev, items: prev.items.filter((it) => it.id !== id) }
        : prev,
    )
  }, [])

  const withBusy = useCallback(async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
    setBusyIds((prev) => {
      const s = new Set(prev)
      s.add(id)
      return s
    })
    try {
      return await fn()
    } finally {
      setBusyIds((prev) => {
        const s = new Set(prev)
        s.delete(id)
        return s
      })
    }
  }, [])

  const handleWatch = useCallback(
    async (item: CatalogItem) => {
      const cur = libraryRef.current[item.id]
      if (cur?.watched) {
        showToast('This title is already in your watched list.', null)
        return
      }
      const prevWatched = Boolean(cur?.watched)
      const prevDisliked = Boolean(cur?.disliked)
      const curLoad = loadRef.current
      const recIndex = curLoad.status === 'done' ? curLoad.items.findIndex((it) => it.id === item.id) : -1
      const recommendation = recIndex >= 0 && curLoad.status === 'done' ? curLoad.items[recIndex] : undefined
      const snapshot = activeRequestRef.current ? { ...activeRequestRef.current } : null
      const genAt = requestGenerationRef.current
      try {
        await withBusy(item.id, () => localStore.updateLibrary(item, { watched: true }))
        setLibrary((prev) => ({
          ...prev,
          [item.id]: { item, watched: true, disliked: prev[item.id]?.disliked ?? false },
        }))
        removeRecommendation(item.id)
        const undo: PendingUndo = {
          item: recommendation ?? item,
          recommendation,
          index: recIndex,
          kind: 'watched',
          prevWatched,
          prevDisliked,
          requestGeneration: genAt,
          snapshot,
        }
        showToast('Marked as watched.', undo)
      } catch (e) {
        showToast(e instanceof ApiError ? `Couldn't save watched status: ${e.message}` : "Couldn't save watched status. Try again.", null)
      }
    },
    [removeRecommendation, showToast, withBusy],
  )

  const handleDislike = useCallback(
    async (item: CatalogItem, moodOverride?: Mood) => {
      const mood = moodOverride ?? activeRequestRef.current?.mood ?? selection?.mood
      if (mood) {
        const key = `${mood}:${item.id}`
        if (libraryRef.current[item.id]?.disliked) {
          showToast('This title is already in your disliked list.', null)
          return
        }
        const prevWatched = Boolean(libraryRef.current[item.id]?.watched)
        const prevDisliked = Boolean(libraryRef.current[item.id]?.disliked)
        const prevFeedback = feedbackRef.current[key]
        const curLoad = loadRef.current
        const recIndex = curLoad.status === 'done' ? curLoad.items.findIndex((it) => it.id === item.id) : -1
        const recommendation = recIndex >= 0 && curLoad.status === 'done' ? curLoad.items[recIndex] : undefined
        const snapshot = activeRequestRef.current ? { ...activeRequestRef.current } : null
        const genAt = requestGenerationRef.current
        try {
          await withBusy(item.id, () => localStore.sendFeedback(item.id, mood, false, item))
          setFeedback((prev) => ({ ...prev, [key]: 'disliked' as Preference }))
          setLibrary((prev) => ({
            ...prev,
            [item.id]: { item, watched: prev[item.id]?.watched ?? false, disliked: true },
          }))
          removeRecommendation(item.id)
          const undo: PendingUndo = {
            item: recommendation ?? item,
            recommendation,
            index: recIndex,
            kind: 'disliked',
            prevWatched,
            prevDisliked,
            feedbackKey: key,
            prevFeedback,
            requestGeneration: genAt,
            snapshot,
          }
          showToast('Added to your disliked list.', undo)
        } catch (e) {
          showToast(e instanceof ApiError ? `Couldn't save: ${e.message}` : "Couldn't save. Try again.", null)
        }
      } else {
        if (libraryRef.current[item.id]?.disliked) {
          showToast('This title is already in your disliked list.', null)
          return
        }
        const prevWatched = Boolean(libraryRef.current[item.id]?.watched)
        const prevDisliked = Boolean(libraryRef.current[item.id]?.disliked)
        const curLoad = loadRef.current
        const recIndex = curLoad.status === 'done' ? curLoad.items.findIndex((it) => it.id === item.id) : -1
        const recommendation = recIndex >= 0 && curLoad.status === 'done' ? curLoad.items[recIndex] : undefined
        const snapshot = activeRequestRef.current ? { ...activeRequestRef.current } : null
        const genAt = requestGenerationRef.current
        try {
          await withBusy(item.id, () => localStore.updateLibrary(item, { disliked: true }))
          setLibrary((prev) => ({
            ...prev,
            [item.id]: { item, watched: prev[item.id]?.watched ?? false, disliked: true },
          }))
          removeRecommendation(item.id)
          const undo: PendingUndo = {
            item: recommendation ?? item,
            recommendation,
            index: recIndex,
            kind: 'disliked',
            prevWatched,
            prevDisliked,
            requestGeneration: genAt,
            snapshot,
          }
          showToast('Added to your disliked list.', undo)
        } catch (e) {
          showToast(e instanceof ApiError ? `Couldn't save: ${e.message}` : "Couldn't save. Try again.", null)
        }
      }
    },
    [removeRecommendation, selection, showToast, withBusy],
  )

  const handleLike = useCallback(
    async (item: CatalogItem, moodOverride?: Mood) => {
      const mood = moodOverride ?? activeRequestRef.current?.mood ?? selection?.mood
      if (!mood) {
        showToast('Choose a recommendation first to like it.', null)
        return
      }
      const key = `${mood}:${item.id}`
      const next: Preference = 'liked'
      if (feedbackRef.current[key] === next) {
        showToast('This preference is already saved.', null)
        return
      }
      try {
        await withBusy(item.id, () => localStore.sendFeedback(item.id, mood, true))
        setFeedback((prev) => ({ ...prev, [key]: next }))
        setLibrary((prev) => {
          const cur = prev[item.id]
          if (!cur || !cur.disliked) return prev
          const nextMap = { ...prev }
          const updated: LibraryEntry = { item: cur.item, watched: cur.watched, disliked: false }
          if (!updated.watched && !updated.disliked) delete nextMap[item.id]
          else nextMap[item.id] = updated
          return nextMap
        })
        showToast('Added to your likes.', null)
      } catch (e) {
        showToast(e instanceof ApiError ? `Couldn't save preference: ${e.message}` : "Couldn't save preference. Try again.", null)
      }
    },
    [selection, showToast, withBusy],
  )

  const undoPending = useCallback(async () => {
    const pending = pendingUndoRef.current
    if (!pending) return
    clearToastTimer()
    setPendingUndo(null)
    setToast('')
    const { item, kind } = pending
    try {
      await withBusy(item.id, () => localStore.updateLibrary(item, kind === 'watched' ? { watched: false } : { disliked: false }))
      setLibrary((prev) => {
        const cur = prev[item.id]
        const watched = kind === 'watched' ? false : (cur?.watched ?? pending.prevWatched)
        const disliked = kind === 'disliked' ? false : (cur?.disliked ?? pending.prevDisliked)
        const next = { ...prev }
        if (!watched && !disliked) delete next[item.id]
        else next[item.id] = { item: cur?.item ?? item, watched, disliked }
        return next
      })
      if (kind === 'disliked' && pending.feedbackKey) {
        const fbKey = pending.feedbackKey
        const prevFb = pending.prevFeedback
        setFeedback((prev) => {
          const next = { ...prev }
          if (prevFb !== undefined) next[fbKey] = prevFb
          else delete next[fbKey]
          return next
        })
      }
      // Restore the card only for the same generation + same request at its prior position.
      if (pending.recommendation && pending.index >= 0) {
        const cur = activeRequestRef.current
        const sameRequest =
          pending.snapshot !== null &&
          cur !== null &&
          cur.mood === pending.snapshot.mood &&
          cur.kind === pending.snapshot.kind &&
          cur.requestText === pending.snapshot.requestText &&
          requestGenerationRef.current === pending.requestGeneration
        // Only restore when both exclusion flags are false after the revert (preserve other flags).
        const watchedNow = kind === 'watched' ? false : Boolean(libraryRef.current[item.id]?.watched ?? pending.prevWatched)
        const dislikedNow = kind === 'disliked' ? false : Boolean(libraryRef.current[item.id]?.disliked ?? pending.prevDisliked)
        const canRestore = !watchedNow && !dislikedNow
        if (sameRequest && canRestore) {
          const rec = pending.recommendation
          const idx = pending.index
          setLoad((prev) => {
            if (prev.status !== 'done') return prev
            if (prev.items.some((it) => it.id === rec.id)) return prev
            const at = Math.min(idx, prev.items.length)
            const items = [...prev.items]
            items.splice(at, 0, rec)
            return { ...prev, items }
          })
        }
      }
      showToast('Undone.', null)
    } catch (e) {
      showToast(e instanceof ApiError ? `Couldn't undo: ${e.message}` : "Couldn't undo. Try again.", null)
    }
  }, [clearToastTimer, showToast, withBusy])

  const handleLibraryUndo = useCallback(
    async (entry: LibraryEntry, kind: 'watched' | 'disliked') => {
      const patch = kind === 'watched' ? { watched: false } : { disliked: false }
      try {
        await withBusy(entry.item.id, () => localStore.updateLibrary(entry.item, patch))
        setLibrary((prev) => {
          const cur = prev[entry.item.id]
          if (!cur) return prev
          const next = { ...prev }
          const updated: LibraryEntry = {
            item: cur.item,
            watched: kind === 'watched' ? false : cur.watched,
            disliked: kind === 'disliked' ? false : cur.disliked,
          }
          if (!updated.watched && !updated.disliked) delete next[entry.item.id]
          else next[entry.item.id] = updated
          return next
        })
        if (kind === 'disliked') {
          setFeedback((prev) => {
            const suffix = `:${entry.item.id}`
            const next = { ...prev }
            for (const k of Object.keys(next)) {
              if (k.endsWith(suffix) && next[k] === 'disliked') delete next[k]
            }
            return next
          })
        }
        showToast('Undone.', null)
      } catch (e) {
        showToast(e instanceof ApiError ? `Couldn't undo: ${e.message}` : "Couldn't undo. Try again.", null)
      }
    },
    [showToast, withBusy],
  )

  const openDetail = useCallback((item: CatalogItem, reason?: string, mood?: Mood) => {
    detailMemoryRef.current.set(item.id, { item, reason, mood })
    const href = detailHref(item.id)
    originHrefRef.current = href
    originTitleRef.current = item.title
    originWorkIdRef.current = item.id
    const curPath = routeToPath(prevRouteRef.current)
    scrollMapRef.current.set(curPath, window.scrollY)
    detailPushedRef.current = true
    const apply = () => {
      window.history.pushState(null, '', href)
      setRoute({ name: 'detail', id: item.id })
    }
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
    if (!reduced && typeof doc.startViewTransition === 'function') {
      // Shared poster: only the origin poster for this work gets detail-hero name
      // (CSS already gives .detail-poster the same name) before the transition starts.
      let originPoster: HTMLElement | null = null
      try {
        const escapedHref = href.replace(/"/g, '\\"')
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            `a[href="${escapedHref}"].rec-poster, a[href="${escapedHref}"].catalog-poster`,
          ),
        )
        originPoster =
          candidates.find((el) => {
            if (el.closest('[hidden]')) return false
            const rect = el.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0) return false
            if (window.getComputedStyle(el).display === 'none') return false
            let node: HTMLElement | null = el
            while (node) {
              if ((node as HTMLElement).hidden) return false
              if (window.getComputedStyle(node).display === 'none') return false
              node = node.parentElement
            }
            return true
          }) ?? null
        if (originPoster) originPoster.style.setProperty('view-transition-name', 'detail-hero')
        const transition = doc.startViewTransition(() => apply()) as
          | { finished?: Promise<unknown> }
          | undefined
        if (transition?.finished) {
          void transition.finished.finally(() => {
            originPoster?.style.removeProperty('view-transition-name')
          })
        } else if (originPoster) {
          const posterToClean = originPoster
          window.setTimeout(() => posterToClean.style.removeProperty('view-transition-name'), 600)
        }
        return
      } catch {
        originPoster?.style.removeProperty('view-transition-name')
        /* fall through */
      }
    }
    apply()
  }, [])

  const openRecDetail = useCallback(
    (item: Recommendation) => {
      openDetail(item, item.reason || undefined, activeRequestRef.current?.mood ?? selection?.mood)
    },
    [openDetail, selection],
  )

  // Giriş gecikmeleri: kart id'sine göre; ilk pakette index*10ms, eklenen
  // pakette paket-içi index*18ms. Eski id'ler gecikmesini korur, stable key
  // ile yerinde kalan kart animasyonu tekrarlamaz. Yeni istekte resetlenir.
  const applyEntryDelays = useCallback((visible: Recommendation[]) => {
    const prev = entryPrevIdsRef.current
    const step = prev.size === 0 ? 10 : 18
    const freshDelay: Record<string, number> = {}
    let batchIndex = 0
    for (const it of visible) {
      if (!prev.has(it.id)) {
        freshDelay[it.id] = batchIndex * step
        batchIndex += 1
      }
    }
    setEntryDelayById((prevMap) => {
      const nextMap: Record<string, number> = {}
      for (const it of visible) {
        nextMap[it.id] = prev.has(it.id) ? prevMap[it.id] ?? 0 : freshDelay[it.id] ?? 0
      }
      return nextMap
    })
    entryPrevIdsRef.current = new Set(visible.map((it) => it.id))
  }, [])

  const runRecommendation = useCallback(
    async (mood: Mood, kind: Kind, requestTextArg?: string) => {
      const normalizedRequestText = (
        requestTextArg ?? activeRequestRef.current?.requestText ?? ''
      )
        .slice(0, REQUEST_TEXT_MAX)
        .trim()
      const seq = ++recommendSeq.current
      requestGenerationRef.current += 1
      activeRequestRef.current = { mood, kind, requestText: normalizedRequestText }
      shownIdsRef.current = []
      shownIdSetRef.current = new Set()
      nextPageRef.current = 1
      hasMoreRef.current = false
      loadingMoreRef.current = false
      setLoadingMore(false)
      setMoreError(null)
      entryPrevIdsRef.current = new Set()
      setEntryDelayById({})
      lastAutoAttemptRef.current = null
      sentinelVisibleRef.current = false
      setSelection({ mood, kind })
      setComposerMood(mood)
      setComposerKind(kind)
      setRequestText(normalizedRequestText)
      setComposerOpen(true)
      setLoad({ status: 'loading' })
      try {
        const res = await localStore.getRecommendations(mood, kind, {
          requestText: normalizedRequestText,
          page: 1,
          excludeIds: [],
        })
        if (recommendSeq.current !== seq) return
        const incoming = Array.isArray(res.items) ? res.items : []
        const seen = new Set<string>()
        const deduped: Recommendation[] = []
        for (const it of incoming) {
          if (!it || typeof it.id !== 'string' || it.id === '') continue
          if (seen.has(it.id)) continue
          seen.add(it.id)
          deduped.push(it)
        }
        shownIdsRef.current = deduped.map((it) => it.id)
        shownIdSetRef.current = new Set(shownIdsRef.current)
        applyEntryDelays(deduped)
        const page = positiveInt(res.page, 1)
        const hasMore = Boolean(res.hasMore)
        const nextPage = positiveInt(res.nextPage, hasMore ? page + 1 : page)
        nextPageRef.current = nextPage
        hasMoreRef.current = hasMore
        setLoad({
          status: 'done',
          items: deduped,
          source: res.source,
          notice: res.notice,
          page,
          hasMore,
          nextPage,
        })
        // New request succeeded → collapse composer to summary; error keeps it open.
        setComposerOpen(false)
      } catch (e) {
        if (recommendSeq.current !== seq) return
        setLoad({
          status: 'error',
          error: e instanceof ApiError ? e.message : "Couldn't load recommendations.",
        })
      }
    },
    [applyEntryDelays],
  )

  const loadMore = useCallback(async () => {
    const active = activeRequestRef.current
    if (!active) return
    if (loadingMoreRef.current || !hasMoreRef.current) return
    const seq = ++recommendSeq.current
    const pageToFetch = nextPageRef.current
    const excludeIds = [...shownIdsRef.current]
    loadingMoreRef.current = true
    setLoadingMore(true)
    setMoreError(null)
    try {
      const res = await localStore.getRecommendations(active.mood, active.kind, {
        requestText: active.requestText,
        page: pageToFetch,
        excludeIds,
      })
      if (recommendSeq.current !== seq) return
      const incoming = Array.isArray(res.items) ? res.items : []
      const seen = new Set(shownIdSetRef.current)
      const novel: Recommendation[] = []
      for (const it of incoming) {
        if (!it || typeof it.id !== 'string' || it.id === '') continue
        if (seen.has(it.id)) continue
        seen.add(it.id)
        novel.push(it)
      }
      for (const it of novel) {
        shownIdSetRef.current.add(it.id)
        shownIdsRef.current.push(it.id)
      }
      applyEntryDelays(loadRef.current.status === 'done' ? [...loadRef.current.items, ...novel] : novel)
      const page = positiveInt(res.page, pageToFetch)
      const hasMore = Boolean(res.hasMore)
      const nextPage = positiveInt(res.nextPage, hasMore ? page + 1 : page)
      nextPageRef.current = nextPage
      hasMoreRef.current = hasMore
      setLoad((prev) =>
        prev.status === 'done'
          ? {
              ...prev,
              items: [...prev.items, ...novel],
              source: res.source ?? prev.source,
              notice: res.notice,
              page,
              hasMore,
              nextPage,
            }
          : prev,
      )
    } catch (e) {
      if (recommendSeq.current !== seq) return
      setMoreError(e instanceof ApiError ? e.message : "Couldn't load more recommendations.")
    } finally {
      if (recommendSeq.current === seq) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }, [applyEntryDelays])

  /**
   * Otomatik devam: yalnız route.name === 'recommend', phase ready, load
   * done, hasMore, !composerOpen, !loadingMore ve !moreError iken sentinel
   * ile tetiklenir. `force` moreError / lastAttempt / taze geometri guard'ını
   * atlayabilir; satır içi hata "Try again" düğmeleri mevcut loadMore
   * handler'ını aynen çağırarak bu bypass'ı kullanır. Yeni sayfa
   * eklenince eski observer görünürlüğüyle fazladan yükleme yapılmaz:
   * otomatik yol güncel boundingRect'i şimdi okur. Aynı generation +
   * items.length ile tekrar otomatik istek yoktur (duplicate/empty fırtına
   * engeli); hatada otomatik retry döngüsü yoktur.
   */
  const tryAutoLoadMore = useCallback(
    (force = false): boolean => {
      if (phaseRef.current !== 'ready') return false
      if (routeNameRef.current !== 'recommend') return false
      const curLoad = loadRef.current
      if (curLoad.status !== 'done') return false
      if (!curLoad.hasMore || !hasMoreRef.current) return false
      if (composerOpenRef.current) return false
      if (loadingMoreRef.current) return false
      if (!force && moreErrorRef.current) return false
      if (!force) {
        const node = sentinelRef.current
        if (node !== null) {
          const rect = node.getBoundingClientRect()
          const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0
          const withinViewport = rect.bottom + 400 >= 0 && rect.top - 400 <= viewportHeight
          sentinelVisibleRef.current = withinViewport
          if (!withinViewport) return false
        } else if (!sentinelVisibleRef.current) {
          return false
        }
        const generation = requestGenerationRef.current
        const length = curLoad.items.length
        const last = lastAutoAttemptRef.current
        if (last !== null && last.generation === generation && last.length === length) return false
        lastAutoAttemptRef.current = { generation, length }
      }
      void loadMore()
      return true
    },
    [loadMore],
  )

  const submitComposer = (e: FormEvent) => {
    e.preventDefault()
    const text = requestText.slice(0, REQUEST_TEXT_MAX)
    void runRecommendation(composerMood, composerKind, text)
  }

  // İlk öneri yükleme: öneri rotasına ilk girişte, hazır fazda, profil
  // kayıtlıyken ve boşken TEK deneme (runRecommendation aynen). Taslak
  // düzenleme, gezinmeden dönüş ve geri alma yeniden çalıştırmaz; hata
  // sonrasında döngü yapmaz; form/yükleme ve hata durumu her zaman kalır.
  useEffect(() => {
    if (phase !== 'ready') return
    if (route.name !== 'recommend') return
    if (autoLoadTriedRef.current) return
    if (!selection && load.status === 'idle' && (!isDefaultProfile(profile) || onboardResolvedRef.current)) {
      autoLoadTriedRef.current = true
      void runRecommendation(composerMood, composerKind, requestText.slice(0, REQUEST_TEXT_MAX))
    }
  }, [phase, route.name, load.status, selection, profile, runRecommendation, composerMood, composerKind, requestText])

  // Sentinel gözlemcisi: observer tercih edilir, scroll dinleyicisi yoktur.
  // Sentinel her zaman render edilir (node sabit); phase ready'e geçince
  // kurulur. tryAutoLoadMore + ref aynaları güncel okunur, effect tek aktif
  // observer ile cleanup (disconnect) yapar; diğer sekmeler/detail'da
  // guard'lar kesinlikle istek üretmez.
  useEffect(() => {
    const node = sentinelRef.current
    if (node === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target !== node) continue
          sentinelVisibleRef.current = entry.isIntersecting
          if (entry.isIntersecting) tryAutoLoadMore(false)
        }
      },
      { rootMargin: '400px' },
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
      sentinelVisibleRef.current = false
    }
  }, [tryAutoLoadMore, phase])

  // Liste uzadıktan sonra sentinel hâlâ görünürse zincirleme devam;
  // items.length değişmediyse (duplicate/empty sayfa) effect tekrar
  // çalışmaz, aynı generation/length ile fırtına oluşmaz.
  const doneItemsLength = load.status === 'done' ? load.items.length : 0
  useEffect(() => {
    if (sentinelVisibleRef.current) tryAutoLoadMore(false)
  }, [doneItemsLength, composerOpen, tryAutoLoadMore])

  // Sayfa geçişi: öneri rotasından çıkınca eski görünürlük sıfırlanır;
  // dönüşte observer taze geometriyle yeniden değerlendirir.
  useEffect(() => {
    if (route.name !== 'recommend') sentinelVisibleRef.current = false
  }, [route.name])

  // Sayfa geçişi: rota değişiminde ana içerikte 180ms opacity-only solma.
  // translate yok (kaydırma hesabı boyaması yok), kalıcı ekranlar yeniden
  // takılmaz; scroll, arama ve sonuçlar korunur. Ayrıntıda View Transition
  // bakar; azaltılmış harekette geçiş tamamen atlanır.
  const routeKey = routeToPath(route)
  useEffect(() => {
    const element = mainRef.current
    if (!element) return
    if (route.name === 'detail') return
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animation = element.animate(
      [{ opacity: 0.01 }, { opacity: 1 }],
      { duration: 180, easing: 'ease-out' },
    )
    return () => {
      animation.cancel()
    }
  }, [routeKey, route.name])

  if (phase === 'boot') {
    return (
      <main className="screen center" aria-live="polite">
        <div className="splash glass">
          <span className="spinner" aria-hidden="true" />
          <p>CineMind is starting…</p>
        </div>
      </main>
    )
  }

  if (phase === 'bootError') {
    return (
      <main className="screen center">
        <div className="splash panel-error glass" role="alert">
          <h1>Couldn't start CineMind</h1>
          <p className="muted">{bootError}</p>
          <button type="button" className="btn btn-primary" onClick={() => void boot()}>
            Try again
          </button>
        </div>
      </main>
    )
  }

  if (phase === 'onboarding') {
    return <Onboarding initial={profile} onDone={handleOnboard} />
  }

  // ---- ready ----
  const activeText = activeRequestRef.current?.requestText ?? ''
  const activeMood = activeRequestRef.current?.mood ?? selection?.mood
  const activeKind = activeRequestRef.current?.kind ?? selection?.kind
  const nav = (path: string) => {
    const handler = (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainClick(e)) return
      e.preventDefault()
      navigateTo(path)
    }
    return handler
  }

  const renderDiscover = () => (
    <Discover
      onOpenDetail={openDetail}
      getStatus={getStatus}
      onWatch={(item) => void handleWatch(item)}
      onDislike={(item) => void handleDislike(item)}
      isBusy={isBusy}
      onCatalogImported={handleCatalogImported}
    />
  )

  // Detail route data: derive status/busy by route.id so cold loads are correct.
  const detailForRoute = route.name === 'detail' ? route : null
  const memory = detailForRoute ? detailMemoryRef.current.get(detailForRoute.id) : undefined
  const detailItem = memory?.item ?? null
  const detailReason = memory?.reason
  const detailMood = memory?.mood
  const detailStatus = detailForRoute ? getStatus(detailForRoute.id) : { watched: false, disliked: false }
  const detailLiked =
    detailForRoute && detailMood && feedback[`${detailMood}:${detailForRoute.id}`] === 'liked' ? true : false

  const profileName = profile.name

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/discover" className="brand" aria-label="CineMind" onClick={nav('#/discover')}>
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 19V6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5V19M4 19h16M4 19H2.8M20 19h1.2M4 15h16M4 9.5h16M20 15v4M20 9.5V15M4 9.5V15M7.5 2.8v2.4M16.5 2.8v2.4" />
            </svg>
          </span>
          <span className="brand-name">CineMind</span>
        </a>

        <SlidingNav
          ariaLabel="Main navigation"
          className="topnav"
          items={[
            {
              href: '#/discover',
              label: 'Discover',
              active: route.name === 'discover',
              onNavigate: nav('#/discover'),
            },
            {
              href: '#/recommendations',
              label: 'Recommendations',
              active: route.name === 'recommend',
              onNavigate: nav('#/recommendations'),
            },
            {
              href: '#/library',
              label: 'Library',
              active: route.name === 'library',
              onNavigate: nav('#/library'),
            },
            {
              href: '#/profile',
              label: 'Profile',
              active: route.name === 'profile',
              onNavigate: nav('#/profile'),
            },
          ]}
        />

        <a href="#/profile" className="profile-trigger" aria-label="Edit profile" onClick={nav('#/profile')}>
          <span className="avatar" aria-hidden="true">
            {profileName ? profileName.trim().charAt(0).toLocaleUpperCase('en-US') : '?'}
          </span>
          <span className="profile-name">{profileName || 'Profile'}</span>
        </a>
      </header>

      <main className="app-main" ref={mainRef}>
        {route.name === 'unknown' ? (
          <section aria-labelledby="fallback-title">
            <div className="page-header">
              <h1 id="fallback-title">Page not found</h1>
              <p className="muted">The page you're looking for may have moved or never existed.</p>
            </div>
            <div className="form-actions">
              <a href="#/recommendations" className="btn btn-primary" onClick={nav('#/recommendations')}>
                Go to recommendations
              </a>
              <a href="#/discover" className="btn btn-ghost" onClick={nav('#/discover')}>
                Discover the catalog
              </a>
            </div>
          </section>
        ) : null}
        <>
            {/* Recommendations (persistent; hidden when inactive) */}
            <section hidden={route.name !== 'recommend'} aria-label="Recommendations">
              <div className="page-header">
                <h1>What do you want to watch tonight?</h1>
                <p className="muted">Movie, series, and anime recommendations based on your taste and tonight's mood.</p>
              </div>

              {!composerOpen && activeMood && activeKind ? (
                <div className="request-summary">
                  <div>
                    <span className="chip-static">{moodLabel(activeMood)}</span>
                    <span className="chip-static">{kindLabel(activeKind)}</span>
                    <h2>{activeText ? `“${activeText}”` : `Recommendations for a ${moodLabel(activeMood)} mood`}</h2>
                    <p className="muted">This request is separate from your profile; it applies only to this set of recommendations.</p>
                  </div>
                  <div className="request-controls">
                    <button type="button" className="btn btn-primary" onClick={() => setComposerOpen(true)}>
                      Edit request
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void runRecommendation(activeMood, activeKind, activeText)}
                    >
                      Refresh
                    </button>
                  </div>
                </div>
              ) : (
                <form className="request-composer" onSubmit={submitComposer}>
                  <div className="request-fields">
                    <div className="field">
                      <label htmlFor="request-text">Describe it briefly</label>
                      <textarea
                        id="request-text"
                        value={requestText}
                        onChange={(e) => setRequestText(e.target.value.slice(0, REQUEST_TEXT_MAX))}
                        placeholder="Leave blank for general recommendations. e.g. something calm and romantic"
                        maxLength={REQUEST_TEXT_MAX}
                        rows={2}
                        aria-describedby="request-text-hint"
                      />
                      <p id="request-text-hint" className="field-hint muted">
                        This request is for this time only — separate from your profile.
                      </p>
                      <p className="char-count muted" aria-live="polite">
                        {requestText.length}/2000
                      </p>
                    </div>

                    <fieldset className="kind-picker">
                      <legend>Format</legend>
                      <div role="group" aria-label="Format">
                        {KIND_OPTIONS.map((k) => (
                          <button
                            key={k.value}
                            type="button"
                            className={`segment${composerKind === k.value ? ' segment-selected' : ''}`}
                            aria-pressed={composerKind === k.value}
                            onClick={() => setComposerKind(k.value)}
                          >
                            {k.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset className="mood-options">
                      <legend>Mood</legend>
                      <div role="group" aria-label="Mood">
                        {MOOD_OPTIONS.map((m) => (
                          <button
                            key={m.value}
                            type="button"
                            className={`segment${composerMood === m.value ? ' segment-selected' : ''}`}
                            aria-pressed={composerMood === m.value}
                            onClick={() => setComposerMood(m.value)}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  </div>

                  <div className="request-controls">
                    <button type="submit" className="btn btn-primary btn-lg" disabled={load.status === 'loading'}>
                      {load.status === 'loading' ? 'Loading…' : 'Find recommendations'}
                    </button>
                    {activeMood && activeKind && load.status !== 'loading' ? (
                      <button type="button" className="btn btn-ghost" onClick={() => setComposerOpen(false)}>
                        Cancel
                      </button>
                    ) : null}
                    {requestText.length > 0 ? (
                      <button type="button" className="btn btn-ghost" onClick={() => setRequestText('')}>
                        Clear
                      </button>
                    ) : null}
                  </div>
                </form>
              )}

              {load.status === 'loading' ? (
                <section className="results" aria-busy="true" aria-live="polite">
                  <p className="status-line muted">Preparing recommendations…</p>
                  <div className="rec-grid" aria-hidden="true">
                    {Array.from({ length: 3 }, (_, i) => (
                      <div key={i} className="rec-card skeleton-card">
                        <div className="skeleton skeleton-poster" />
                        <div className="skeleton-lines">
                          <div className="skeleton line w-70" />
                          <div className="skeleton line w-40" />
                          <div className="skeleton line w-95" />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {load.status === 'error' ? (
                <section className="results">
                  <div className="splash panel-error glass" role="alert">
                    <h2>Couldn't load recommendations</h2>
                    <p className="muted">{load.error}</p>
                    <div className="form-actions centered">
                      {selection ? (
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => void runRecommendation(selection.mood, selection.kind, activeText)}
                        >
                          Try again
                        </button>
                      ) : null}
                    </div>
                  </div>
                </section>
              ) : null}

              {load.status === 'done' && selection ? (
                <section className="results">
                  <div className="results-head">
                    <p className="count-line muted">
                      {load.items.length > 0
                        ? `${load.items.length} recommendation${load.items.length === 1 ? '' : 's'} listed`
                        : load.hasMore
                          ? 'No recommendations listed yet — more can be scanned'
                          : 'No recommendations yet'}
                    </p>
                  </div>

                  <NoticeBar notice={load.notice} />

                  {load.items.length === 0 && load.hasMore ? (
                    <div className="splash glass">
                      <h2>No matches in this scan</h2>
                      <p className="muted">The first scan returned no results; continue scanning to fetch more.</p>
                      {loadingMore ? (
                        <p className="status-line muted" aria-live="polite">
                          Loading more…
                        </p>
                      ) : null}
                      {moreError ? (
                        <>
                          <p className="load-more-error" role="alert">
                            {moreError}
                          </p>
                          <div className="load-more-row">
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => void loadMore()}
                              disabled={loadingMore}
                            >
                              Try again
                            </button>
                          </div>
                        </>
                      ) : null}
                      <div className="form-actions centered">
                        <button type="button" className="btn btn-ghost" onClick={() => setComposerOpen(true)}>
                          Edit request
                        </button>
                      </div>
                    </div>
                  ) : load.items.length === 0 ? (
                    <div className="splash glass">
                      <h2>No recommendations found</h2>
                      <p className="muted">No recommendations for this mood and format right now. Edit the request and try again.</p>
                      <div className="form-actions centered">
                        <button type="button" className="btn btn-primary" onClick={() => setComposerOpen(true)}>
                          Edit request
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Single continuous grid: first 3, same size/accent
                          as the rest; only marked featured. */}
                      <div className={`rec-grid${load.items.length < 3 ? ` rec-grid-n${load.items.length}` : ''}`}>
                        {load.items.map((item, i) => {
                          const st = getStatus(item.id)
                          const pref = feedback[`${selection.mood}:${item.id}`]
                          return (
                            <RecommendationCard
                              key={item.id}
                              item={item}
                              index={i}
                              entryDelayMs={entryDelayById[item.id] ?? 0}
                              featured={i < 3}
                              preference={pref}
                              watched={st.watched}
                              disliked={st.disliked}
                              busy={isBusy(item.id)}
                              onOpen={openRecDetail}
                              onWatch={(it) => void handleWatch(it)}
                              onDislike={(it) => void handleDislike(it, selection.mood)}
                              onLike={(it, liked) => void (liked ? handleLike(it, selection.mood) : handleDislike(it, selection.mood))}
                            />
                          )
                        })}
                      </div>
                      {loadingMore ? (
                        <p className="status-line muted" aria-live="polite">
                          Loading more…
                        </p>
                      ) : null}
                      {moreError ? (
                        <>
                          <p className="load-more-error" role="alert">
                            {moreError}
                          </p>
                          <div className="load-more-row">
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => void loadMore()}
                              disabled={loadingMore}
                            >
                              Try again
                            </button>
                          </div>
                        </>
                      ) : null}
                    </>
                  )}
                </section>
              ) : null}
              {/* Infinite scroll sentinel: her zaman render edilir, node sabittir. */}
              <div
                ref={sentinelRef}
                className="rec-sentinel catalog-sentinel"
                aria-hidden="true"
                style={{ minHeight: '1px' }}
              />
            </section>

            {(hasVisitedDiscover || route.name === 'discover') ? (
              <div hidden={route.name !== 'discover'}>{renderDiscover()}</div>
            ) : null}

            {(hasVisitedLibrary || route.name === 'library') ? (
              <div hidden={route.name !== 'library'}>
                <LibraryView
                  entries={libraryEntries}
                  loading={libraryLoading}
                  onOpenDetail={openDetail}
                  onUndo={(entry, kind) => void handleLibraryUndo(entry, kind)}
                  isBusy={isBusy}
                />
              </div>
            ) : null}
          </>

        {route.name === 'detail' && detailForRoute ? (
          <DetailPage
            key={detailForRoute.id}
            detailId={detailForRoute.id}
            item={detailItem}
            reason={detailReason}
            mood={detailMood}
            watched={detailStatus.watched}
            disliked={detailStatus.disliked}
            liked={detailLiked}
            busy={isBusy(detailForRoute.id)}
            onWatch={(it) => void handleWatch(it)}
            onDislike={(it) => void handleDislike(it, detailMood)}
            onLike={detailMood ? (it, m) => void handleLike(it, m) : undefined}
            onBack={handleBackFromDetail}
            onOpenDetail={(it) => openDetail(it)}
          />
        ) : null}

        {route.name === 'profile' ? (
          <ProfileEditor profile={profile} onSave={saveProfile} onBack={() => navigateTo('#/discover')} />
        ) : null}

        <SlidingNav
          ariaLabel="Main navigation"
          className="mobile-nav"
          items={[
            {
              href: '#/discover',
              label: 'Discover',
              active: route.name === 'discover',
              onNavigate: nav('#/discover'),
            },
            {
              href: '#/recommendations',
              label: 'Recommendations',
              active: route.name === 'recommend',
              onNavigate: nav('#/recommendations'),
            },
            {
              href: '#/library',
              label: 'Library',
              active: route.name === 'library',
              onNavigate: nav('#/library'),
            },
          ]}
        />
      </main>

      <div className="toast" role="status" aria-live="polite">
        {toast ? (
          <>
            <span>{toast}</span>
            {pendingUndo ? (
              <button type="button" className="toast-undo" onClick={() => void undoPending()}>
                Undo
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
