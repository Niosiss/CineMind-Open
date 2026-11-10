# CineMind product brief

## Platform

Static web application for desktop and mobile browsers.

## Stack

React, TypeScript, Vite, and plain CSS for the interface. A Rust recommendation engine in `engine/` is compiled to `wasm32-unknown-unknown` and loaded through wasm-bindgen `0.2.130`. Persistence uses browser `localStorage`. There is no server, account system, or third-party integration.

## Users

People deciding what movie, series, or anime to watch next, especially those who want their catalog and viewing preferences to stay in their own browser. They may have a metadata export they are permitted to use and are comfortable importing a JSON file.

## Product purpose

Make the next viewing choice easier without sending personal taste data to a service. CineMind combines a user-supplied catalog with a free-text request, an optional mood, and local preferences to produce ranked suggestions. Users can browse the catalog, open a title, mark it watched, dismiss it, and revisit their library.

## Positioning

A local-first decision aid, not a streaming service or a hosted recommendation platform. The ranking engine runs in the browser; the catalog is imported by the user; the app has no provider connectors, remote APIs, telemetry, or cloud sync.

## Operating context

- The app is served as static files, locally through Vite or from any static host.
- The user imports a UTF-8 JSON array through **Discover > Import catalog**.
- Import limits are 2 MB and 2,000 entries.
- Catalog fields: `id`, `title`, `kind` (`movie`, `series`, or `anime`), `year`, `genres` (string array), `description`, and optional `sourceUrl` and `posterUrl`.
- Local artwork is supplied by the user under `frontend/public/local-assets/` and referenced as `local-assets/...`.
- Imported data, profile, preferences, and library state live in `localStorage` for the current origin.

## Capabilities and constraints

### Capabilities

- Import a local catalog and keep it across reloads in the same browser origin.
- Describe a viewing request in free text and choose an optional kind and mood.
- Rank catalog entries locally with the Rust engine.
- Browse results and open an addressable detail view.
- Mark titles watched or not interested; undo the last state change.
- Filter the library by kind and revisit local history.
- Work without a server, account, or network call to a metadata provider.

### Constraints

- No server process, server database, authentication, or cloud storage.
- No third-party integrations, analytics, or remote media embeds.
- No bundled real titles, logos, screenshots, artwork, or credentials.
- The release does not read, migrate, or write a server-side SQLite database from earlier versions.
- The catalog is limited to 2 MB and 2,000 entries per import.
- `localStorage` is origin-scoped, not encrypted, and can be cleared by the user or browser.
- Missing artwork or metadata must be shown as missing, not fabricated.
- Recommendation explanations are local and plain; do not invent scores, ratings, or editorial claims.
- Provider credentials and provider-specific connectors are out of scope for the repository. Users may prepare data in a separate script or private server they control, then import the resulting JSON.

## Non-goals

- Video playback, streaming links, downloads, or DRM.
- Accounts, social features, comments, or sharing.
- Cloud sync, backup, or cross-device profiles.
- Scraping, bypassing access controls, or bundling third-party metadata.
- Bundling or hotlinking third-party artwork without permission.
- A server-side API or a database migration path.

## Brand commitments

CineMind is a quiet, cinematic viewing guide. The visual direction uses night-navy surfaces, light text, an aqua accent, and coral for negative states. Content comes from the user's catalog, so the interface must not look like a streaming catalog or a marketing page.

- **Discover** is the root landing screen.
- Navigation stays compact and predictable on desktop and mobile.
- Results use one continuous grid with equal card dimensions.
- Recommendation reasons are short, local, and honest.
- The interface does not imply a server, account, or cloud backup.
- No external media, logos, or provider branding appears in the product surface.

## Product principles

1. Help the user decide quickly.
2. Let the imported content lead.
3. Give every element a purpose.
4. Show the local reason for a recommendation.
5. Be honest about missing data and subjective quality.
6. Keep personal data local and the boundary visible.

## Accessibility and inclusion

- Full keyboard operation with visible focus.
- At least 44 px touch targets for primary controls.
- Reduced-motion support for all transitions and ambient effects.
- Normal text contrast of at least 4.5:1.
- No horizontal overflow at 320 px width or 200% zoom.
- Accessible names for icon controls; status and error messages announced to assistive technology.
- Clear language for import limits, storage behavior, and destructive actions.

## Success criteria

- A new user can import a valid catalog and reach a recommendation without a server.
- Invalid imports fail with an actionable message and do not replace existing local data silently.
- Recommendations respond to the request, kind, mood, and local preferences.
- Watched and dismissed state persists across reloads in the same origin.
- The app works offline after the static assets are available, apart from normal browser caching behavior.
- No release asset contains a real title, logo, external media file, credential, or private catalog.
