import { roomAt, route, type CrewLayout, type Point, type RoomKind, type StationLayout } from './layout';

export interface CrewDestination { room: RoomKind; point: Point }

/**
 * Initialization and reflow place crew immediately; live destination changes animate. A crew
 * member's own settle or wake also walks (bridge ↔ quarters) while the rooms stay put, but seat
 * reshuffles caused by other crew still snap, so a busy station never drifts.
 */
export class CrewMotion {
  pos: Point;
  room: RoomKind;
  facing = 1;
  moving = false;
  private path: Point[] = [];
  private goal = '';
  private placement = '';
  private needsPlacement = true;
  private geometry = '';
  private sleeping?: boolean;
  private lastLayout?: CrewLayout;
  private lastStation?: StationLayout;

  constructor(layout: CrewLayout) {
    this.pos = { ...layout.home };
    this.room = layout.homeRoom;
  }

  /** The first detailed thread snapshot supplies its existing activity, not a new journey. */
  hydrate() { this.needsPlacement = true; }

  /** Standing at the destination (as opposed to walking, or still to set off). */
  get arrived(): boolean { return this.path.length === 0 && !this.moving; }

  step(layout: CrewLayout, station: StationLayout, want: CrewDestination, dt: number, speed: number) {
    const cached = layout === this.lastLayout && station === this.lastStation;
    const geometry = cached ? this.geometry : JSON.stringify([layout.stationKey, Object.values(station.rooms).map(room => room?.rect)]);
    const placement = cached ? this.placement : JSON.stringify([geometry, layout.home, layout.homeRoom, layout.sleeping]);
    this.lastLayout = layout;
    this.lastStation = station;
    const goal = `${want.room}:${want.point.x}:${want.point.y}`;
    this.moving = false;
    const turnedIn = !this.needsPlacement && geometry === this.geometry && this.sleeping !== undefined && layout.sleeping !== this.sleeping;
    this.geometry = geometry;
    this.sleeping = layout.sleeping;
    if (turnedIn) this.placement = placement;
    if (this.needsPlacement || this.placement !== placement) {
      this.pos = { ...want.point };
      this.room = want.room;
      this.path = [];
      this.goal = goal;
      this.placement = placement;
      this.needsPlacement = false;
      return;
    }
    this.room = roomAt(station, this.pos, this.room);
    if (goal !== this.goal) {
      this.goal = goal;
      this.path = route(station, this.room, want.room, want.point, this.pos);
    }
    let budget = speed * dt;
    while (budget > 0 && this.path.length) {
      const next = this.path[0];
      const dx = next.x - this.pos.x;
      const dy = next.y - this.pos.y;
      const distance = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) this.facing = dx > 0 ? 1 : -1;
      if (distance <= budget) {
        this.pos = { ...next };
        this.path.shift();
        budget -= distance;
      } else {
        this.pos.x += dx / distance * budget;
        this.pos.y += dy / distance * budget;
        budget = 0;
      }
      this.moving ||= distance > 0;
    }
    this.room = roomAt(station, this.pos, this.room);
  }
}

/** Doors slide open as walking crew approach: fully within 18 px, half within 34 px. */
export function doorState(nearestWalker: number): 'closed' | 'half' | 'open' {
  return nearestWalker <= 18 ? 'open' : nearestWalker <= 34 ? 'half' : 'closed';
}
