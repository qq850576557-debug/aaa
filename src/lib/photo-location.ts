import { z } from 'zod';
export const LOCATION_TTL = 90_000;
export const locationSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100000),
    obtainedAt: z.iso.datetime(),
  })
  .strict();
export type PhotoLocation = z.infer<typeof locationSchema>;
export type PlaceReceipt = {
  location: PhotoLocation;
  placeName: string;
  placeSource: string;
  nearby: boolean;
  poi?: { id: string; latitude: number; longitude: number };
  resolvedAt: string;
  expiresAt: string;
  token: string;
};
export function freshLocation(location: PhotoLocation | null, now = Date.now()) {
  if (!location) return false;
  const age = now - Date.parse(location.obtainedAt);
  return age >= -5000 && age <= LOCATION_TTL && location.accuracy <= 100;
}
/** Only reuse this session's verified place briefly; signed expiry and GPS lease still apply. */
export function freshPlace(place: PlaceReceipt | null, now = Date.now(), cacheMs = LOCATION_TTL) {
  return (
    !!place?.token &&
    !!place.placeName &&
    freshLocation(place.location, now) &&
    now <= Date.parse(place.expiresAt) &&
    now - Date.parse(place.location.obtainedAt) <= cacheMs
  );
}
/** Standard WGS84 -> GCJ02 transform, used only for the provider lookup, never replacing raw GPS. */
export function wgsToGcj(latitude: number, longitude: number) {
  if (longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271)
    return { latitude, longitude };
  const x = longitude - 105,
    y = latitude - 35,
    pi = Math.PI;
  let dlat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dlat += ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3;
  dlat += ((20 * Math.sin(y * pi) + 40 * Math.sin((y / 3) * pi)) * 2) / 3;
  dlat += ((160 * Math.sin((y / 12) * pi) + 320 * Math.sin((y * pi) / 30)) * 2) / 3;
  let dlng = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dlng += ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3;
  dlng += ((20 * Math.sin(x * pi) + 40 * Math.sin((x / 3) * pi)) * 2) / 3;
  dlng += ((150 * Math.sin((x / 12) * pi) + 300 * Math.sin((x / 30) * pi)) * 2) / 3;
  const rad = (latitude * pi) / 180,
    magic = 1 - 0.006693421622965943 * Math.sin(rad) ** 2,
    sqrt = Math.sqrt(magic);
  dlat = (dlat * 180) / (((6378245 * (1 - 0.006693421622965943)) / (magic * sqrt)) * pi);
  dlng = (dlng * 180) / ((6378245 / sqrt) * Math.cos(rad) * pi);
  return { latitude: latitude + dlat, longitude: longitude + dlng };
}
/** AOI center/distance is not a boundary proof: all names are explicitly nearby. */
export function nearbyPlace(raw: any): { name: string; source: string } | null {
  if (raw?.status !== '1') return null;
  const r = raw.regeocode;
  const aois = (Array.isArray(r?.aois) ? r.aois : [])
    .filter(
      (p: any) =>
        typeof p.name === 'string' &&
        p.name.trim().length &&
        p.name.length <= 80 &&
        /^(120[23])/.test(String(p.type)) &&
        p.distance !== '' &&
        Number.isFinite(Number(p.distance)) &&
        Number(p.distance) >= 0 &&
        Number(p.distance) <= 200,
    )
    .sort(
      (a: any, b: any) =>
        Number(!String(a.type).startsWith('1203')) - Number(!String(b.type).startsWith('1203')) ||
        Number(a.distance) - Number(b.distance),
    );
  if (aois[0]) return { name: aois[0].name.trim(), source: 'amap-regeo-aoi-nearby' };
  const n = r?.addressComponent?.neighborhood?.name;
  if (typeof n === 'string' && n.trim().length && n.length <= 80)
    return { name: n.trim(), source: 'amap-regeo-neighborhood-nearby' };
  return null;
}

export type NearbyPlace = {
  id: string;
  name: string;
  address: string;
  distance: number;
  receipt: PlaceReceipt;
};
export type NearbyResult = { places: NearbyPlace[]; more: boolean };
export function poiDistance(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const rad = Math.PI / 180,
    lat = (b.latitude - a.latitude) * rad,
    lng = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(lat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(lng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function nearbyPois(raw: any, origin: { latitude: number; longitude: number }) {
  const unique = new Map<
    string,
    {
      id: string;
      name: string;
      address: string;
      distance: number;
      latitude: number;
      longitude: number;
    }
  >();
  for (const p of Array.isArray(raw?.pois) ? raw.pois : []) {
    const [longitude, latitude] = String(p.location).split(',').map(Number);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180 ||
      typeof p.name !== 'string' ||
      !p.name.trim() ||
      p.name.length > 80 ||
      !p.id
    )
      continue;
    const distance = poiDistance(origin, { latitude, longitude });
    if (distance > 2000) continue;
    unique.set(String(p.id), {
      id: String(p.id),
      name: p.name.trim(),
      address: typeof p.address === 'string' ? p.address.slice(0, 240) : '',
      distance: Math.round(distance),
      latitude,
      longitude,
    });
  }
  return [...unique.values()].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
}

/** Selection provenance/radius policy; GPS and POI distance are not a building-boundary proof. */
export function nearbyMapPlace(place: PlaceReceipt | null) {
  if (!place || place.placeSource !== 'amap-poi-selected' || !place.poi?.id) return false;
  const p = place.poi;
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return false;
  return poiDistance(wgsToGcj(place.location.latitude, place.location.longitude), p) <= 2000;
}
