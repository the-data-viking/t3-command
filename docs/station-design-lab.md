# Station spatial studies

Review at `/designlab.html`. This standalone Vite entry does not change the live map, send orders, or connect to environment data. All raster art comes from the existing Flight Deck kit and Night Shift palette; the source art files are unchanged.

## Research and directions (2026-10-11)

- [FTL: Faster Than Light](https://store.steampowered.com/app/212680/FTL_Faster_Than_Light/): crew-scale system interiors and compartmentalization inform the Night Vessel's continuous hull and system chambers. Subset's own site returned a security challenge; the Steam product page was available.
- [NASA ISS facts and figures](https://www.nasa.gov/international-space-station/space-station-facts-and-figures/): pressurized modules, major truss axis, and dedicated docking inform the Service Spine's modular wings and project-side docking.
- [Mini Metro](https://dinopoloclub.com/games/mini-metro/): explicit station/line relationships and growing network organization inform the Constellation's transit diagram. This is a spatial interpretation, not a borrowed asset or replicated game layout.

## Review interface

Six independent choices: map structure, room organization, connections, docking, information layer, and visual priority. Presets deliberately combine different choices. Pin A, change B, and inspect the same project in both. Expand the preview for a larger map; Escape closes it. Station interior enlarges the selected room plan. Responsive comparison stacks vertically below 900px.

Configuration is reflected in the URL and restored on load. Saved studies and notes use browser-local storage. Copy mix link includes choices only; Export feedback downloads JSON with current choices, project, notes, and saved studies. No feedback is transmitted automatically. Four fictional project statuses and fourteen crew provide a stable comparison fixture. Corridors and doors are visual concepts, not validated routes or capacity models.

## Validation

Production build and ESLint pass. Native T3 browser checked all 16 individual option values for URL updates and valid rendered geometry, plus preset changes, A/B pinning, selected interiors, URL restoration, local study save, feedback download, expanded preview, and 390px mobile layout without horizontal overflow.

Deploy the built `designlab.html` and hashed `dist/assets` into the existing Tailscale-served checkout. Retain existing hashed assets; leave the live `index.html` and `styleboard.html` unchanged. Sources are retained on `explore/station-design-lab` for a later selected implementation.
