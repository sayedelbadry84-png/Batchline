// Great-circle distance between two lat/lng points, in meters — the one
// piece of math the geofenced-yard feature needs (see Plant.yardLat/
// yardLng/yardRadiusM in schema.prisma).
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// True only when the plant has actually configured a geofence (all three
// fields set) and the given position falls inside its radius.
export function isAtYard(
  plant: { yardLat: number | null; yardLng: number | null; yardRadiusM: number | null },
  lat: number,
  lng: number,
): boolean {
  if (plant.yardLat == null || plant.yardLng == null || plant.yardRadiusM == null) return false;
  return distanceMeters(plant.yardLat, plant.yardLng, lat, lng) <= plant.yardRadiusM;
}
