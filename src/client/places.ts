import { haversineM, type LatLng } from '../shared/game.ts';

export interface Place extends LatLng {
  name: string;
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const MAX_PLACES = 60;

/**
 * Public, open places where items may appear: stations, parks, squares, landmarks.
 * Using real places (instead of random points) keeps pins off highways, rivers and private land.
 */
export async function findItemPlaces(center: LatLng, radiusM: number, signal?: AbortSignal): Promise<Place[]> {
  const around = `(around:${Math.round(radiusM)},${center.lat},${center.lng})`;
  const query = `[out:json][timeout:20];
(
  node["railway"="station"]${around};
  node["leisure"="park"]["name"]${around};
  way["leisure"="park"]["name"]${around};
  node["place"="square"]${around};
  way["place"="square"]${around};
  node["tourism"~"attraction|viewpoint|artwork"]["name"]${around};
);
out center ${MAX_PLACES * 3};`;
  const res = await fetch(OVERPASS_URL, { method: 'POST', body: new URLSearchParams({ data: query }), signal });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const json = (await res.json()) as {
    elements: Array<{ lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }>;
  };
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const el of json.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat === undefined || lng === undefined) continue;
    const name = el.tags?.['name:ja'] ?? el.tags?.name ?? '';
    // One pin per named place (stations have several nodes), and keep pins at least 150 m apart.
    if (name && seen.has(name)) continue;
    if (places.some((p) => haversineM(p, { lat, lng }) < 150)) continue;
    if (haversineM(center, { lat, lng }) > radiusM) continue;
    if (name) seen.add(name);
    places.push({ lat, lng, name });
  }
  // Spread picks across the area instead of clustering near one busy spot.
  return shuffle(places).slice(0, MAX_PLACES);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
