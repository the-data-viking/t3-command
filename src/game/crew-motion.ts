import { roomAt, route, type CrewLayout, type Point, type RoomKind, type StationLayout } from './layout';

export interface CrewDestination { room: RoomKind; point: Point }

/** Initialization/reflow places assets immediately; only live destination changes animate. */
export class CrewMotion {
  pos: Point;
  room: RoomKind;
  facing = 1;
  moving = false;
  private path: Point[] = [];
  private goal = '';
  private placement = '';
  private needsPlacement = true;
  private lastLayout?: CrewLayout;
  private lastStation?: StationLayout;

  constructor(layout: CrewLayout) {
    this.pos = { ...layout.home };
    this.room = layout.homeRoom;
  }

  /** The first detailed thread snapshot supplies its existing activity, not a new journey. */
  hydrate() { this.needsPlacement = true; }

  step(layout: CrewLayout, station: StationLayout, want: CrewDestination, dt: number, speed: number) {
    const placement = layout === this.lastLayout && station === this.lastStation ? this.placement : JSON.stringify([
      layout.stationKey, layout.home, layout.homeRoom, layout.sleeping,
      Object.values(station.rooms).map(room => room?.rect),
    ]);
    this.lastLayout = layout;
    this.lastStation = station;
    const goal = `${want.room}:${want.point.x}:${want.point.y}`;
    this.moving = false;
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
