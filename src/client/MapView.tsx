import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import type { LatLng } from '../shared/game.ts';
import { loadMapKit, mapkitFailed, onMapKitFailure } from './mapkit.ts';

export type MarkerKind = 'me' | 'teammate' | 'alert' | 'photo' | 'center' | 'runner' | 'chaser' | 'footprint' | 'nearmiss' | 'item' | 'challenge' | 'sighting';

export interface MapMarker {
  id: string;
  pos: LatLng;
  kind: MarkerKind;
  label?: string;
  /** HTML shown in a popup when tapped. Must be pre-escaped. */
  popupHtml?: string;
}

export interface MapTrack {
  id: string;
  color: string;
  points: LatLng[];
  /** Faint dashed line, used for footprints. */
  faint?: boolean;
}

interface Props {
  area?: { center: LatLng; radiusM: number } | null;
  markers?: MapMarker[];
  tracks?: MapTrack[];
  onTap?: (pos: LatLng) => void;
  /** Re-fit the view whenever this value changes. */
  fitKey?: string;
  /** Fallback view when there is no area yet. */
  initialCenter?: LatLng | null;
  /** Move the view here whenever `focus.seq` changes (search result, "my location" button). */
  focus?: { pos: LatLng; seq: number } | null;
  className?: string;
}

