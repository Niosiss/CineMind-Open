# CineMind

CineMind is a local-first viewing decision aid for movies, series, and anime. It is a static browser application: React + TypeScript + Vite for the interface, and a Rust recommendation engine compiled to WebAssembly. There is no server, no account system, and no third-party integration at runtime.

You bring a catalog you have permission to use. CineMind keeps the imported catalog, profile, preferences, and watch history in the browser's `localStorage`. Nothing is uploaded.

## Release scope

- Static frontend with no server process and no cloud dependency.
- Rust recommendation engine in `engine/`, compiled to `wasm32-unknown-unknown`.
- Local catalog import through **Discover > Import catalog**.
- Local ranking, browsing, library state, and preferences.
- No bundled third-party metadata, artwork, logos, or credentials.
- No provider connectors, remote APIs, telemetry, analytics, or cloud sync.

## Architecture

| Layer | Implementation |
| --- | --- |
| Browser UI | React, TypeScript, Vite, plain CSS |
| Recommendation engine | Rust in `engine/`, crate name `cinemind-engine` |
| Engine target | `wasm32-unknown-unknown` |
| Bindings | wasm-bindgen CLI exactly `0.2.130`, `--target web` |
| Wasm artifact | `cinemind_engine.wasm` |
| Generated bindings | `frontend/src/generated/` |
| Persistence | browser `localStorage` |
| Server | none |

At runtime the browser loads the static bundle and the WebAssembly module from the same origin. The app does not call a backend, read a server database, or integrate with a third-party service.

## Prerequisites

- Node.js LTS and npm.
- Rust stable installed with `rustup`.
- The WebAssembly target for Rust.
- wasm-bindgen CLI exactly `0.2.130`.

