import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, isDefaultProfile } from '../localStore'
import type { Profile } from '../types'
import { SearchableGenrePicker } from './SearchableGenrePicker'

interface OnboardingProps {
  initial: Profile
  onDone: (p: Profile) => Promise<void>
}

export const PREFERENCES_MAX = 2000

export const PREFERENCES_PLACEHOLDER =
  'For example. I like: slow-burn stories with emotional depth, quiet comedies, and thoughtful science fiction. ' +
  'I avoid: sudden jump scares, nonstop action, and forced romantic clichés.'

/** First-run profile flow: name + taste notes (primary) + genres (optional). */
export function Onboarding({ initial, onDone }: OnboardingProps) {
  const [name, setName] = useState(initial.name)
  const [preferences, setPreferences] = useState(initial.preferences ?? '')
  const [genres, setGenres] = useState<string[]>(initial.genres ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
  }, [name, preferences, genres])

  const submit = async (p: Profile) => {
    setSaving(true)
    setError(null)
    try {
      await onDone(p)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save your profile. Please try again.")
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Please enter your name so recommendations can feel personal.')
      return
    }
    void submit({
      name: trimmed.slice(0, 40),
      genres,
      preferences: preferences.slice(0, PREFERENCES_MAX),
    })
  }

  const skip = () => {
    // Continue with an empty profile; details can be added later from "Edit Profile".
    void submit({ name: '', genres: [], preferences: '' })
  }

  return (
    <main className="screen onboarding">
      <div className="onboarding-card" role="form" aria-label="Create profile">
        <h1 className="onboarding-title">Let's get to know you</h1>
        <p className="muted onboarding-sub">
          Share a few details so recommendations can match your taste. This
          information stays in this browser.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="onboarding-name">Your name</label>
            <input
              id="onboarding-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Alex"
              maxLength={40}
              autoComplete="given-name"
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="onboarding-preferences">
              Taste notes <span className="muted">(in your own words, optional)</span>
            </label>
            <textarea
              id="onboarding-preferences"
              value={preferences}
              onChange={(e) => setPreferences(e.target.value.slice(0, PREFERENCES_MAX))}
              placeholder={PREFERENCES_PLACEHOLDER}
              maxLength={PREFERENCES_MAX}
              rows={4}
              aria-describedby="onboarding-preferences-count onboarding-preferences-hint"
            />
            <p id="onboarding-preferences-hint" className="field-hint muted">
              Write a little about what you like and avoid, and recommendations will follow suit.
            </p>
            <p id="onboarding-preferences-count" className="char-count muted" aria-live="polite">
              {preferences.length}/{PREFERENCES_MAX}
            </p>
          </div>

          <details className="onboarding-more" open={genres.length > 0}>
            <summary className="onboarding-more-toggle">
              Genres and themes <span className="muted">(optional{genres.length > 0 ? `, ${genres.length} selected` : ''})</span>
            </summary>
            <SearchableGenrePicker value={genres} onChange={setGenres} />
          </details>

          <div className="form-status" aria-live="assertive">
            {error ? (
              <p className="form-error" role="alert">{error}</p>
            ) : (
              <p className="visually-hidden">Form ready.</p>
            )}
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Create my profile'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={skip}
              disabled={saving}
            >
              Not now
            </button>
          </div>
        </form>

        <p className="footnote muted">
          {isDefaultProfile(initial) ? '' : 'Your existing profile was restored; you can edit and save it here.'}
        </p>
      </div>
    </main>
  )
}
