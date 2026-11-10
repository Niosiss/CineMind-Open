# Security policy

## Supported versions

The latest release on the default branch is supported. Older snapshots may not receive fixes.

## Scope

CineMind is a static client-side application. It has no server, account system, third-party integrations, telemetry, or server-side database. Security-relevant areas include:

- handling of imported JSON, catalog text, and poster paths;
- generated WebAssembly bindings and the Rust engine;
- dependency vulnerabilities in the frontend or engine;
- accidental inclusion of credentials, private catalogs, or user artwork in the repository.

## Reporting a vulnerability

Do not open a public issue for a security problem. Use the repository host's private security advisory or private vulnerability reporting feature and include:

- the affected version or commit;
- reproduction steps;
- the impact you observed;
- a suggested fix, if you have one.

If private reporting is unavailable, contact the maintainer through the repository's private contact channel. Do not include real credentials, personal catalogs, or private artwork in a report; use synthetic placeholders.

Reports are handled on a best-effort basis. Please allow time for a fix before public disclosure.

## Data and privacy

- Catalog data, preferences, and library state are stored in the browser's `localStorage` for the current origin.
- `localStorage` is not encrypted. Do not import secrets or sensitive personal data.
- The app does not upload catalogs or call a metadata provider at runtime.
- Clearing site data removes local state. Keep a separate copy of any catalog you need.

## Safe use

- Import only catalogs and artwork you have permission to use.
- Keep provider credentials in a separate script or private server you control, never in the browser or repository.
- Do not commit `.env` files, SQLite databases, private catalogs, or `frontend/public/local-assets/`.
- Verify the wasm-bindgen CLI version before building; mismatched bindings can cause runtime failures.
