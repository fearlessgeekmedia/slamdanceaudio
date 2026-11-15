# Slamdance Audio — Themes

A theme is **one CSS file in its own folder**. There is no theme JavaScript, no build step, no
webfont and no network request. The file is scoped to
`html[data-theme="<id>"]` and may set the standard variables and any other CSS
the app's markup allows — layout, texture, pseudo-elements, animation, whatever
the theme needs. Each theme can look and behave completely differently.

`styles.css` is only the base layout. Everything visual that makes a skin
belong to a genre lives in its theme file.

---

## Where themes live

```
themes/
  manifest.js      the index: id, display name, layout, file
  pit/
    pit.css
  punk/
    punk.css
  ska/
    ska.css
  ska-dark/
    ska-dark.css
  zine/
    zine.css
  terminal/
    terminal.css   not registered — add a manifest line to show it
```

Extra theme assets stay in the same folder and are referenced relative to the
CSS file.

`themes/manifest.js` is data only:

```js
window.SD_THEME_MANIFEST = [
  { id: 'pit',  name: 'Mosh Pit',  layout: 'classic', file: 'themes/pit/pit.css' },
  { id: 'punk', name: 'Punk Rock', layout: 'flyer',   file: 'themes/punk/punk.css', glyphs: 'ransom' },
  // …
];
```

At boot the engine adds one `<link rel="stylesheet">` per entry, sets
`data-theme` to the chosen id and `data-layout` to the entry's layout. That is
the whole mechanism.

---

## Add a theme

1. Make a folder for it and copy a house file, e.g. `themes/ska/ska.css`, to
   `themes/basement/basement.css`. Change the selector and the variables:

   ```css
   html[data-theme="basement"] {
     --bg: #12100e;
     --bg-2: #191612;
     --panel: #1f1b16;
     --panel-2: #2a251e;
     --ink: #f2ead9;
     --ink-dim: #b3a894;
     --ink-faint: #7d7464;
     --accent: #ff7a1a;
     --accent-2: #8bff6a;
     --on-accent: #14100c;
     --line: #3a332a;
     --line-strong: #5a5043;
     --shadow: 4px 4px 0 #000;
     --glow: 0 0 34px rgba(255, 122, 26, 0.35);
     --radius: 2px;
     --radius-chip: 999px;
     --panel-border: 2px;
     --head-track: 0.08em;
     --head-rot: 0deg;
     --head-skew: 0deg;
     --head-style: normal;
     --head-weight: 900;
     --head-case: uppercase;
     --font-display: "Arial Black", Impact, system-ui, sans-serif;
     --font-body: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
     --font-mono: ui-monospace, Menlo, Consolas, monospace;
     --figure-a: #ff7a1a;
     --figure-b: #8bff6a;
     --figure-c: #f2ead9;
     --figure-d: #7a6cff;
     --floor: #ff7a1a;
   }
   ```

2. Add its CSS after that block. Everything must be scoped to the id:

   ```css
   html[data-theme="basement"] .topbar { border-bottom: 6px solid var(--accent); }
   html[data-theme="basement"] .panel  { outline: 1px dashed var(--line-strong); }
   ```

3. Register it in `themes/manifest.js`:

   ```js
   { id: 'basement', name: 'Basement Show', layout: 'classic', file: 'themes/basement/basement.css' },
   ```

4. Reload `index.html`. It appears in the **Skin** menu. No other file needs
   touching, and no JavaScript is involved.

The id must be lowercase letters, digits and hyphens. Keep the id, the CSS
selector and the file entry in agreement. `layout` is optional; a theme can also
ignore the presets and place everything itself with CSS.

### Optional: cut-paper headings

Punk splits its headings into one span per character. That is opt-in metadata,
not theme JS:

```js
{ id: 'basement', …, glyphs: 'ransom' }
```

Use it only if the theme's CSS styles `.cut` spans; otherwise leave it out.

---

## The variables

`styles.css` defines a complete default set in `:root`, so a theme can override
only what it needs. House themes set all 31 so nothing leaks between skins.

