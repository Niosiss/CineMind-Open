import { useEffect, useState, type FormEvent } from 'react'
import type { Profile } from '../types'
import { SearchableGenrePicker } from './SearchableGenrePicker'

export const PREFERENCES_MAX = 2000

export const PREFERENCES_PLACEHOLDER =
  'For example. I like: slow-burn stories with emotional depth, quiet comedies, and thoughtful science fiction. ' +
  'I avoid: sudden jump scares, nonstop action, and forced romantic clichés.'

interface ProfileEditorProps {
  profile: Profile
  onSave: (p: Profile) => Promise<void>
  onBack?: () => void
}

/** Profile page: name, taste notes (primary text), and favorite genres (optional). */
export function ProfileEditor({ profile, onSave, onBack }: ProfileEditorProps) {
  const [name, setName] = useState(profile.name)
  const [preferences, setPreferences] = useState(profile.preferences ?? '')
  const [genres, setGenres] = useState<string[]>(profile.genres ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setName(profile.name)
    setPreferences(profile.preferences ?? '')
    setGenres(profile.genres ?? [])
    setError(null)
  }, [profile])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Please enter your name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        name: trimmed.slice(0, 40),
        genres,
        preferences: preferences.slice(0, PREFERENCES_MAX),
      })
      onBack?.()
    } catch {
      setError("Couldn't save your profile. Please try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="profile-page" aria-labelledby="profile-heading">
      <div className="page-header">
        <h1 id="profile-heading">Edit Profile</h1>
        <p className="muted">Your name, taste notes, and favorite genres shape your recommendations.</p>
      </div>

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="profile-name">Your name</label>
          <input
            id="profile-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alex"
            maxLength={40}
            autoComplete="given-name"
          />
        </div>

        <div className="field">
          <label htmlFor="profile-preferences">
            Taste notes <span className="muted">(in your own words, optional)</span>
          </label>
          <textarea
            id="profile-preferences"
            value={preferences}
            onChange={(e) => setPreferences(e.target.value.slice(0, PREFERENCES_MAX))}
            placeholder={PREFERENCES_PLACEHOLDER}
            maxLength={PREFERENCES_MAX}
            rows={4}
            aria-describedby="profile-preferences-count profile-preferences-hint"
          />
          <p id="profile-preferences-hint" className="field-hint muted">
            Write a little about what you like and avoid, and recommendations will follow suit.
          </p>
          <p id="profile-preferences-count" className="char-count muted" aria-live="polite">
            {preferences.length}/{PREFERENCES_MAX}
          </p>
        </div>

        <SearchableGenrePicker value={genres} onChange={setGenres} />

        <div className="form-status" aria-live="assertive">
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {onBack ? (
            <button type="button" className="btn btn-ghost" onClick={onBack} disabled={saving}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </section>
  )
}
