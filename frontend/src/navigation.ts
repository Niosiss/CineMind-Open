/**
 * Hash-based routing for static hosting.
 *
 * Routes live in the URL fragment so the app works from any static host
 * without server rewrites:
 *   #/discover, #/recommendations, #/library, #/profile, #/title/:id
 */

export type Route =
  | { name: 'recommend' }
  | { name: 'discover' }
  | { name: 'library' }
  | { name: 'profile' }
  | { name: 'detail'; id: string }
  | { name: 'unknown'; path: string }

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Accepts a hash ("#/discover"), a path ("/discover"), or an empty value. */
function normalizePath(input: string): string {
  let value = (input || '').trim()
  if (value.startsWith('#')) value = value.slice(1)
  if (value === '') return '/'
  if (!value.startsWith('/')) value = `/${value}`
  if (value.length > 1 && value.endsWith('/')) return value.slice(0, -1)
  return value
}

export function parseRoute(input: string): Route {
  const normalized = normalizePath(input)
  if (normalized === '/') return { name: 'discover' }
  if (normalized === '/discover') return { name: 'discover' }
  if (normalized === '/recommendations') return { name: 'recommend' }
  if (normalized === '/library') return { name: 'library' }
  if (normalized === '/profile') return { name: 'profile' }
  const detailMatch = normalized.match(/^\/title\/([^/]+)$/)
  if (detailMatch) {
    const id = safeDecode(detailMatch[1])
    if (id !== '') return { name: 'detail', id }
    return { name: 'unknown', path: normalized }
  }
  return { name: 'unknown', path: normalized }
}

export function routeToPath(route: Route): string {
  switch (route.name) {
    case 'recommend':
      return '#/recommendations'
    case 'discover':
      return '#/discover'
    case 'library':
      return '#/library'
    case 'profile':
      return '#/profile'
    case 'detail':
      return detailHref(route.id)
    case 'unknown':
      return `#${route.path}`
  }
}

export function detailHref(id: string): string {
  return `#/title/${encodeURIComponent(id)}`
}

export interface PlainClickEventLike {
  button?: number
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  defaultPrevented?: boolean
}

/** Unmodified (plain) click: left button, no modifier keys, not already prevented. */
export function isPlainClick(e: PlainClickEventLike): boolean {
  if (e.defaultPrevented) return false
  if (typeof e.button === 'number' && e.button !== 0) return false
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  return true
}