| Variable | What it paints |
| --- | --- |
| `--bg` | App background, behind the pit canvas. |
| `--bg-2` | Recessed rows, drop zone, queue items. |
| `--panel` | Cards, hero, transport, table. |
| `--panel-2` | Inputs, buttons, current-row highlight, meter track. |
| `--ink` | Main text. |
| `--ink-dim` | Secondary text (artists, lede paragraphs). |
| `--ink-faint` | Mono labels, counts, hints. |
| `--accent` | Primary: playing, active nav, meters, play button. |
| `--accent-2` | Secondary: BPM/live values, focus rings, gradients. |
| `--on-accent` | Text that sits on `--accent` (needs contrast). |
| `--line` | Borders around muted elements. |
| `--line-strong` | Borders around panels, buttons, table heads. |
| `--shadow` | `box-shadow` for buttons and cards. Can be `none`. |
| `--glow` | `text-shadow` for the now-playing title, or `none`. |
| `--radius` | Corner radius (0–4 px looks best). |
| `--radius-chip` | Corner radius for chips/badges only (`999px` for pills). |
| `--panel-border` | Border width on cards, the hero and the live card (1–3 px). |
| `--head-track` | Letter spacing for titles and section heads. |
| `--head-rot` | Whole-heading rotation (`-1deg`). |
| `--head-skew` | Skew for headings (`-7deg`). |
| `--head-style` | `normal` or `italic`. |
| `--head-weight` | `700` or `900`. |
| `--head-case` | `uppercase` or `none`. |
| `--font-display` | Titles, buttons, big numbers. |
| `--font-body` | Body copy and forms. |
| `--font-mono` | Labels, times, BPM, table heads. |
| `--figure-a` … `--figure-d` | The four pixel-figure colours in Mosh Mode. |
| `--floor` | The pit floor line and dancefloor glow. |

### Rules of thumb

- **Contrast first.** The pit visualizer sits behind translucent panels. Keep
  `--ink` well separated from `--bg` and `--panel`.
- **`--on-accent` matters.** Dark accent → light text; bright accent → dark
  text. The Workshop calculates it.
- **No webfonts.** Themes must work offline with system fonts. The heavy stacks
  name Windows, macOS and Linux faces (`Impact`, `Arial Black`,
  `DejaVu Sans Condensed`, `Liberation Sans Narrow`), so check your own OS.
- **Texture belongs in the theme file.** Ska's checkerboard, Grunge's plaid and
  Punk's cut letters are scoped rules in those CSS files, not special cases in
  the app.
- **Pixel figures** need to read at 360×200. Four saturated, distinct colours
  work better than a tasteful palette.
- **Test both surfaces.** A skin that looks good empty can lose its text over a
  busy bogie.

---

## The house themes

| id | Name | Layout | Notes |
| --- | --- | --- | --- |
| `pit` | Mosh Pit | `classic` | Default. Black, safety orange, acid lime, hard offset shadows. |
| `punk` | Punk Rock | `flyer` | Xerox flyer: white wall of text, red accent, cut-paper headings, stitched patches. |
| `ska` | Ska — Light | `two-tone` | 2-Tone cream and black, checkerboard bands, red and gold, pill badges. |
| `ska-dark` | Ska — Dark | `two-tone` | The same 2-Tone checks after dark: black ground, cream type, gold and red. |
| `zine` | Photocopy Zine | `broadsheet` | Photocopied paper, hard black rules, typewriter, underlined heads. |

Each is editable on its own. Delete its folder and manifest line to remove a
skin; copy a folder to add another.

`themes/terminal/terminal.css` (Night Shift — terminal green, monospace,
scanlines) ships in the tree but has no manifest line, so it is not in the
**Skin** menu. Add
`{ id: 'terminal', name: 'Night Shift', layout: 'console', file: 'themes/terminal/terminal.css' }`
to `themes/manifest.js` to enable it.

---

## Layout presets

A layout is base CSS in `styles.css` keyed by `<html data-layout="…">`. Themes
choose one in the manifest, but can also override placement directly in their
own CSS. The presets are not required.

| Layout | Arrangement |
| --- | --- |
| `classic` | Top bar in one line, two-column hero. |
| `flyer` | Huge stacked masthead, nav on its own row, full-width hero. |
| `two-tone` | Centred brand, nav row beneath it, side cards side by side. |
| `hazard` | Dense two-deck bar, full-bleed panels. |
| `loose` | Wrapped, hand-placed masthead, stacked hero. |
| `broadsheet` | Centred nameplate, narrow measure. |
| `poster` | Centred gig-bill masthead and hero. |
| `console` | Compact console chrome, full-bleed panels. |

