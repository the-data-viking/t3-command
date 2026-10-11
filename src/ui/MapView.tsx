import { useEffect, useRef } from "react";
import { World, worldRef } from "../game/world";

export function MapView() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const world = new World(host.current!);
    worldRef.current = world;
    return () => {
      worldRef.current = null;
      world.destroy();
    };
  }, []);
  return <div className="map" ref={host} />;
}
