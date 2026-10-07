-- リアル探してください: game backend on Supabase.
--
-- Design
--  * Raw game state lives in the `private` schema, which the Data API does not expose and
--    anon/authenticated cannot read. Clients only talk to SECURITY DEFINER RPCs in `public`.
--  * Every RPC re-validates the rules (roles, capacity, geofence, missions, captures), so the
--    database is the single authority, like the old Node server.
--  * get_room_view() returns a per-viewer JSON view: a runner's location is only included for
--    chasers while that runner is outside the area (or for teammates / after the game).
--  * Each mutation sends a Realtime broadcast "changed" on the public topic `room:<code>`.
--    The payload is empty; clients react by re-fetching their own filtered view.
--  * Players are identified by a random secret key generated on the device (only its hash is stored).
--  * Rows are never removed by game logic: leaving sets players.left_at and finished capture
--    requests get resolved_at. This keeps full game history (useful for replays and stats).

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists private.rooms (
  code text primary key,
  host_id uuid,
  phase text not null default 'lobby' check (phase in ('lobby', 'playing', 'finished')),
  team_mode text not null default '2v3' check (team_mode in ('1v4', '2v3', '3v2')),
  center_lat double precision,
  center_lng double precision,
  radius_m integer not null default 3000 check (radius_m between 500 and 10000),
  duration_min integer not null default 30 check (duration_min in (30, 45, 60)),
  photo_interval_s integer not null default 600 check (photo_interval_s between 10 and 600),
  started_at timestamptz,
  ends_at timestamptz,
  winner text check (winner in ('runner', 'chaser')),
  end_reason text,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists private.players (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references private.rooms (code) on delete cascade,
  key_hash text not null,
  name text not null,
  role text check (role in ('runner', 'chaser')),
  ready boolean not null default false,
  captured boolean not null default false,
  violation boolean not null default false,
  lat double precision,
  lng double precision,
  acc integer,
  pos_at timestamptz,
  joined_at timestamptz not null default clock_timestamp(),
  left_at timestamptz,
  unique (room_code, key_hash)
);
alter table private.players add column if not exists left_at timestamptz;

create table if not exists private.track_points (
  id bigint generated always as identity primary key,
  player_id uuid not null references private.players (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  t timestamptz not null
);
create index if not exists track_points_player_t on private.track_points (player_id, t);

create table if not exists private.photos (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references private.rooms (code) on delete cascade,
  player_id uuid not null references private.players (id) on delete cascade,
  mission integer not null,
  path text not null unique,
  uploaded boolean not null default false,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now(),
  unique (player_id, mission)
);
create index if not exists photos_room on private.photos (room_code);

create table if not exists private.capture_requests (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references private.rooms (code) on delete cascade,
  chaser_id uuid not null references private.players (id) on delete cascade,
  runner_id uuid not null references private.players (id) on delete cascade,
  expires_at timestamptz not null,
  distance_m integer,
  resolved_at timestamptz,
  unique (chaser_id, runner_id)
);
alter table private.capture_requests add column if not exists resolved_at timestamptz;
create index if not exists capture_requests_room on private.capture_requests (room_code);
create index if not exists capture_requests_runner on private.capture_requests (runner_id);

-- Defense in depth: even if the schema were ever exposed, nothing is readable.
alter table private.rooms enable row level security;
alter table private.players enable row level security;
alter table private.track_points enable row level security;
alter table private.photos enable row level security;
alter table private.capture_requests enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function private.ms(t timestamptz) returns bigint
language sql immutable strict set search_path = '' as $$
  select (extract(epoch from t) * 1000)::bigint
$$;

create or replace function private.hash_key(p_key text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or length(p_key) < 16 or length(p_key) > 128 then
    raise exception '不正なクライアントです';
  end if;
  return encode(extensions.digest(p_key, 'sha256'), 'hex');
end $$;

create or replace function private.clean_name(p_name text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(left(btrim(coalesce(p_name, '')), 16), ''), 'プレイヤー')
$$;

-- Great-circle distance in meters (Haversine). Mirrors src/shared/game.ts.
create or replace function private.haversine_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable strict set search_path = '' as $$
  select 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )))
$$;

create or replace function private.valid_latlng(lat double precision, lng double precision) returns boolean
language sql immutable set search_path = '' as $$
  select lat is not null and lng is not null and lat between -90 and 90 and lng between -180 and 180
    and lat <> 'NaN'::float8 and lng <> 'NaN'::float8
$$;

-- Number of selfie missions due at `at`: mission n is due at started_at + n*interval, if before ends_at.
create or replace function private.missions_due(r private.rooms, at timestamptz) returns integer
language sql stable set search_path = '' as $$
  select case when r.started_at is null then 0 else greatest(0, least(
    floor(extract(epoch from (at - r.started_at)) / r.photo_interval_s),
    ceil(extract(epoch from (r.ends_at - r.started_at)) / r.photo_interval_s) - 1
  ))::integer end
$$;

