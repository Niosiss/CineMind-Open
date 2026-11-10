import { InfoIcon } from './icons'

interface NoticeBarProps {
  /** Notice text supplied by the local store; hidden when empty. */
  notice?: string
}

/** Vendor-specific fallback notices are not part of a clean local build. */
const VENDOR_NOTICE = /\b(tmdb|tvmaze|kitsu|myanimelist|jikan|imdb)\b|live provider/i

/**
 * Drop/fallback notices. Neutral text is shown as-is; provider-specific
 * fallback messages are suppressed.
 */
export function NoticeBar({ notice }: NoticeBarProps) {
  const text = (notice ?? '').trim()
  if (!text) return null
  if (VENDOR_NOTICE.test(text)) return null

  return (
    <div className="notice-bar" role="status">
      <InfoIcon size={18} />
      <span>{text}</span>
    </div>
  )
}
