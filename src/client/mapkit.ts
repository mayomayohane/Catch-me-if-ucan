// Loads Apple MapKit JS. Resolves to null (→ OpenStreetMap fallback) when no token is configured
// or the script cannot load, so the game keeps working without Apple credentials.
//
// Token sources, in order:
//  1. VITE_MAPKIT_TOKEN — a domain-restricted MapKit JS token created in the Apple Developer portal.
//  2. The `mapkit-token` Supabase Edge Function, which signs short-lived tokens with the
//     MAPKIT_TEAM_ID / MAPKIT_KEY_ID / MAPKIT_PRIVATE_KEY secrets.

const SCRIPT_URL = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.core.js';
const LOAD_TIMEOUT_MS = 10_000;
const STATIC_TOKEN = import.meta.env.VITE_MAPKIT_TOKEN as string | undefined;
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;

async function fetchToken(): Promise<string | null> {
  if (STATIC_TOKEN) return STATIC_TOKEN;
  if (!SUPABASE_URL) return null;
  try {
    // Plain GET (no custom headers → no CORS preflight). The function checks the page origin.
    const res = await fetch(`${SUPABASE_URL}/functions/v1/mapkit-token`);
    if (!res.ok) return null;
    const json = (await res.json()) as { token?: string };
    return json.token ?? null;
  } catch {
    return null;
  }
}

let loading: Promise<typeof mapkit | null> | null = null;
let failed = false;
const failListeners = new Set<() => void>();

/** True once MapKit reported an authorization/initialization error after loading. */
export const mapkitFailed = () => failed;
export function onMapKitFailure(l: () => void) {
  failListeners.add(l);
  return () => failListeners.delete(l);
}

export function loadMapKit(): Promise<typeof mapkit | null> {
  if (loading) return loading;
  loading = (async () => {
    // Probe for a token first, so we never load Apple's script when it can't be used.
    if (!(await fetchToken())) return null;
    return new Promise<typeof mapkit | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
      const w = window as unknown as Record<string, unknown>;
      w.__cmiuMapKitReady = () => {
        clearTimeout(timer);
        const mk = (window as unknown as { mapkit: typeof mapkit }).mapkit;
        mk.init({
          // Called again by MapKit whenever the token expires.
          authorizationCallback: (done) => void fetchToken().then((t) => t && done(t)),
          language: 'ja',
        });
        mk.addEventListener('error', () => {
          failed = true;
          failListeners.forEach((l) => l());
        });
        resolve(mk);
      };
      const s = document.createElement('script');
      s.src = SCRIPT_URL;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.dataset.callback = '__cmiuMapKitReady';
      s.dataset.libraries = 'map,annotations,overlays,services';
      s.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      document.head.appendChild(s);
    });
  })();
  return loading;
}
