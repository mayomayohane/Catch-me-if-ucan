import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { LatLng } from '../shared/game.ts';

export type MarkerKind = 'me' | 'teammate' | 'alert' | 'photo' | 'center' | 'runner' | 'chaser' | 'footprint' | 'nearmiss';

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
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const DEFAULT_VIEW: LatLng = { lat: 35.681236, lng: 139.767125 };

export function MapView({ area, markers = [], tracks = [], onTap, fitKey, initialCenter, focus, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const tapRef = useRef(onTap);
  tapRef.current = onTap;

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(m);
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    const start = initialCenter ?? DEFAULT_VIEW;
    m.setView([start.lat, start.lng], 14);
    m.on('click', (e: L.LeafletMouseEvent) => tapRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    // Containers inside flex layouts often get their final size after mount.
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current!);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pan to the initial center once it becomes known (e.g. first GPS fix), if no area is set.
  const centeredOnce = useRef(false);
  useEffect(() => {
    if (!map.current || centeredOnce.current || area || !initialCenter) return;
    centeredOnce.current = true;
    map.current.setView([initialCenter.lat, initialCenter.lng], 14);
  }, [initialCenter, area]);

  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    if (area) {
      L.circle([area.center.lat, area.center.lng], {
        radius: area.radiusM,
        color: '#ff3b3b',
        weight: 3,
        fillColor: '#ff3b3b',
        fillOpacity: 0.06,
      }).addTo(g);
    }
    for (const t of tracks) {
      if (t.points.length > 1) {
        L.polyline(
          t.points.map((p) => [p.lat, p.lng] as [number, number]),
          t.faint
            ? { color: t.color, weight: 3, opacity: 0.45, dashArray: '2 8', lineCap: 'round' }
            : { color: t.color, weight: 4, opacity: 0.85 },
        ).addTo(g);
      }
    }
    for (const mk of markers) {
      const icon = L.divIcon({
        className: 'pin-wrap',
        html: ICONS[mk.kind] + (mk.label ? `<div class="pin-label">${escapeHtml(mk.label)}</div>` : ''),
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const marker = L.marker([mk.pos.lat, mk.pos.lng], { icon, zIndexOffset: mk.kind === 'alert' ? 1000 : 0 }).addTo(g);
      if (mk.popupHtml) marker.bindPopup(mk.popupHtml, { maxWidth: 240 });
    }
  }, [area, markers, tracks]);

  useEffect(() => {
    const m = map.current;
    if (!m || fitKey === undefined) return;
    if (area) {
      m.fitBounds(L.latLng(area.center.lat, area.center.lng).toBounds(area.radiusM * 2), { padding: [16, 16] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  useEffect(() => {
    if (focus) map.current?.setView([focus.pos.lat, focus.pos.lng], Math.max(map.current.getZoom(), 14));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  return <div ref={el} className={`map ${className ?? ''}`} />;
}

