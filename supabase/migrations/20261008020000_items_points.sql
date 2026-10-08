-- Phase 2: map items, high-risk challenge spot, and points.
--
--  * Before the game the host's device sends candidate spots (parks, stations, squares...)
--    found near the area: set_spots(). Random map points are never used, for safety.
--  * start_game picks the most central candidate as the 🔥 challenge spot and up to 6 random
--    others as item spots.
--  * Walking within 40 m of an item spot lets a player pick it up (pickup_item):
--      runner  -> 'invisible' (skip the next selfie mission) or 'decoy' (fake sighting pin, 5 min)
--      chaser  -> 'radar' (pins every active runner's current position for 10 s)
--  * Chasers see radar hits and decoys identically as "目撃情報" sightings.
--  * A runner who uploads a selfie within 40 m of the challenge spot (mission 0) gets ×3 on
--    the escape bonus. The photo is shared with chasers like any hint — that is the risk.
--  * Points are computed when the game ends (see private.view → result.scores):
--      runner: 1/min survived + 5 per selfie + 30 escape bonus (×3 with the challenge)
--      chaser: 50 per capture + 20 if the chasers win

alter table private.rooms add column if not exists spot_candidates jsonb not null default '[]'::jsonb;
alter table private.players add column if not exists captured_at timestamptz;
alter table private.players add column if not exists captured_by uuid references private.players (id) on delete set null;

create table if not exists private.spots (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references private.rooms (code) on delete cascade,
  kind text not null check (kind in ('item', 'challenge')),
  lat double precision not null,
  lng double precision not null,
  name text not null default '',
  taken_by uuid references private.players (id) on delete cascade,
  taken_at timestamptz
);
create index if not exists spots_room on private.spots (room_code);

create table if not exists private.items (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references private.rooms (code) on delete cascade,
  player_id uuid not null references private.players (id) on delete cascade,
  type text not null check (type in ('invisible', 'decoy', 'radar')),
  spot_id uuid references private.spots (id) on delete cascade,
  acquired_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists items_player on private.items (player_id);
create index if not exists items_room on private.items (room_code);

-- Map effects: decoy (fake sighting placed by a runner) and radar hits (real runner positions).
create table if not exists private.effects (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references private.rooms (code) on delete cascade,
  kind text not null check (kind in ('decoy', 'radar')),
  -- The runner the sighting is about (decoy owner, or radar target).
  player_id uuid not null references private.players (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null
);
create index if not exists effects_room on private.effects (room_code, ends_at);
create index if not exists effects_player on private.effects (player_id);

create table if not exists private.mission_skips (
  player_id uuid not null references private.players (id) on delete cascade,
  mission integer not null,
  created_at timestamptz not null default now(),
  primary key (player_id, mission)
);

create index if not exists players_captured_by on private.players (captured_by);
create index if not exists spots_taken_by on private.spots (taken_by);
create index if not exists items_spot on private.items (spot_id);

alter table private.spots enable row level security;
alter table private.items enable row level security;
alter table private.effects enable row level security;
alter table private.mission_skips enable row level security;
revoke all on private.spots, private.items, private.effects, private.mission_skips from public, anon, authenticated;

-- Number of selfie missions in the whole game (mission n is due at start + n*interval, before the end).
create or replace function private.missions_total(r private.rooms) returns integer
language sql stable set search_path = '' as $$
  select case when r.started_at is null then 0 else greatest(0,
    ceil(extract(epoch from (r.ends_at - r.started_at)) / r.photo_interval_s)::int - 1) end
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Host's device reports places where items may appear (from MapKit / OpenStreetMap search).
create or replace function public.set_spots(p_code text, p_key text, p_spots jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
begin
  p := private.me(p_code, p_key);
  select * into r from private.rooms where code = p_code;
  if r.phase <> 'lobby' then raise exception 'ゲーム開始後は変更できません'; end if;
  if p.id is distinct from r.host_id then raise exception '設定を変更できるのはホストだけです'; end if;
  if jsonb_typeof(p_spots) is distinct from 'array' then raise exception '不正なデータです'; end if;
  update private.rooms
     set spot_candidates = (
       select coalesce(jsonb_agg(jsonb_build_object(
                'lat', (e->>'lat')::float8, 'lng', (e->>'lng')::float8, 'name', left(coalesce(e->>'name', ''), 40))), '[]'::jsonb)
         from (select e from jsonb_array_elements(p_spots) e limit 80) x
        -- CASE fixes the evaluation order: only cast values already known to be numbers.
        where case when jsonb_typeof(e->'lat') = 'number' and jsonb_typeof(e->'lng') = 'number'
                   then private.valid_latlng((e->>'lat')::float8, (e->>'lng')::float8) else false end
     )
   where code = p_code;
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

create or replace function public.start_game(p_code text, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
  runners integer;
  chasers integer;
  unready integer;
begin
  p := private.me(p_code, p_key);
  select * into r from private.rooms where code = p_code;
  if r.phase <> 'lobby' then raise exception 'ゲーム開始後は変更できません'; end if;
  if p.id is distinct from r.host_id then raise exception 'ゲームを開始できるのはホストだけです'; end if;
  select count(*) filter (where role = 'runner'), count(*) filter (where role = 'chaser'), count(*) filter (where not ready)
    into runners, chasers, unready
    from private.players where room_code = p_code and left_at is null;
  if r.center_lat is null then raise exception '中心ピンが未設定です'; end if;
  if runners <> left(r.team_mode, 1)::int then raise exception '逃走者を%人にしてください', left(r.team_mode, 1); end if;
  if chasers <> right(r.team_mode, 1)::int then raise exception '追跡者を%人にしてください', right(r.team_mode, 1); end if;
  if unready > 0 then raise exception '全員の準備完了を待っています'; end if;

  update private.rooms
     set phase = 'playing', started_at = now(), ends_at = now() + make_interval(mins => r.duration_min)
   where code = p_code;
  insert into private.track_points (player_id, lat, lng, t)
  select id, lat, lng, now() from private.players where room_code = p_code and left_at is null and lat is not null;
  perform private.refresh_violation(id) from private.players where room_code = p_code and left_at is null;

  -- Spots: only candidates well inside the area. The most central one is the challenge spot.
  with c as (
    select (e->>'lat')::float8 as lat, (e->>'lng')::float8 as lng, e->>'name' as name
      from jsonb_array_elements(r.spot_candidates) e
  ), inside as (
    select c.*, private.haversine_m(c.lat, c.lng, r.center_lat, r.center_lng) as d
      from c where private.haversine_m(c.lat, c.lng, r.center_lat, r.center_lng) <= r.radius_m * 0.95
  ), challenge as (
    select * from inside order by d limit 1
  ), items as (
    select * from inside where (lat, lng) not in (select lat, lng from challenge) order by random() limit 6
  )
  insert into private.spots (room_code, kind, lat, lng, name)
  select p_code, 'challenge', lat, lng, coalesce(name, '') from challenge
  union all
  select p_code, 'item', lat, lng, coalesce(name, '') from items;

  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

create or replace function public.pickup_item(p_code text, p_key text, p_spot_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  s private.spots;
  v_type text;
begin
  p := private.me(p_code, p_key);
  if (select phase from private.rooms where code = p_code) <> 'playing' then raise exception 'ゲーム中ではありません'; end if;
  if p.role is null or p.captured then raise exception 'アイテムを拾えません'; end if;
  select * into s from private.spots where id = p_spot_id and room_code = p_code and kind = 'item' for update;
  if not found then raise exception 'アイテムが見つかりません'; end if;
  if s.taken_by is not null then raise exception 'このアイテムはもう取られています'; end if;
  if p.lat is null or p.pos_at < now() - interval '60 seconds'
     or private.haversine_m(p.lat, p.lng, s.lat, s.lng) > 40 then
    raise exception 'アイテムの近く（40m以内）まで行ってください';
  end if;
  v_type := case when p.role = 'chaser' then 'radar'
                 else (array['invisible', 'decoy'])[1 + floor(random() * 2)::int] end;
  update private.spots set taken_by = p.id, taken_at = now() where id = s.id;
  insert into private.items (room_code, player_id, type, spot_id) values (p_code, p.id, v_type, s.id);
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

create or replace function public.use_item(
  p_code text, p_key text, p_item_id uuid,
  p_lat double precision default null, p_lng double precision default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
  it private.items;
  target integer;
begin
  p := private.me(p_code, p_key);
  select * into r from private.rooms where code = p_code;
  if r.phase <> 'playing' then raise exception 'ゲーム中ではありません'; end if;
  if p.captured then raise exception '確保されたので使えません'; end if;
  select * into it from private.items where id = p_item_id and player_id = p.id and used_at is null for update;
  if not found then raise exception 'アイテムが見つかりません'; end if;

  if it.type = 'invisible' then
    -- The earliest mission (pending or upcoming) that is neither submitted nor already skipped.
    select min(m) into target
      from generate_series(1, private.missions_total(r)) m
     where not exists (select 1 from private.photos ph where ph.player_id = p.id and ph.mission = m and ph.uploaded)
       and not exists (select 1 from private.mission_skips k where k.player_id = p.id and k.mission = m);
    if target is null then raise exception 'スキップできる自撮りミッションがありません'; end if;
    insert into private.mission_skips (player_id, mission) values (p.id, target);
  elsif it.type = 'decoy' then
    if not private.valid_latlng(p_lat, p_lng) then raise exception '偽の足跡を置く場所を選んでください'; end if;
    if private.haversine_m(p_lat, p_lng, r.center_lat, r.center_lng) > r.radius_m then
      raise exception 'エリアの中に置いてください';
    end if;
    insert into private.effects (room_code, kind, player_id, lat, lng, ends_at)
    values (p_code, 'decoy', p.id, p_lat, p_lng, now() + interval '5 minutes');
  elsif it.type = 'radar' then
    insert into private.effects (room_code, kind, player_id, lat, lng, ends_at)
    select p_code, 'radar', x.id, x.lat, x.lng, now() + interval '10 seconds'
      from private.players x
     where x.room_code = p_code and x.role = 'runner' and not x.captured and x.left_at is null and x.lat is not null;
  end if;

  update private.items set used_at = now() where id = it.id;
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

-- Mission 0 is the 🔥 challenge selfie, only allowed within 40 m of the challenge spot.
create or replace function public.reserve_photo(p_code text, p_key text, p_mission integer) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
  v_path text;
begin
  p := private.me(p_code, p_key);
  select * into r from private.rooms where code = p_code;
  if r.phase <> 'playing' then raise exception 'ゲーム中ではありません'; end if;
  if p.role is distinct from 'runner' or p.captured then raise exception '自撮りミッションの対象ではありません'; end if;
  if p_mission = 0 then
    if not exists (
      select 1 from private.spots s
       where s.room_code = p_code and s.kind = 'challenge'
         and p.lat is not null and p.pos_at > now() - interval '60 seconds'
         and private.haversine_m(p.lat, p.lng, s.lat, s.lng) <= 40
    ) then
      raise exception 'チャレンジ地点（40m以内）で撮影してください';
    end if;
  elsif p_mission is null or p_mission < 1 or p_mission > private.missions_due(r, now()) then
    raise exception 'このミッションはまだ始まっていません';
  elsif exists (select 1 from private.mission_skips k where k.player_id = p.id and k.mission = p_mission) then
    raise exception 'このミッションは透明化でスキップ済みです';
  end if;
  select path into v_path from private.photos where player_id = p.id and mission = p_mission;
  if found then
    if (select uploaded from private.photos where player_id = p.id and mission = p_mission) then
      raise exception '%', case when p_mission = 0 then 'チャレンジは達成済みです' else 'このミッションは送信済みです' end;
    end if;
    return v_path;
  end if;
  v_path := p_code || '/' || gen_random_uuid() || '.jpg';
  insert into private.photos (room_code, player_id, mission, path) values (p_code, p.id, p_mission, v_path);
  return v_path;
end $$;

-- Records who made the capture (for points).
create or replace function public.respond_capture(p_code text, p_key text, p_request_id uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  req private.capture_requests;
begin
  p := private.me(p_code, p_key);
  if (select phase from private.rooms where code = p_code) <> 'playing' then raise exception 'ゲーム中ではありません'; end if;
  select * into req from private.capture_requests where id = p_request_id and room_code = p_code and resolved_at is null and expires_at > now();
  if not found then raise exception '確保リクエストの期限が切れています'; end if;
  if req.runner_id <> p.id then raise exception 'このリクエストには応答できません'; end if;
  if not p_accept then
    update private.capture_requests set resolved_at = now() where id = req.id;
  else
    update private.players
       set captured = true, violation = false, captured_at = now(), captured_by = req.chaser_id
     where id = p.id;
    update private.capture_requests set resolved_at = now() where runner_id = p.id and resolved_at is null;
    if not exists (select 1 from private.players where room_code = p_code and role = 'runner' and not captured and left_at is null) then
      perform private.finish(p_code, 'chaser', 'all_captured');
    end if;
  end if;
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'set_spots(text, text, jsonb)',
    'pickup_item(text, text, uuid)',
    'use_item(text, text, uuid, double precision, double precision)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
revoke all on function private.missions_total(private.rooms) from public, anon, authenticated;
