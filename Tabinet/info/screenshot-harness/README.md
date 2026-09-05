# Store screenshot harness

Regenerates `../screenshots/*.png` (1280×800, 24-bit PNG) for the Chrome Web
Store listing.

```powershell
powershell -ExecutionPolicy Bypass -File make-screenshots.ps1
```

Nothing here ships with the extension — `info/` is outside the packaged zip.

## How it works

The shots are the **real UI**: `src/sidepanel/*` and `src/manager/*` are copied
verbatim into a temp folder and rendered by headless Chrome. Only two things
are added around them:

| File | Role |
|---|---|
| `chrome-mock.js` | A minimal `chrome.*` stand-in (storage / tabs / tabGroups / windows / runtime) seeded with five sample groups, so the pages render populated instead of empty. Injected ahead of the page's own scripts. |
| `director.js` | Replays a click or two, driven by the iframe URL hash (`#expand=<group-id>&top=saved`), so a shot can show an expanded group. |
| `frame.html` | A neutral browser-window mock — tab strip, address bar, page area — with the side panel in an iframe on the right. A docked side panel is only legible next to a page; the frame is decorative, the panel is the product. |
| `fav/` | Favicons for the sample tabs (`tabinet.png` is copied from `icons/icon48.png` at run time). |

Dark shots use Chrome's `--force-dark-mode`, which flips
`prefers-color-scheme` — so they exercise the extension's own dark CSS rather
than any color filter.

## Sample data

Five groups (Work / Research / Reading list / Trip planning / Design refs) with
"Work" as the active workspace of window 1. Edit `GROUPS` in `chrome-mock.js` to
change what the shots show. The active tab is a Tabinet doc page rather than a
third-party site, so no shot renders a mock-up of someone else's product.

## Notes

- Chrome writes RGBA PNGs; the script redraws each onto a 24-bit surface
  because the store rejects screenshots with an alpha channel.
- If a shot's scroll position drifts after a UI change, adjust the offset in
  `director.js` (the target lands that many pixels below the panel's top).
