// Removes rooms (and everything in them, including selfie files) that have had no
// activity for RETENTION_HOURS. Called hourly by pg_cron (see migrations/*_cleanup_schedule.sql).
//
// Calling it early is harmless: it only ever touches rooms already past retention,
// so it accepts the public anon JWT that the cron job sends.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import postgres from 'npm:postgres@3.4.5';

const RETENTION_HOURS = 24;
const BATCH_ROOMS = 200;
const BUCKET = 'drokei-photos';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1 });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

Deno.serve(async () => {
  try {
    // rooms.updated_at moves on every game action (private.notify), including the game ending.
    const rooms = await sql<{ code: string }[]>`
      select code from private.rooms
       where updated_at < now() - make_interval(hours => ${RETENTION_HOURS})
       order by updated_at
       limit ${BATCH_ROOMS}`;
    const codes = rooms.map((r) => r.code);
    if (!codes.length) return json({ rooms: 0, files: 0 });

    // Every file in a room lives under "<code>/", including reserved-but-unconfirmed uploads.
    const objects = await sql<{ name: string }[]>`
      select name from storage.objects
       where bucket_id = ${BUCKET} and split_part(name, '/', 1) = any(${codes})`;
    const paths = objects.map((o) => o.name);
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await admin.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      // Keep the rooms so the next run retries; deleting rows first would orphan the files.
      if (error) throw new Error(`storage remove failed: ${error.message}`);
    }

    // Players, tracks, photos and capture requests go with the room (on delete cascade).
    const deleted = await sql`delete from private.rooms where code = any(${codes})`;
    return json({ rooms: deleted.count, files: paths.length });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
