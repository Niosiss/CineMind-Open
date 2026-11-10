import { useEffect, useState } from 'react'

function osReduced(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Hafif ambiyans ışıkları: 2-3 sabit projeksiyon/kuzey ışığı katmanı
 * (CSS transform/opacity ile yavaş nefes; sürekli düzen boyaması yok).
 * İçerik altında, metnin üstünde değil; pointer-events: none.
 * El ile kontrol yoktur; OS prefers-reduced-motion ilk yüklemede
 * ve değişimde saygı görür. Azaltılmış harekette ışıklar sabit durur.
 */
export function LivingBackdrop() {
  const [osReduce, setOsReduce] = useState<boolean>(() => osReduced())

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setOsReduce(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('lights-paused', osReduce)
    return () => {
      document.documentElement.classList.remove('lights-paused')
    }
  }, [osReduce])

  return (
    <div className="lights-backdrop" aria-hidden="true">
      <div className="lights-layer lights-projector" />
      <div className="lights-layer lights-aurora lights-aurora--aqua" />
      <div className="lights-layer lights-aurora lights-aurora--coral" />
    </div>
  )
}
