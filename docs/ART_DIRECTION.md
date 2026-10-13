# Art direction

The map is a working spacecraft interior: compact crew silhouettes, readable equipment,
and a restrained material palette. Environment identity belongs on suit patches and ship
stripes. Activity belongs on screens and status badges.

## Pass 02: Living aboard

Bridge rooms use cool alloy decking; quarters use warmer acoustic panels; systems and
archives keep the neutral utility deck. Material changes should make a station easier to
read without competing with crew, labels, or attention badges.

This pass keeps all three candidate palettes available for review. Kestrel is the warm,
utilitarian option; Night Shift is darker and industrial; Pastel Ops is the softer option.
No final palette choice has been made for this pass.

## Review

`/styleboard.html` is included in the production build and uses the same sprite grids and
palettes as the map. Its scene is an illustrative fixture, not live telemetry.

- Compare the crew against bridge and quarters decking at 2× (the map's base scale).
- Check silhouettes and badge shapes at 1×, then pause to inspect edges at 3×.
- Compare the palettes with the same scene and inspect the fixture contact sheets.
- Use **Save scene PNG** to export the current frame at native sprite resolution.
- On the live map, check readability while zoomed out and while switching art styles.

## Constraints

- Keep nearest-neighbor rendering and the existing sprite dimensions.
- Status colors and badge shapes keep their meanings across palettes.
- Decorative material colors must not imply active work, failure, or approvals.
- Provider silhouette, model tier, and environment color remain independent layers.
- New art must preserve the map's rules: movement, exhaust, and activity lights follow
  observed T3 state.

## Pass 03: Signal Workshop (concept)

The requested direction is a more distinctive visual identity. Signal Workshop imagines
an orbital repair atelier with four material families: ceramic ivory hull panels, exposed
copper services, ink-blue working decks, and canvas-colored quarters. Crisp single-pixel
edges remain, with less emphasis on the oversized space helmet.

Shape motifs:

- Offset ceramic cargo pods around a tug's copper service spine; a blunt cockpit and aerial.
- External service pipes held by ceramic clamps, plus copper recesses along the hull.
- A small monitor beside an analog dial, rather than a single wide console strip.
- Drawer banks and bench terminals with visible legs and separate material surfaces.
- Compact goggled headgear, dark workwear, tool belts, and independent crew team patches.

Review at `/styleboard.html?palette=signal`. This is a concept kit in `src/art/signal.ts`;
its new geometry is not yet used by the live map. The board includes a scene, fixture
contact sheets and all eight provider/tier crew variants. Walking and typing still use
independent layers. Existing status badge shapes and activity colors remain recognizable.

If this direction is selected, carry its shape language into the live hull renderer, ship
layout dimensions, fixture placement, texture selection and HUD framing together. The tug
is taller than the current live ship, so integration must include layout changes rather
than only replacing its texture.

## Pass 04: Flight Deck (concept)

User feedback asks for a stronger FTL influence in both crew and workstation design.
Flight Deck restores warm, restrained ship plating and puts the visual emphasis on
compact suited crew operating broad inset consoles.

- Smaller rounded/angular headgear above a broader suit torso; shoulder patches carry team identity.
- Heavy crew retain wide shoulder armor and a larger pack; scouts stay narrow; inspectors carry scanners.
- Wraparound console wings frame a recessed operator position, with the screen along the far edge.
- Terminal and comms use the same workstation construction, with text and radar displays respectively.
- File storage uses paired vertical rack banks so it remains recognizable with the screen off.

Review at `/styleboard.html?palette=flightdeck`. Signal Workshop remains available as a
comparison. Flight Deck is an original pixel kit in `src/art/flightdeck.ts`, currently
used only by the concept board. Live-map integration will need fixture offsets updated
for its broader stations and operator position.

Flight Deck can also be reviewed in Night Shift's exact palette at
`/styleboard.html?palette=flightdeck-nightshift`. Geometry and crew proportions are
identical to Flight Deck; only material colors change.

## Shipped direction

Flight Deck in Night Shift is the live map default. Warm Flight Deck remains available
through the palette toggle; earlier saved palette preferences migrate to the corresponding
Flight Deck palette. The live renderer uses the new layered crew and system fixtures, with
console offsets adjusted to frame the operator. Signal Workshop remains a review study.

The thread panel renders Markdown links and bare URLs, keeps code blocks literal, and
supports pointer and keyboard width adjustment with a saved per-browser width.

## HUD theme tokens

The HUD follows the map style. `src/game/theme.ts` is the single source of HUD colors.
`hudTokens()` turns the active style's `hud` materials, plus the shared status, accent and
gauge colors, into CSS variables. They are set on `<html>` before the first render and again
whenever the palette toggles. The stylesheet (`src/index.css`, one FTL chrome layer) derives
only translucent variants with `color-mix()`.

- Night Shift keeps its cool gray frames. Warm Flight Deck uses warm plating frames around
  charcoal wells.
- Materials change per style. Status colors, the one "done / healthy / selected" green and the
  gauge ramp never do.
- Context-left bars and host CPU/RAM meters use their own gauge ramp (green → amber → rose).
  A full context or a busy host never borrows the approval red or question yellow.
- Add a new style's chrome by giving it a `hud` block in `src/art/palettes.ts`. `theme.test.ts`
  fails if the stylesheet reads an undefined variable or redeclares a generated color.

## Engineering decks

Each environment's engineering node is the design lab's integrated environment deck, drawn as
one Flight Deck pixel sprite (`ENGINEERING_DECK` in `src/art/flightdeck.ts`). It keeps the node
footprint, docking hatch and status plate, so layout and routing are unchanged.

- **Compute bay:** two storage racks. Ten rack LEDs fill bottom-up with measured CPU load.
- **Engine bay:** a core with four cell windows, a coolant tank and cooling fins. Cells light
  for the environment's observed crew: pulsing cyan per working crew member, then steady
  violet per monitoring one. The coolant column fills with measured RAM used.
- **Engineering bay:** standing room on the right of the deck, with a wall terminal and tool
  board, for the machine's scratch crew (threads in T3's "No project"). Up to two awake scratch
  crew stand there; more show as "+N" above the tool board and still count in the core cells and
  plate pips. The bay sits in shadow until crewed; its terminal glows cyan while one works and
  violet while they only monitor. Settled scratch threads stay off the map (host panel roster).