const ICONS: Record<MarkerKind, string> = {
  me: '<div class="pin pin-me"></div>',
  teammate: '<div class="pin pin-team"></div>',
  runner: '<div class="pin pin-runner"></div>',
  chaser: '<div class="pin pin-chaser"></div>',
  alert: '<div class="pin pin-alert"><span>!</span></div>',
  photo: '<div class="pin pin-photo">📷</div>',
  center: '<div class="pin pin-center">📍</div>',
  footprint: '<div class="pin pin-footprint">👣</div>',
  nearmiss: '<div class="pin pin-nearmiss">⚡</div>',
  item: '<div class="pin pin-item">🎁</div>',
  challenge: '<div class="pin pin-challenge">🔥</div>',
  sighting: '<div class="pin pin-sighting">👀</div>',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const DEFAULT_VIEW: LatLng = { lat: 35.681236, lng: 139.767125 };
const AREA_STYLE = { color: '#ff3b3b', width: 3, fillOpacity: 0.06 };

type Area = { center: LatLng; radiusM: number } | null | undefined;

/** What MapView needs from a map library. Apple MapKit JS is preferred; Leaflet + OSM is the fallback. */
interface MapEngine {
  render(area: Area, markers: MapMarker[], tracks: MapTrack[]): void;
  fitArea(area: { center: LatLng; radiusM: number }): void;
  /** Center on a position, zooming in to street level if currently zoomed out. */
  focus(pos: LatLng): void;
  destroy(): void;
}

function pinHtml(mk: MapMarker): string {
  return ICONS[mk.kind] + (mk.label ? `<div class="pin-label">${escapeHtml(mk.label)}</div>` : '');
}

// ---- Apple MapKit JS --------------------------------------------------------

function createAppleEngine(mk: typeof mapkit, el: HTMLElement, start: LatLng, onTap: (p: LatLng) => void): MapEngine {
  const C = (p: LatLng) => new mk.Coordinate(p.lat, p.lng);
  const span = (latDelta: number, atLat: number) =>
    new mk.CoordinateSpan(latDelta, latDelta / Math.cos((atLat * Math.PI) / 180));
  const map = new mk.Map(el, {
    colorScheme: mk.Map.ColorSchemes.Dark,
    showsMapTypeControl: false,
    showsUserLocationControl: false,
    showsCompass: mk.FeatureVisibility.Hidden,
    isRotationEnabled: false,
    region: new mk.CoordinateRegion(C(start), span(0.03, start.lat)),
  });
  map.addEventListener('single-tap', (e) => {
    // MapKit passes the tap location as `pointOnPage` (missing from the type definitions).
    const point = (e as unknown as { pointOnPage: DOMPoint }).pointOnPage;
    const c = map.convertPointOnPageToCoordinate(point);
    onTap({ lat: c.latitude, lng: c.longitude });
  });

  return {
    render(area, markers, tracks) {
      map.removeOverlays(map.overlays);
      map.removeAnnotations(map.annotations);
      const overlays: mapkit.Overlay[] = [];
      if (area) {
        overlays.push(new mk.CircleOverlay(C(area.center), area.radiusM, {
          style: new mk.Style({
            strokeColor: AREA_STYLE.color,
            lineWidth: AREA_STYLE.width,
            fillColor: AREA_STYLE.color,
            fillOpacity: AREA_STYLE.fillOpacity,
          }),
        }));
      }
      for (const t of tracks) {
        if (t.points.length < 2) continue;
        overlays.push(new mk.PolylineOverlay(t.points.map(C), {
          style: new mk.Style(t.faint
            ? { strokeColor: t.color, lineWidth: 3, strokeOpacity: 0.45, lineDash: [2, 8], lineCap: 'round' }
            : { strokeColor: t.color, lineWidth: 4, strokeOpacity: 0.85 }),
        }));
      }
      map.addOverlays(overlays);
      map.addAnnotations(markers.map((m) => new mk.Annotation(
        C(m.pos),
        () => {
          const div = document.createElement('div');
          div.className = 'pin-wrap mk-pin';
          div.innerHTML = pinHtml(m);
          return div;
        },
        {
          size: { width: 28, height: 28 },
          // Default anchor is the element's bottom center; shift so the pin's center sits on the spot.
          anchorOffset: new DOMPoint(0, 14),
          // "Required": never hide pins to avoid collisions — every pin matters in this game.
          displayPriority: 1000,
          calloutEnabled: !!m.popupHtml,
          callout: m.popupHtml
            ? {
                calloutElementForAnnotation: () => {
                  const div = document.createElement('div');
                  div.className = 'mk-callout';
                  div.innerHTML = m.popupHtml!;
                  return div;
                },
              }
            : undefined,
        },
      )));
    },
    fitArea(area) {
      const latDelta = (area.radiusM * 2.3) / 111_320;
      map.setRegionAnimated(new mk.CoordinateRegion(C(area.center), span(latDelta, area.center.lat)), false);
    },
    focus(pos) {
      if (map.region.span.latitudeDelta > 0.03) map.setRegionAnimated(new mk.CoordinateRegion(C(pos), span(0.02, pos.lat)));
      else map.setCenterAnimated(C(pos));
    },
    destroy() {
      map.destroy();
    },
  };
}

// ---- Leaflet + OpenStreetMap (fallback) -----------------------------------

function createOsmEngine(el: HTMLElement, start: LatLng, onTap: (p: LatLng) => void): MapEngine {
  const m = L.map(el, { zoomControl: false, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(m);
  L.control.zoom({ position: 'bottomright' }).addTo(m);
  m.setView([start.lat, start.lng], 14);
  m.on('click', (e: L.LeafletMouseEvent) => onTap({ lat: e.latlng.lat, lng: e.latlng.lng }));
  const g = L.layerGroup().addTo(m);
  // Containers inside flex layouts often get their final size after mount.
  const ro = new ResizeObserver(() => m.invalidateSize());
  ro.observe(el);

  return {
    render(area, markers, tracks) {
      g.clearLayers();
      if (area) {
        L.circle([area.center.lat, area.center.lng], {
          radius: area.radiusM,
          color: AREA_STYLE.color,
          weight: AREA_STYLE.width,
          fillColor: AREA_STYLE.color,
          fillOpacity: AREA_STYLE.fillOpacity,
        }).addTo(g);
      }
      for (const t of tracks) {
        if (t.points.length < 2) continue;
        L.polyline(
          t.points.map((p) => [p.lat, p.lng] as [number, number]),
          t.faint
            ? { color: t.color, weight: 3, opacity: 0.45, dashArray: '2 8', lineCap: 'round' }
            : { color: t.color, weight: 4, opacity: 0.85 },
        ).addTo(g);
      }
      for (const mk of markers) {
        const icon = L.divIcon({ className: 'pin-wrap', html: pinHtml(mk), iconSize: [28, 28], iconAnchor: [14, 14] });
        const marker = L.marker([mk.pos.lat, mk.pos.lng], { icon, zIndexOffset: mk.kind === 'alert' ? 1000 : 0 }).addTo(g);
        if (mk.popupHtml) marker.bindPopup(mk.popupHtml, { maxWidth: 240 });
      }
    },
    fitArea(area) {
      m.fitBounds(L.latLng(area.center.lat, area.center.lng).toBounds(area.radiusM * 2), { padding: [16, 16] });
    },
    focus(pos) {
      m.setView([pos.lat, pos.lng], Math.max(m.getZoom(), 14));
    },
    destroy() {
      ro.disconnect();
      m.remove();
    },
  };
}

// ---- Component ---------------------------------------------------------------

export function MapView({ area, markers = [], tracks = [], onTap, fitKey, initialCenter, focus, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const engine = useRef<MapEngine | null>(null);
  const [kind, setKind] = useState<'loading' | 'apple' | 'osm'>('loading');
  const [ready, setReady] = useState(0);
  const tapRef = useRef(onTap);
  tapRef.current = onTap;
  const latest = useRef({ area, markers, tracks, initialCenter });
  latest.current = { area, markers, tracks, initialCenter };

  // Decide which map library to use (once per mount); switch to OSM if Apple rejects the token later.
  useEffect(() => {
    let alive = true;
    loadMapKit().then((mk) => alive && setKind(mk && !mapkitFailed() ? 'apple' : 'osm'));
    const off = onMapKitFailure(() => alive && setKind('osm'));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (kind === 'loading' || !el.current) return;
    const { area: a, initialCenter: c } = latest.current;
    const start = a?.center ?? c ?? DEFAULT_VIEW;
    const tap = (p: LatLng) => tapRef.current?.(p);
    const mk = (window as unknown as { mapkit?: typeof mapkit }).mapkit;
    const e = kind === 'apple' && mk ? createAppleEngine(mk, el.current, start, tap) : createOsmEngine(el.current, start, tap);
    engine.current = e;
    if (a) e.fitArea(a);
    setReady((n) => n + 1);
    return () => {
      e.destroy();
      engine.current = null;
    };
  }, [kind]);

  // Pan to the initial center once it becomes known (e.g. first GPS fix), if no area is set.
  const centeredOnce = useRef(false);
  useEffect(() => {
    if (!engine.current || centeredOnce.current || area || !initialCenter) return;
    centeredOnce.current = true;
    engine.current.focus(initialCenter);
  }, [initialCenter, area, ready]);

  useEffect(() => {
    engine.current?.render(area, markers, tracks);
  }, [area, markers, tracks, ready]);

  useEffect(() => {
    if (area && fitKey !== undefined) engine.current?.fitArea(area);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  useEffect(() => {
    if (focus) engine.current?.focus(focus.pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  return (
    <div className={`map ${className ?? ''}`}>
      <div ref={el} className="map-canvas" />
      {kind === 'loading' && <div className="map-loading">地図を読み込み中…</div>}
    </div>
  );
}
