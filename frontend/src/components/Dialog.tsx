import { useCallback, useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { CloseIcon } from './icons'

interface DialogProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Accessible dialog: aria-modal, Escape to close, focus trap, and focus
 * returned to the opener when it closes.
 */
export function Dialog({ open, title, onClose, children, wide }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // The latest onClose always runs through a ref, so the focus-trap
  // lifecycle below depends only on `open` even when the parent creates
  // a new inline onClose on every render.
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const handleClose = useCallback(() => {
    onCloseRef.current()
  }, [])

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return

    const opener = document.activeElement as HTMLElement | null
    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('data-hidden-focus'),
      )

    // Focus the first interactive element.
    focusables()[0]?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => !el.hasAttribute('data-hidden-focus'))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !panelRef.current!.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      opener?.focus?.()
    }
    // The lifecycle depends only on `open`; the current onClose comes
    // from the ref, so typing does not re-run the effect and steal focus.
  }, [open])

  if (!open) return null

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`dialog glass-strong${wide ? ' dialog-wide' : ''}`}
      >
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={handleClose}
            aria-label="Close dialog"
          >
            <CloseIcon size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
