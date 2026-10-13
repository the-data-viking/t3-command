// The live map, for UI code that needs to move the camera or ask it something. A separate module
// so the map's sprite modules can reach the World without an import cycle.

import type { World } from "./world";

export const worldRef: { current: World | null } = { current: null };
