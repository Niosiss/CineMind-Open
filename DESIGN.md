---
name: "CineMind — local-first viewing guide"
description: "Public release design direction for a static, browser-local recommendation interface."
colors:
  asphalt: "#0A101C"
  surface: "#142139"
  raised: "#1B2A45"
  text: "#F2F5FB"
  muted: "#BFCCE2"
  faint: "#93A5C4"
  accent: "#64E9D8"
  accent-ink: "#06231F"
  danger: "#FF7799"
typography:
  display:
    fontFamily: "ui-serif, Georgia, 'Times New Roman', serif"
    fontSize: "2rem"
    lineHeight: 1.2
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    lineHeight: 1.55
rounded:
  card: "12px"
  control: "10px"
  pill: "999px"
---

# CineMind design direction

CineMind is a compact, local-first viewing guide. The interface should feel like a calm decision tool, not a streaming service: content comes from the catalog the user imported, recommendations come from the local Rust engine, and no third-party media or widgets are loaded.

## Principles

1. **Help decide.** Every screen should make the next action clear: describe a mood, browse a catalog, open a title, or mark something watched.
2. **Let local content lead.** Posters, titles, and descriptions are user-supplied. The design must work with missing artwork and sparse metadata.
3. **Show the reason.** Recommendation cards explain why a title was suggested in plain local text. Do not invent match percentages or editorial claims.
4. **Keep the surface quiet.** No autoplay, no full-screen hero media, no logo walls, no external embeds.
5. **Be honest about missing data.** Omit unknown facts instead of filling gaps with placeholders that look real.

## Visual language

The palette is a night-navy surface with light text, an aqua action color, and coral for negative or destructive states. The accent is used for primary actions, selected navigation, and focus. Large areas stay neutral so user posters and catalog text remain the focus.

Typography uses a display serif for headings and a system sans-serif for interface text. Fonts are local or system-provided; the release does not request remote font files.

```css
--color-asphalt: #0a101c;
--color-surface: #142139;
--color-raised: #1b2a45;
--color-text: #f2f5fb;
--color-muted: #bfcce2;
--color-faint: #93a5c4;
--color-accent: #64e9d8;
--color-accent-ink: #06231f;
--color-danger: #ff7799;
```

Use a restrained CSS-only ambient background if the implementation supports it. Do not use photographic backdrops, video loops, or decorative film-strip imagery.

## Layout

- **Discover** is the root screen. It introduces the local catalog, shows the import entry point, and offers a direct path to recommendations.
- **Recommendations** contains a short request field, an optional kind filter (`movie`, `series`, `anime`), mood choices, and the result grid.
- **Library** lists saved, watched, and dismissed titles with filters and undo actions.
- **Profile** holds the user's free-text taste notes and optional genre preferences.
- **Detail** is an addressable view for one title: poster, title, year, kind, genres, description, optional source link, and local actions.

Desktop uses a compact top navigation. Mobile uses a simple top bar and a bottom navigation with three to four destinations. Content is centered with a readable maximum width; use 24 px gutters on wide screens, 20 px on tablets, and 16 px on phones. Do not add a decorative hero band that pushes the catalog below the fold.

## Components

### Recommendation card

- Poster at a 2:3 ratio, or a neutral placeholder when no local artwork exists.
- Title, year, kind, and genres.
- A short local reason for the recommendation.
- A primary **Watched** toggle and a secondary **Not interested** action.
- No oversized first result, no fake score, no external rating badge.
- Cards in a row share equal height. Actions align to the bottom.

Use a grid with a minimum column width around 320 px and a single column below that. At phone widths, the poster and text stack; actions remain full-width and at least 44 px tall.

### Detail view

The detail view repeats the card metadata and adds the full description and optional source link. Show only facts present in the imported catalog. Do not add cast, related titles, episode counts, or artwork that the user did not supply.

### Import dialog

The import entry point is explicit: **Discover > Import catalog**. The dialog should:

- Accept a UTF-8 JSON file and state the 2 MB and 2,000-entry limits before the file picker.
- Report structural errors in plain language and point to the affected entry.
- Explain that the catalog stays in this browser and is not uploaded.
- Link to the format documentation without loading any remote content.

### Empty and error states

- **No catalog:** explain how to import a JSON array and offer the import action.
- **No results:** suggest changing the request or mood; do not pad the grid with unrelated titles.
- **Missing poster:** use a neutral aspect-ratio placeholder with the title's initial or a simple mark.
- **Import error:** keep the dialog open, show the reason, and let the user choose another file.
- **Storage unavailable:** explain that browser storage is blocked and that the session will not persist.

## Motion

Motion is functional, not decorative.

- Page or view changes use a short opacity transition (around 180 ms).
- New result cards may fade in with a small vertical offset (around 200 ms), staggered lightly. Existing cards do not re-animate.
- Navigation indicators move between destinations with a single transform transition.
- Ambient background movement, if used, must be slow, CSS-only, and must not convey information.
- Respect `prefers-reduced-motion`: remove transforms, staggering, and ambient movement, and keep state changes instant.

No autoplaying video, parallax tied to scroll, or motion that blocks input.

## Accessibility

- All interactive controls are reachable and operable by keyboard.
- Focus is visible and uses a contrast-safe ring, not color alone.
- Touch targets are at least 44 × 44 px.
- Body text meets at least 4.5:1 contrast; large text meets at least 3:1.
- The layout has no horizontal overflow at 320 px width or at 200% zoom.
- Buttons have accessible names; icon-only controls include a label and a pressed state where relevant.
- Status messages, import errors, and undo confirmations are announced to assistive technology.
- Motion and color are never the only way to communicate state.

## Content and media rules

- Use placeholder values in examples and empty states. Do not ship real titles, series names, anime names, logos, or recognizable artwork without permission.
- The release contains no bundled posters, screenshots, or external media.
- Local artwork belongs in `frontend/public/local-assets/` and is supplied by the user. That directory is ignored by Git.
- The interface must not embed third-party players, social widgets, analytics scripts, or remote images.
- A `sourceUrl` is stored as a reference link. The interface does not fetch or preview it.

## Data states

The UI should make the local boundary visible without being noisy:

- Imported catalog: stored in `localStorage` for the current origin.
- Profile and preferences: local only.
- Library and watched state: local only.
- No server sync, account state, or cross-device merge.
- Clearing site data returns the app to its empty state.

The design must not imply that data is backed up or synchronized. If a destructive action clears local data, confirm it and explain the consequence.

## Responsive behavior

| Range | Behavior |
| --- | --- |
| Below 640 px | Single column, stacked cards, bottom navigation, 16 px gutters. |
| 640–959 px | Two-column grid where space allows, 20 px gutters. |
| 960 px and above | Top navigation, wider grid, 24 px gutters. |
| 1280 px and above | Content width caps for readable text; the grid may continue to fill available space. |

Test at 320 px width, 200% zoom, and with long titles and descriptions. Truncate only where a full value remains available in the detail view or through an accessible label.

## Quality checklist

- [ ] No real titles, logos, or external media in the release.
- [ ] Import path and limits are visible before the user selects a file.
- [ ] Missing posters and missing metadata look intentional.
- [ ] Recommendation reasons are plain language and local.
- [ ] Keyboard, focus, contrast, touch target, and reduced-motion checks pass.
- [ ] No horizontal overflow at 320 px or 200% zoom.
- [ ] The interface never implies a server, account, or cloud backup.
- [ ] Generated bindings and local artwork stay out of version control.
