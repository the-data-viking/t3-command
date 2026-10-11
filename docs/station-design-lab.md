# Station spatial studies

Review at `/designlab.html`. This standalone Vite entry does not change the live map, send orders, or connect to environment data. All raster art comes from the existing Flight Deck kit and Night Shift palette; the source art files are unchanged.

## Research and directions (2026-10-11)

- [FTL: Faster Than Light](https://store.steampowered.com/app/212680/FTL_Faster_Than_Light/): crew-scale system interiors and compartmentalization inform the Night Vessel's continuous hull and system chambers. Subset's own site returned a security challenge; the Steam product page was available.
- [NASA ISS facts and figures](https://www.nasa.gov/international-space-station/space-station-facts-and-figures/): pressurized modules, major truss axis, and dedicated docking inform the Service Spine's modular wings and attached utility modules.
- [Mini Metro](https://dinopoloclub.com/games/mini-metro/): explicit station/line relationships and growing network organization inform the Constellation's transit diagram. This is a spatial interpretation, not a borrowed asset or replicated game layout.

## Review interface

Seven independent choices: map structure, room organization, connections, module placement, information layer, visual priority, and utility node role. Presets deliberately combine different choices. Pin A, change B, and inspect the same project in both. Expand the preview for a larger map; Escape closes it. Station interior enlarges the selected room plan. Responsive comparison stacks vertically below 900px.

Configuration is reflected in the URL and restored on load. Saved studies and notes use browser-local storage. Copy mix link includes choices only; Export feedback downloads JSON with current choices, project, notes, and saved studies. No feedback is transmitted automatically. Four fictional project statuses and fourteen crew provide a stable comparison fixture. Corridors and doors are visual concepts, not validated routes or capacity models.

## Validation

Production build and ESLint pass. Native T3 browser checked all 16 original individual option values for URL updates and valid rendered geometry, plus preset changes, A/B pinning, selected interiors, URL restoration, local study save, feedback download, expanded preview, and 390px mobile layout without horizontal overflow.

Deploy the built `designlab.html` and hashed `dist/assets` into the existing Tailscale-served checkout. Retain existing hashed assets; leave the live `index.html` and `styleboard.html` unchanged. Sources are retained on `explore/station-design-lab` for a later selected implementation.

## Selected direction follow-up

The user selected orbit + central commons + network + attached modules + ambient information + all projects. This is now the default and Constellation preset. Ship silhouettes have been removed from this review page in favor of power, engine, or sleeping-quarters nodes. Power represents environment compute capacity; engine represents throughput; quarters represents parked crew. These are alternative metaphors for review, not live metrics. Attached modules have short solid conduits to the bottom of their station. Project-to-operations links leave the sides independently, avoiding a route through the utility node. Old six-axis URLs and saved studies acquire the power-module default. All three variants were checked for four rendered environment nodes and correct share URL updates; mobile layout still has no horizontal overflow. Original sprite files remain unchanged.

## StarNet-inspired integrated environment pass

The compact alternatives above are superseded by a full environment deck. Research: inspected [StarNet's live embedded starter station](https://starnetos.com/) visually and read [Station & capabilities](https://starnetos.com/docs/station.html). The observed station uses a substantial external hull, a traversable floor, and perimeter gear. The docs tie placed equipment to capabilities, bays to concurrency, and workstation visits to tool use. This pass adapts those spatial ideas, retaining our original FTL sprites and Night Shift palette rather than borrowing StarNet art.

Each attached facility combines an execution/storage plant, power/cooling/engine room, and crew habitat. All sections share a service corridor and visibly cut doorways. A reinforced chamfered hull and exterior ribs join the project deck and environment deck into one facility. Environment emphasis now highlights compute, engines, or quarters without removing the other sections. Integrated is the default. Old power/engine/quarters links remain valid emphasis choices. The enlarged interior includes the environment deck, and the orbital map has more vertical room for the larger facilities. Shared-service placement previews the selected project's environment in a central service deck.

This remains a review mock with fictional activity. It does not adopt StarNet's permission/build system or claim live capacity/throughput measurements.

Validation for this pass: build and lint pass; native browser checked all 12 map/emphasis combinations for four environments, all three sections retained, and valid SVG geometry. Enlarged facility view and 390px mobile layout checked; no horizontal overflow. Sprite source files are unchanged.

## Shipped project attachments

The selected orbital/commons design now drives the live Pixi map. Engineering facilities are separate nodes, attached directly to project modules with short orthogonal conduits. Each participating environment gets a node on each project it serves; shared repositories retain one common project interior and distinct environment nodes. Quarters and history stay in the project, with side doors into its central commons. Unassigned environments retain standalone service nodes. Environment navigation frames all associated projects and nodes; node clicks open the corresponding environment/project panel. Engine lights and packets derive only from that project/environment pair's real activity and connection state, not environment-wide totals or invented capacity metrics.

Validation: 24 tests pass, including door crossing samples on all generated room pairs, initial placement, a 108-crew commons, shared-environment attachments, overlap/bounds checks, GPU render-loop behavior, and thread image handling. Production build, ESLint, and diff whitespace checks pass. Native T3 browser verified real four-environment rendering, engineering-node selection, project archive selection, and environment navigation. Latest main's image relay and render-loop performance fixes are included. No sprite source files changed.
