"use client";

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";

export type FleetMapTruck = {
  id: string;
  code: string;
  lastLat: number;
  lastLng: number;
  lastPingAt: string | null;
  driverName: string | null;
  status: string;
};

// A plain colored-dot DivIcon rather than Leaflet's default marker image —
// the default icon's asset path breaks under Next.js bundling (a known
// Leaflet/webpack issue) and this avoids needing to work around it.
function truckIcon(status: string) {
  const color = status === "ACTIVE" ? "#2f7a50" : status === "MAINTENANCE" ? "#b5790f" : "#59636d";
  return L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,.25)"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

export function FleetMap({
  trucks,
  neverPingedLabel,
  lastPingLabel,
}: {
  trucks: FleetMapTruck[];
  neverPingedLabel: string;
  lastPingLabel: (when: string) => string;
}) {
  if (trucks.length === 0) return null;

  const center: [number, number] = [trucks[0].lastLat, trucks[0].lastLng];

  return (
    <div className="h-80 w-full overflow-hidden rounded-xl border border-border">
      <MapContainer center={center} zoom={11} scrollWheelZoom={false} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {trucks.map((t) => (
          <Marker key={t.id} position={[t.lastLat, t.lastLng]} icon={truckIcon(t.status)}>
            <Popup>
              <div style={{ fontFamily: "monospace" }}>
                <strong>{t.code}</strong>
                {t.driverName && <div>{t.driverName}</div>}
                <div style={{ fontSize: "0.8em", color: "#666" }}>
                  {t.lastPingAt ? lastPingLabel(new Date(t.lastPingAt).toLocaleString()) : neverPingedLabel}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