The shipped skins use `classic`, `flyer`, `two-tone` and `broadsheet`.
`hazard`, `loose`, `poster` and `console` stay available for new themes and
for skins built in the Workshop.

**Themes → Layout** switches the hero, live card, pit visualizer, film grain and
wide canvas on and off. They persist in `slamdance.v1 → settings.layout`. The
transport is never hidden. The classes are `hide-hero`, `hide-live`, `hide-pit`,
`hide-grain` and `wide` on `<html>`, so theme CSS can hook the same states.

---

## Skins made in the Workshop

The Workshop is a colour/type helper, not a separate theme system. Saving
generates a CSS rule for the chosen id and stores it in this browser, under
`slamdance.v1 → settings.customThemes`:

```json
{
  "id": "custom-mabc123",
  "name": "Basement Show",
  "layout": "classic",
  "vars": { "--bg": "#…", "…": "31 properties" },
  "css": "html[data-theme=\"custom-mabc123\"] { … }"
}
```

Those skins appear under “Your skins” and are applied exactly like house themes
— the stored CSS is injected as a `<style>` element scoped to the id. They are
not written to disk; clearing site data loses them.

**Show theme CSS** gives you the complete file. Save it as
`themes/<id>/<id>.css`, add the same id to `themes/manifest.js`, and it becomes
a permanent house theme. Custom workshop skins use the `classic` arrangement;
change `layout` or write placement rules in the file to do something else.

---

## Installing a theme in a packaged app

An AppImage or macOS `.app` keeps its resources inside the bundle, so the user
cannot add a theme folder to the bundle's `themes/` directory. The **Themes** panel therefore has **Import
.sdt** and **Import folder** buttons next to “Your skins”. Imported themes are
stored as CSS in the app's own settings, exactly like Workshop skins, so they
survive updates and never need write access to the bundle. The **Skin** menu
itself ends with **Import theme…**, which opens the `.sdt` picker; the folder
button stays in the Themes panel.

### The `.sdt` format

A `.sdt` is an ordinary zip file. The minimum is one CSS file; the recommended
layout is:

```
basement.sdt
  theme.json
  theme.css
  textures/floor.png
```

`theme.json` is optional but gives the menu a name and a layout:

```json
{
  "id": "basement",
  "name": "Basement Show",
  "layout": "classic",
  "glyphs": "ransom",
  "css": ["theme.css"],
  "vars": { "--accent": "#ff7a1a" }
}
```

- `id` is optional; without it the id is taken from the CSS selector.
- `layout` is optional and must be one of the presets below.
- `glyphs` is only `"ransom"` (Punk's heading splitter).
- `css` may be a string or an array; without it every `.css` file at the theme
  root is concatenated, with `theme.css` first.
- `vars` is optional; it is emitted as the first scoped block.

All CSS must be scoped to `html[data-theme="<id>"]`. Relative `url(...)` assets
are inlined as data URLs, so the theme survives in browser storage. `@import`
and remote URLs are removed — this player is offline-only. The imported theme
is capped at 2 MB of files (3 MB of final CSS); a theme with huge images will be
refused rather than filled into localStorage.

If the id collides with a built-in theme, the importer adds `-import` and
rewrites the selector, so importing a second `punk` cannot shadow the house
skin. Importing the same id again updates that imported theme.

### Folder import

The folder picker accepts the same `theme.json` + CSS + assets layout. A folder
with a single CSS file also works; the id comes from the selector and the name
from the filename. Use folder import only when the platform's webview supports
`webkitdirectory`; `.sdt` is the reliable path for packaged builds.

To make a `.sdt` from a theme made in the Workshop, press **Show theme CSS**,
save the file as `theme.css`, add a `theme.json`, and zip the two. The exported
selector already matches the id.

---

## Sharing

Send the theme folder (CSS plus any assets) and its manifest line. The recipient
drops the folder into `themes/`, adds the line, and reloads. No build, no
dependency, no import step.