create or replace function private.notify(p_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.rooms set updated_at = now() where code = p_code;
  perform realtime.send('{}'::jsonb, 'changed', 'room:' || p_code, false);
end $$;

create or replace function private.finish(p_code text, p_winner text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.rooms
     set phase = 'finished', winner = p_winner, end_reason = p_reason, ended_at = now()
   where code = p_code and phase = 'playing';
  update private.players set violation = false where room_code = p_code;
  update private.capture_requests set resolved_at = now() where room_code = p_code and resolved_at is null;
end $$;

-- Ends the game when time is up. Safe to call any time.
create or replace function private.tick(p_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from private.rooms where code = p_code and phase = 'playing' and ends_at <= now()) then
    perform private.finish(p_code, 'runner', 'time_up');
    perform private.notify(p_code);
  end if;
end $$;

-- Locks the room, applies time-based transitions, and resolves the calling player.
create or replace function private.me(p_code text, p_key text) returns private.players
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
begin
  perform 1 from private.rooms where code = p_code for update;
  if not found then raise exception 'ルームが見つかりません'; end if;
  perform private.tick(p_code);
  select * into p from private.players where room_code = p_code and key_hash = private.hash_key(p_key) and left_at is null;
  if not found then raise exception 'ルームに参加していません'; end if;
  return p;
end $$;

create or replace function private.refresh_violation(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.players p
     set violation = (
       r.phase = 'playing' and p.role = 'runner' and not p.captured
       and p.lat is not null and r.center_lat is not null
       and private.haversine_m(p.lat, p.lng, r.center_lat, r.center_lng) > r.radius_m
     )
    from private.rooms r
   where p.id = p_id and r.code = p.room_code;
end $$;

-- Per-viewer view. Shape matches RoomView in src/shared/protocol.ts.
create or replace function private.view(p_code text, p_viewer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r private.rooms;
  v private.players;
  due integer := 0;
  nxt timestamptz;
  pending jsonb := '[]'::jsonb;
begin
  select * into r from private.rooms where code = p_code;
  select * into v from private.players where id = p_viewer;
  if r.phase = 'playing' then
    due := private.missions_due(r, now());
    nxt := r.started_at + make_interval(secs => (due + 1) * r.photo_interval_s);
    if nxt >= r.ends_at then nxt := null; end if;
    if v.role = 'runner' and not v.captured then
      select coalesce(jsonb_agg(m order by m), '[]'::jsonb) into pending
        from generate_series(1, due) m
       where not exists (
         select 1 from private.photos ph where ph.player_id = v.id and ph.mission = m and ph.uploaded
       );
    end if;
  end if;

  return jsonb_build_object(
    'code', r.code,
    'phase', r.phase,
    'settings', jsonb_build_object(
      'teamMode', r.team_mode,
      'center', case when r.center_lat is null then null
                     else jsonb_build_object('lat', r.center_lat, 'lng', r.center_lng) end,
      'radiusM', r.radius_m,
      'durationMin', r.duration_min
    ),
    'players', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', p.id, 'name', p.name, 'role', p.role, 'ready', p.ready,
          'connected', true, 'isHost', p.id = r.host_id,
          'captured', p.captured, 'violation', p.violation
        ) || case
          when p.lat is not null and (
            p.id = v.id
            or r.phase = 'finished'
            or (r.phase = 'playing' and (
                 (v.role is not null and v.role = p.role)
                 or (v.role = 'chaser' and p.role = 'runner' and p.violation)))
          ) then jsonb_build_object('pos', jsonb_build_object(
                 'lat', p.lat, 'lng', p.lng, 't', private.ms(p.pos_at), 'acc', p.acc))
          else '{}'::jsonb end
        order by p.joined_at), '[]'::jsonb)
      from private.players p where p.room_code = r.code and p.left_at is null
    ),
    'meId', v.id,
    'startedAt', private.ms(r.started_at),
    'endsAt', private.ms(r.ends_at),
    'nextMissionAt', private.ms(nxt),
    'myPendingMissions', pending,
    'photos', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', ph.id, 'playerId', ph.player_id, 'playerName', p.name, 'path', ph.path,
        'pos', case when ph.lat is null then null else jsonb_build_object('lat', ph.lat, 'lng', ph.lng) end,
        't', private.ms(ph.created_at), 'mission', ph.mission
      ) order by ph.created_at), '[]'::jsonb)
      from private.photos ph join private.players p on p.id = ph.player_id
      where ph.room_code = r.code and ph.uploaded
    ),
    'captureRequests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'chaserId', c.chaser_id, 'runnerId', c.runner_id,
        'expiresAt', private.ms(c.expires_at), 'distanceM', c.distance_m
      )), '[]'::jsonb)
      from private.capture_requests c
      where c.room_code = r.code and c.resolved_at is null and c.expires_at > now() and r.phase = 'playing'
        and (c.runner_id = v.id or c.chaser_id = v.id or v.role = 'chaser')
    ),
    'result', case when r.phase <> 'finished' then null else jsonb_build_object(
      'winner', r.winner,
      'reason', r.end_reason,
      'endedAt', private.ms(r.ended_at),
      'tracks', (
        select coalesce(jsonb_object_agg(p.id, (
          select coalesce(jsonb_agg(jsonb_build_array(t.lat, t.lng, private.ms(t.t)) order by t.t), '[]'::jsonb)
          from private.track_points t where t.player_id = p.id
        )), '{}'::jsonb)
        from private.players p where p.room_code = r.code and p.left_at is null
      )
    ) end
  );
end $$;

create or replace function private.respond(p_code text, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('room', private.view(p_code, p_viewer), 'serverNow', private.ms(now()))
$$;