- **Readouts and caption:** CPU and RAM readouts sit on dark strips that stay legible on both
  decks. The plate keeps the connection light and crew-state pips. A caption appears only
  when samples are stale or unavailable.
- **Materials only:** the sprite uses palette materials plus the environment stripe. Every
  light is an overlay drawn from telemetry, so a quiet or disconnected deck stays dark.
  `engineering-deck.test.ts` enforces the footprint, light sockets and the absence of baked-in
  status colors. Review the deck on the styleboard contact sheet.

## Living station

Motion and light follow observed state, and every effect settles, so an idle fleet still lets
the map sleep.

- **Lighting:** rooms nobody is using sit in shadow. A bridge is lit while its station has awake
  crew on a live connection. A system room is lit, with a soft screen glow from its fixture
  (violet for monitoring-only comms), while crew work there. Quarters and the archive stay dim.
  Crew render above the shadow.
- **Quarters:** a crew member's own settle or wake walks them between seat and bunk through the
  doors. They lie down only on arrival. Seat reshuffles caused by other crew, and any change to
  room geometry, still snap, so busy stations never drift (`crew-motion.ts`).
- **Doors:** doors slide half then fully open as walking crew come within 34 / 18 px, and close
  once they pass. A crew member standing still never holds a door open.
- **Beam-in:** a thread created in the last two minutes on an already-loaded station beams in at
  its seat in a teleporter column in its team color. Crew present when the map loads, or
  when a station first syncs, are simply placed.
- **Camera:** focus, fit and minimap clicks ease over 0.35 s, with zoom interpolated
  geometrically. Dragging, scrolling or minimap drags take over immediately. The first fit after
  loading snaps.
- **Reduced motion:** with `prefers-reduced-motion`, camera moves snap and the beam-in is
  skipped.

## Readability and accessibility

- **Pixel labels:** map text uses the 5×7 font in `src/art/pixelfont.ts`, drawn by `PixelText`
  from one glyph atlas with a baked one-pixel outline and tinted per label. When world scale
  would make a font pixel smaller than a screen pixel, labels hold exactly one screen pixel per
  font pixel. Titles then shorten with "…" to their facility's width (`fitText`). Small deck and
  bridge text hides at that point instead of turning into mush.
- **Status by shape:** `STATUS_GLYPHS` gives every state a 5×5 shape (▲ approval, ◆ question,
  ● working, ○ monitoring, ✓ report, ✕ failed, ▪ idle, — asleep). Minimap crew and
  engineering-deck plate pips draw these, so color-blind users never depend on red vs. orange vs.
  green.
- **Reduced motion:** the map freezes its animation clock. There's no blinking, pulsing, sleeper
  drift or packet flow, crew are placed instead of walking, and the render loop wakes only for
  real changes. Camera moves snap, the beam-in is skipped, and CSS animations and transitions
  are off.
- **Pixel HUD art:** crew portraits in the roster and crew panel are the crew member's map sprite
  (`CrewPortrait`). Emoji icons are replaced by pixel SVG icons in the current text color
  (`PixelIcon`).
