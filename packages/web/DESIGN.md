# Flight Recorder design system: "Instrument"

Flight Recorder is a tool you open after something happened, to see exactly what did. The UI should feel like a
calm, precise instrument: dense where data is dense, quiet everywhere else, and loud only about risk.

All tokens live in `src/index.css` (`@theme` for light, `.dark` for dark, which is the default). Components live in
`src/components/ui.tsx`, icons in `src/components/icons.tsx`, event-kind styling in `src/components/kinds.tsx`.

## Principles

1. **Risk is the only loud thing.** Colour is reserved for meaning: severity, additions and removals, the current
   position. Chrome stays neutral.
2. **Data in mono, words in sans.** Timestamps, commands, paths, token counts and money use Geist Mono with tabular
   figures, so columns line up and numbers can be compared at a glance.
3. **One accent.** Signal teal marks what you're looking at (selection, playhead, primary action, focus). Never use
   it to decorate.
4. **The brand colour stays in the logo.** International orange (`--color-brand`) is the colour of real flight
   recorders. It only appears in the logo mark and favicon, so it never competes with risk colours.
5. **Local and honest.** No web fonts from a CDN (Geist is bundled), no network calls, and every cost carries
   "estimated, API-equivalent".

## Colour

One cool graphite neutral family. Use the semantic token, never a raw hex or a Tailwind palette colour.

| Token | Use |
|---|---|
| `bg` | App background, behind lists and tables |
| `surface` | Header, panels, detail pane |
| `raised` | Hover fills, segmented-control track, chips |
| `sunken` | Code blocks, diffs, the session tape |
| `line` / `line-strong` | Dividers / control outlines |
| `fg` / `fg-2` / `muted` | Primary text / secondary text / labels and metadata |
| `accent`, `accent-soft`, `accent-fg` | Selection, playhead, primary button, focus ring |
| `ok`, `ok-soft` | Added lines, writes and edits |
| `risk-low` … `risk-critical` (+ `-soft`) | Severity, removed lines, errors |

Severity ramp: **low** slate blue, **medium** amber, **high** red, **critical** solid red with white text.
Chips use the `-soft` background with the full-strength text colour; stripes and dots use full strength.

## Type

- **Geist Variable** for interface text, **Geist Mono Variable** for data. Both are bundled via Fontsource.
- Scale: `2xs` 11/16 (labels, metadata), `xs` 12/18 (controls, tables), `sm` 13/20 (body, default),
  `base` 14/22 (stat values, session title), `lg` page titles, `2xl` the one hero number on Costs.
- Weights: 400 body, 500 labels and emphasis, 600 page titles. No bold-everything.
- Labels are sentence case, 11px, medium, `muted` (the `label` utility). No all-caps headers.
- Numbers: always add `num` (tabular figures), usually with `font-mono`.
- Long prose (messages, thinking) is capped at 72ch.

## Shape, depth, motion

- Radius: `chip` 4px (badges, kbd), `control` 6px (buttons, inputs, rows), `panel` 10px (cards).
- Depth comes from surface contrast and 1px lines. `shadow-panel` is barely there; `shadow-pop` is for overlays only.
- Motion: 100–150ms colour and transform transitions, `active:scale-[0.97]` on buttons, a 260ms `enter` fade-up
  for content that swaps in. Respect `prefers-reduced-motion` (handled globally).
- Focus: a 2px accent outline on `:focus-visible`, everywhere.

## Components

| Component | Notes |
|---|---|
| `Button` | `primary` (one per area at most), `secondary` (default), `ghost` (toolbars). 28px tall. Optional `icon`. |
| `TextInput`, `Select`, `DateInput` | Same 28px control height and ring style; `Select` has its own chevron. |
| `Segmented` | Mutually exclusive filters with 2–5 options (time range, severity). Prefer over a `Select` when options fit. |
| `Toggle` | On/off view options (show thinking, show injected messages). |
| `RiskBadge`, `RiskDot` | The only way to show severity. |
| `KindIcon` | 20px tinted square per event kind; prompts use the accent, writes and edits use `ok`. |
| `Stat` | Label, mono value, optional sub-line. Used in page and session headers. |
| `Panel`, `PanelHeader` | Grouped content on Costs and Risks. Don't nest panels. |
| `Toolbar` | Filter row under a page header. |
| `ShareBar` | Proportion bar inside breakdown rows. |
| `Loading`, `EmptyState`, `ErrorBox` | Skeleton rows while loading; a composed empty state with an icon and a next step; inline errors. |
| `Kbd` | Keyboard hints (`/`, `j`, `k`, `r`). |

## Patterns

- **Page header:** title, one-line description, key stats on the right.
- **Tables:** sticky header on `bg`, rows separated by `line/70`, hover to `surface`. Two-line rows when a record has
  a title plus metadata (sessions).
- **Session tape:** a strip of ticks above the timeline, one per event (bucketed past 480). Risks are coloured,
  prompts are taller, the playhead is the accent. Clicking a tick jumps there.
- **Icons:** the in-house 16px set in `icons.tsx`, 1.5px stroke. Add new icons there in the same style rather than
  pulling in an icon library.
