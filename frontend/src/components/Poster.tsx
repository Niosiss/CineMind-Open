import { useEffect, useState } from 'react'
import { FilmIcon } from './icons'

interface PosterProps {
  src?: string
  title: string
  className?: string
}

/**
 * Local asset URLs only: relative paths, data URLs, or blob URLs returned
 * by the local adapter. Remote HTTP(S) URLs are never auto-fetched.
 */
export function isLocalAssetUrl(value?: string): boolean {
  if (typeof value !== 'string') return false
  const src = value.trim()
  if (src === '') return false
  if (/^(https?:)?\/\//i.test(src)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    return /^(data|blob):/i.test(src)
  }
  return true
}

/**
 * Poster image: when there is no local asset URL, or it fails to load,
 * show a neutral placeholder with the title. Nothing is generated.
 * The 2:3 area is always reserved.
 */
export function Poster({ src, title, className = '' }: PosterProps) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  const usable = isLocalAssetUrl(src) && !failed
  const imageSrc = usable ? src : undefined

  return (
    <div className={`poster ${usable ? '' : 'poster-fallback'} ${className}`.trim()}>
      {imageSrc ? (
        <img
          src={imageSrc}
          alt={`${title} poster`}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <Fallback art={title} />
      )}
    </div>
  )
}

function Fallback({ art }: { art: string }) {
  return (
    <div className="poster-fallback-inner" aria-hidden="true">
      <FilmIcon size={28} />
      <span>{art}</span>
    </div>
  )
}
