/**
 * Paylaşılan satır-içi SVG ikonları: tek tutarlılığı, currentColor,
 * 1.8 stroke. Emojisiz ikon sisteminin tek kaynağı.
 */
interface IconProps {
  size?: number
  className?: string
}

function base(size: number, className: string | undefined) {
  return {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    'aria-hidden': true,
    focusable: false,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...(className ? { className } : {}),
  }
}

/** Sinema / afiş. */
export function FilmIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 19V6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5V19M4 19h16M4 19H2.8M20 19h1.2M4 15h16M4 9.5h16M20 15v4M20 9.5V15M4 9.5V15M7.5 2.8v2.4M16.5 2.8v2.4" />
    </svg>
  )
}

export function SearchIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="11" cy="11" r="6.4" />
      <path d="M15.8 15.8L20.5 20.5" />
    </svg>
  )
}

export function CloseIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} strokeWidth={2.2}>
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  )
}

export function ThumbUpIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M7 11v9M7 11l3.8-6.2a2 2 0 0 1 3.7 1.2L14 9h4.2a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 17 19H7M7 11H4.5a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4.5 20H7" />
    </svg>
  )
}

export function ThumbDownIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} style={{ transform: 'scaleY(-1)' }}>
      <path d="M7 11v9M7 11l3.8-6.2a2 2 0 0 1 3.7 1.2L14 9h4.2a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 17 19H7M7 11H4.5a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4.5 20H7" />
    </svg>
  )
}

export function ExternalIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M7 17L17 7M9 7h8v8" />
    </svg>
  )
}

export function UndoIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M8 5L3 10M3 10l5 5M3 10h11a6 6 0 0 1 0 12h-3" />
    </svg>
  )
}

export function InfoIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 8v.3M12 11.4V16" />
    </svg>
  )
}

export function StarIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="currentColor" stroke="none">
      <path d="M12 2.7l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2L12 17l-5.6 2.9 1.1-6.2L2.9 9.3l6.3-.9L12 2.7z" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M6 9.5l6 6 6-6" />
    </svg>
  )
}

export function ArrowLeftIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M20 12H4M10 6l-6 6 6 6" />
    </svg>
  )
}

export function PauseIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M8 5v14M16 5v14" />
    </svg>
  )
}

export function PlayIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M7 4.8L19 12 7 19.2z" />
    </svg>
  )
}
