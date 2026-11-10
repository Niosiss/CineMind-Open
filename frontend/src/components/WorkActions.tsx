import { CheckIcon } from './icons'

interface WorkActionsProps {
  watched?: boolean
  disliked?: boolean
  liked?: boolean
  /** Kept for caller compatibility; like controls are not shown in the UI. */
  showLike?: boolean
  busy?: boolean
  onWatch: (e: React.MouseEvent<HTMLButtonElement>) => void
  onDislike: (e: React.MouseEvent<HTMLButtonElement>) => void
  onLike?: (e: React.MouseEvent<HTMLButtonElement>) => void
}

/** Single 44x44 icon-only "Watched" check with an accessible label. */
export function WorkActions({ watched, busy, onWatch }: WorkActionsProps) {
  const stop = (fn: (e: React.MouseEvent<HTMLButtonElement>) => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    fn(e)
  }
  return (
    <div className="work-actions">
      <button
        type="button"
        className={`work-btn work-btn-icon work-btn-check${watched ? ' work-btn-active-watch' : ''}`}
        aria-pressed={Boolean(watched)}
        aria-label="Mark as watched"
        title={watched ? 'Marked as watched' : 'Watched'}
        disabled={busy}
        onClick={stop(onWatch)}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <CheckIcon size={20} />
      </button>
    </div>
  )
}