Install the Rust pieces and frontend dependencies from the repository root:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
npm ci --prefix frontend
```

The wasm-bindgen CLI version must match the version expected by the engine crate. A different CLI version can produce bindings that fail at runtime.

## Build and run

The frontend package scripts are configured with pre-hooks: `npm run dev` and `npm run build` invoke the engine build helper first. You can also run the helper directly:

```bash
node frontend/scripts/build-engine.mjs
```

Then:

```bash
npm run dev --prefix frontend       # development server
npm run build --prefix frontend     # production build in frontend/dist
npm run preview --prefix frontend   # serve the production build locally
```

`frontend/dist` is a static site. Any static file server can host it, provided it serves `.wasm` files with an appropriate WebAssembly MIME type.

### Build helper

`frontend/scripts/build-engine.mjs` is a dependency-free Node script. It uses `child_process.spawnSync` with `shell: false` and resolves paths from `import.meta.url`, so it works from any current directory on Windows, macOS, and Linux.

The helper:

1. Checks that `engine/Cargo.toml` exists.
2. Confirms the wasm-bindgen CLI is exactly `0.2.130`.
3. Sets an explicit `CARGO_TARGET_DIR` to `engine/target` so the artifact path is deterministic, even if the shell has a different value.
4. Runs:

   ```text
   cargo build --locked --release --target wasm32-unknown-unknown --manifest-path engine/Cargo.toml
   ```

5. Verifies the built artifact at `engine/target/wasm32-unknown-unknown/release/cinemind_engine.wasm`.
6. Runs:

   ```text
   wasm-bindgen --target web --out-dir frontend/src/generated --out-name cinemind_engine <built wasm artifact>
   ```

If a command is missing or fails, the script prints the failing command and a short, actionable hint.

## Import a catalog

Open **Discover > Import catalog** and choose a UTF-8 JSON file. The file must be a JSON array.

Limits:

- Maximum file size: **2 MB**.
- Maximum entries: **2,000**.
- The whole file must be valid UTF-8 JSON.

Each entry uses this shape:

```json
[
  {
    "id": "sample-movie-01",
    "title": "Sample Movie One",
    "kind": "movie",
    "year": 2024,
    "genres": ["drama", "mystery"],
    "description": "A placeholder synopsis used only to demonstrate the import format.",
    "sourceUrl": "https://example.com/catalog/sample-movie-01",
    "posterUrl": "local-assets/sample-movie-01.png"
  }
]
```

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `id` | yes | string | Unique, stable identifier. |
| `title` | yes | string | Display title. |
| `kind` | yes | string | Exactly `movie`, `series`, or `anime`. |
| `year` | yes | integer | Release year. |
| `genres` | yes | string[] | One or more genre labels. |
| `description` | yes | string | Short local description. |
| `sourceUrl` | no | string | Optional source or attribution link. |
| `posterUrl` | no | string | Optional local artwork path. |

The example values are placeholders. Replace them with your own catalog data. Do not use real titles, logos, or artwork unless you have permission to do so.

If the import is rejected, correct the reported rows and import again. Keep the source file outside the repository so personal catalogs are not committed.

### Posters and local artwork

Use only artwork you have permission to use. Place poster files under `frontend/public/local-assets/` and set `posterUrl` to the matching path relative to the site root:

```text
frontend/public/local-assets/sample-movie-01.png
posterUrl: "local-assets/sample-movie-01.png"
```

The `local-assets/` directory is ignored by Git and is not populated by this release. If no poster is supplied, the interface uses a neutral placeholder. The app does not bundle, scrape, or hotlink third-party artwork.

## Bringing metadata from a source you control

CineMind does not ship provider-specific connectors, API keys, or credentials. If you have your own permitted access to metadata, keep that work outside this repository:

1. Fetch and normalize data in a separate script or private server that you control.
2. Keep provider credentials in that server's environment or secret store. Never put them in the browser, the catalog JSON, a screenshot, or a commit.
3. Map only the fields above into a UTF-8 JSON array.
4. Check the source's terms and your permissions for metadata and artwork before importing or publishing anything.
5. Import the generated file manually through **Discover > Import catalog**.

The app reads only the JSON array you import. It does not fetch the source, call provider endpoints, or upload your catalog. Do not add provider-specific connector code or credentials to this repository.

## Data, storage, and privacy

- Imported catalog data, profile text, preferences, and library state are stored in `localStorage` for the current browser origin.
- `localStorage` is origin-scoped. Development, preview, and deployed sites may use different origins and therefore different stores.
- Clearing site data removes the local catalog and history. Keep a separate copy of your JSON catalog if you need a backup.
- `localStorage` is not encrypted. Do not store secrets, credentials, or sensitive personal data in catalog fields.
- This release does not read, migrate, or write any server-side SQLite database from earlier versions. There is no server database connection.
- Private catalogs, local artwork, `.env` files, and database files should stay out of public forks. The provided `.gitignore` covers the common paths; verify your changes before publishing.

## Project layout

```text
engine/
  Cargo.toml
  Cargo.lock
  src/
frontend/
  scripts/
    build-engine.mjs
  src/
    generated/          # wasm-bindgen output, ignored
  public/
    local-assets/       # user-supplied artwork, ignored
  dist/                 # production build, ignored
```

## Troubleshooting

**`error: target 'wasm32-unknown-unknown' not found`**

```bash
rustup target add wasm32-unknown-unknown
```

**`wasm-bindgen` is missing**

```bash
cargo install wasm-bindgen-cli --version 0.2.130 --locked
```

**The helper reports a different wasm-bindgen version**

Remove the other CLI from your PATH or reinstall the exact version above. The engine and CLI versions must match.

**The expected `.wasm` file is not found**

Confirm that the crate still produces a library named `cinemind_engine` and that the build completed with `--release`. The helper uses `engine/target` explicitly; a `CARGO_TARGET_DIR` set elsewhere in your shell does not move the artifact.

**The production page loads without the engine**

Run `npm run build --prefix frontend` and serve `frontend/dist` with a static server that returns `application/wasm` for `.wasm` files.

**Data disappears after changing the URL or port**

`localStorage` is tied to the origin. Use the same scheme, host, and port, or re-import your catalog.

## Security and license

Report vulnerabilities according to [SECURITY.md](SECURITY.md). CineMind is released under the MIT License; see [LICENSE](LICENSE). Copyright 2026 Niosiss.
