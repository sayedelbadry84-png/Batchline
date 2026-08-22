"use client";

import dynamic from "next/dynamic";

// `ssr: false` is only allowed inside a Client Component — this thin
// wrapper is what lets the (Server Component) Equipment page still use a
// map that can never safely render during SSR (Leaflet touches `window`
// at import time).
const FleetMap = dynamic(() => import("./FleetMap").then((mod) => mod.FleetMap), { ssr: false });

export { FleetMap };
export type { FleetMapTruck } from "./FleetMap";
