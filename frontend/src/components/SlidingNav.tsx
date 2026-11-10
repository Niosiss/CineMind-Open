import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'

export interface SlidingNavItem {
  href: string
  label: string
  active: boolean
  onNavigate: (e: MouseEvent<HTMLAnchorElement>) => void
}

interface SlidingNavProps {
  items: SlidingNavItem[]
  ariaLabel: string
  className?: string
}

interface IndicatorPosition {
  visible: boolean
  left: number
  top: number
  width: number
  height: number
}

/**
 * Kayar göstergeli gezinme: TEK fiziksel gösterge öğesi aktif bağlantının
 * offset/ölçüsünü ölçer (useLayoutEffect + ResizeObserver) ve 260ms
 * ease-out ile seçili bağlantıya kayar. Bağlantı davranışları, aria-current
 * ve yönlendiriciler aynen korunur; aktif öğe yoksa (ör. ayrıntı) gösterge
 * gizlenir.
 */
export function SlidingNav({ items, ariaLabel, className }: SlidingNavProps) {
  const navRef = useRef<HTMLElement | null>(null)
  const [pos, setPos] = useState<IndicatorPosition>({
    visible: false,
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  })

  const activeKey = items.map((item) => (item.active ? item.href : '')).join('|')

  const measure = () => {
    const nav = navRef.current
    if (!nav) return
    const anchor = nav.querySelector<HTMLAnchorElement>('a.nav-btn[aria-current="page"]')
    setPos((previous) => {
      if (!anchor) {
        return previous.visible ? { ...previous, visible: false } : previous
      }
      const next: IndicatorPosition = {
        visible: true,
        left: anchor.offsetLeft,
        top: anchor.offsetTop,
        width: anchor.offsetWidth,
        height: anchor.offsetHeight,
      }
      if (
        previous.visible &&
        previous.left === next.left &&
        previous.top === next.top &&
        previous.width === next.width &&
        previous.height === next.height
      ) {
        return previous
      }
      return next
    })
  }

  useLayoutEffect(() => {
    measure()
  }, [activeKey])

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        measure()
      })
      resizeObserver.observe(nav)
    }

    const onResize = () => {
      measure()
    }
    window.addEventListener('resize', onResize)

    // Font yüklenmesi bağlantı genişliklerini kaydırabilir; yeniden ölç.
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts.ready.then(() => {
        measure()
      })
    }

    return () => {
      if (resizeObserver) resizeObserver.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <nav ref={navRef} className={className} aria-label={ariaLabel}>
      <span
        className="sliding-nav-indicator"
        aria-hidden="true"
        style={{
          left: 0,
          top: pos.top,
          width: pos.width,
          height: pos.height,
          opacity: pos.visible ? 1 : 0,
          transform: `translateX(${pos.left}px)`,
        }}
      />
      {items.map((item) => (
        <a
          key={item.href}
          href={item.href}
          className={`nav-btn${item.active ? ' nav-btn-active' : ''}`}
          aria-current={item.active ? 'page' : undefined}
          onClick={item.onNavigate}
        >
          {item.label}
        </a>
      ))}
    </nav>
  )
}
