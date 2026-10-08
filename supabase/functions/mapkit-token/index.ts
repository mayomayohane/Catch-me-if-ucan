// Issues short-lived Apple MapKit JS tokens for the web app.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   MAPKIT_TEAM_ID      Apple Developer Team ID
//   MAPKIT_KEY_ID       Key ID of the MapKit JS private key
//   MAPKIT_PRIVATE_KEY  Contents of the downloaded .p8 file
//   MAPKIT_ORIGINS      Comma-separated allowed origins, e.g. https://example.com,http://localhost:5173
//
// Each token is bound to the requesting page's origin (the `origin` claim), and only origins in
// MAPKIT_ORIGINS get one. Without that allowlist the function refuses, so nobody else can use
// this project's Apple quota from their own site.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { SignJWT, importPKCS8 } from 'npm:jose@5.9.6';

const TEAM_ID = Deno.env.get('MAPKIT_TEAM_ID');
const KEY_ID = Deno.env.get('MAPKIT_KEY_ID');
const PRIVATE_KEY = Deno.env.get('MAPKIT_PRIVATE_KEY')?.replace(/\\n/g, '\n');
const ORIGINS = (Deno.env.get('MAPKIT_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN_TTL = '30m';

let keyPromise: Promise<CryptoKey> | null = null;

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  const allowed = ORIGINS.includes(origin);
  const cors = {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    Vary: 'Origin',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!TEAM_ID || !KEY_ID || !PRIVATE_KEY || !ORIGINS.length) return json({ error: 'MapKit is not configured' }, 503);
  if (!allowed) return json({ error: 'origin not allowed' }, 403);

  try {
    keyPromise ??= importPKCS8(PRIVATE_KEY, 'ES256');
    const token = await new SignJWT({ origin })
      .setProtectedHeader({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(TEAM_ID)
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL)
      .sign(await keyPromise);
    return json({ token });
  } catch (e) {
    keyPromise = null;
    console.error(e);
    return json({ error: 'failed to sign token' }, 500);
  }
});
