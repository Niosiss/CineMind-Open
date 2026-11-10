import { useEffect, useState } from 'react'
import { KIND_OPTIONS, MOOD_OPTIONS } from '../i18n'
import type { Kind, Mood } from '../types'
import { Dialog } from './Dialog'

interface MoodPickerProps {
  open: boolean
  initialMood: Mood | null
  initialKind: Kind
  requestText: string
  onRequestTextChange: (text: string) => void
  onClose: () => void
  onConfirm: (mood: Mood, kind: Kind, requestText: string) => void
}

const REQUEST_TEXT_MAX = 2000

const ICONS: Record<Mood, JSX.Element> = {
  relax: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M20 13.5A8.5 8.5 0 1 1 10.5 4 7 7 0 0 0 20 13.5z" />
    </svg>
  ),
  uplift: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
    </svg>
  ),
  think: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M9.5 18h5M10 21h4M12 3a6 6 0 0 1 3.6 10.8c-.7.5-1.1 1.3-1.1 2.2h-5c0-.9-.4-1.7-1.1-2.2A6 6 0 0 1 12 3z" />
    </svg>
  ),
  thrill: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12h4l2.5-7 4 14 2.5-7h6" />
    </svg>
  ),
  feel: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20.5S3.5 15 3.5 9.3A4.8 4.8 0 0 1 12 6.4a4.8 4.8 0 0 1 8.5 2.9c0 5.7-8.5 11.2-8.5 11.2z" />
    </svg>
  ),
}

/** Mood + format picker opened from the main action. */
export function MoodPicker({
  open,
  initialMood,
  initialKind,
  requestText,
  onRequestTextChange,
  onClose,
  onConfirm,
}: MoodPickerProps) {
  const [mood, setMood] = useState<Mood | null>(initialMood)
  const [kind, setKind] = useState<Kind>(initialKind)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (open) {
      setMood(initialMood)
      setKind(initialKind)
      setConfirming(false)
    }
  }, [open, initialMood, initialKind])

  const confirm = async () => {
    if (!mood || confirming) return
    setConfirming(true)
    onConfirm(mood, kind, requestText.slice(0, REQUEST_TEXT_MAX))
  }

  return (
    <Dialog open={open} title="What do you want to watch tonight?" onClose={onClose}>
      <fieldset className="picker-section">
        <legend>Mood</legend>
        <div className="mood-grid mood-options">
          {MOOD_OPTIONS.map((m) => {
            const selected = mood === m.value
            return (
              <button
                key={m.value}
                type="button"
                className={`mood-card${selected ? ' mood-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => setMood(m.value)}
              >
                <span className="mood-icon">{ICONS[m.value]}</span>
                <span className="mood-label">{m.label}</span>
                <span className="mood-hint">{m.hint}</span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <fieldset className="picker-section">
        <legend>Format</legend>
        <div className="segmented kind-picker" role="group" aria-label="Choose format">
          {KIND_OPTIONS.map((k) => {
            const selected = kind === k.value
            return (
              <button
                key={k.value}
                type="button"
                className={`segment${selected ? ' segment-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => setKind(k.value)}
              >
                {k.label}
              </button>
            )
          })}
        </div>
      </fieldset>

      <div className="field request-text-field">
        <div className="request-text-label-row">
          <label htmlFor="request-text">Anything specific in mind?</label>
          {requestText.length > 0 ? (
            <button
              type="button"
              className="link-btn request-text-clear"
              onClick={() => onRequestTextChange('')}
              aria-label="Clear request"
            >
              Clear
            </button>
          ) : null}
        </div>
        <textarea
          id="request-text"
          value={requestText}
          onChange={(e) => onRequestTextChange(e.target.value.slice(0, REQUEST_TEXT_MAX))}
          placeholder="e.g. something calm and romantic"
          maxLength={REQUEST_TEXT_MAX}
          rows={2}
          aria-describedby="request-text-hint"
        />
        <p id="request-text-hint" className="field-hint muted">
          You can leave this empty. The text applies only to this request and isn't saved to your profile.
        </p>
        <p className="char-count muted" aria-live="polite">
          {requestText.length}/2000
        </p>
      </div>

      <div className="form-actions dialog-actions">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          onClick={confirm}
          disabled={!mood || confirming}
        >
          Find recommendations
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={confirming}>
          Cancel
        </button>
      </div>
    </Dialog>
  )
}
