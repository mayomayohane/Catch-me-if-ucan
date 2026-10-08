import { haversineM, type LatLng } from '../shared/game.ts';
import { loadMapKit, mapkitFailed } from './mapkit.ts';

export interface Place extends LatLng {
  name: string;
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const MAX_PLACES = 60;

export interface SearchResult {
  name: string;
  pos: LatLng;
}

/** Place search for the lobby: Apple Maps when available, otherwise OpenStreetMap (Nominatim). */
export async function searchPlaces(q: string, near?: LatLng | null): Promise<SearchResult[]> {
  const mk = await loadMapKit();
  if (mk && !mapkitFailed()) {
    try {
      return await new Promise<SearchResult[]>((resolve, reject) => {
        new mk.Search({ language: 'ja', ...(near ? { coordinate: new mk.Coordinate(near.lat, near.lng) } : {}) })
          .search(q, (err, data) => (err ? reject(err) : resolve(data.places.slice(0, 5).map((p) => ({
            name: [p.name, p.formattedAddress].filter(Boolean).join(' — '),
            pos: { lat: p.coordinate.latitude, lng: p.coordinate.longitude },
          })))));
      });
    } catch {
      /* fall through to OSM */
    }
  }
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=ja&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>;
  return rows.map((r) => ({ name: r.display_name, pos: { lat: Number(r.lat), lng: Number(r.lon) } }));
}

/** Apple Maps points of interest of the kinds that make good public meeting spots. */
async function applePlaces(center: LatLng, radiusM: number): Promise<Place[]> {
  const mk = await loadMapKit();
  if (!mk || mapkitFailed()) return [];
  const C = mk.PointOfInterestCategory;
  return new Promise<Place[]>((resolve) => {
    const search = new mk.PointsOfInterestSearch({
      center: new mk.Coordinate(center.lat, center.lng),
      radius: radiusM,
      language: 'ja',
      pointOfInterestFilter: mk.PointOfInterestFilter.including([C.Park, C.PublicTransport, C.Museum, C.Library, C.Stadium, C.Zoo]),
    });
    search.search((err, data) => resolve(err ? [] : data.places.map((p) => ({
      lat: p.coordinate.latitude,
      lng: p.coordinate.longitude,
      name: p.name,
    }))));
  });
}

/**
 * Public, open places where items may appear: stations, parks, squares, landmarks.
 * Using real places (instead of random points) keeps pins off highways, rivers and private land.
 * Combines Apple Maps (when configured) with OpenStreetMap so either source alone is enough.
 */
export async function findItemPlaces(center: LatLng, radiusM: number, signal?: AbortSignal): Promise<Place[]> {
  const [apple, osm] = await Promise.all([
    applePlaces(center, radiusM).catch(() => [] as Place[]),
    osmPlaces(center, radiusM, signal).catch((e) => {
      if (signal?.aborted) throw e;
      return [] as Place[];
    }),
  ]);
  const merged: Place[] = [];
  for (const p of [...apple, ...osm]) {
    if (haversineM(center, p) > radiusM) continue;
    // Keep pins at least 150 m apart (stations and parks often come with several points).
    if (merged.some((q) => haversineM(q, p) < 150)) continue;
    merged.push(p);
  }
  if (!merged.length && !apple.length && !osm.length) throw new Error('no place source available');
  return shuffle(merged).slice(0, MAX_PLACES);
}

async function osmPlaces(center: LatLng, radiusM: number, signal?: AbortSignal): Promise<Place[]> {
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
  return places;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
