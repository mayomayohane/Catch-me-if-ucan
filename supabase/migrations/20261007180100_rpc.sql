-- Public RPCs: the only entry points for clients. See 20261007180000_schema.sql for the design.

-- ---------------------------------------------------------------------------
-- Public RPCs (called with the publishable key)
-- Every RPC returns { room: RoomView, serverNow } for the caller unless noted.
-- ---------------------------------------------------------------------------

create or replace function public.create_room(p_key text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_id uuid;
begin
  loop
    v_code := (10000 + floor(random() * 90000))::int::text;
    exit when not exists (select 1 from private.rooms where code = v_code);
  end loop;
  insert into private.rooms (code) values (v_code);
  insert into private.players (room_code, key_hash, name)
  values (v_code, private.hash_key(p_key), private.clean_name(p_name))
  returning id into v_id;
  update private.rooms set host_id = v_id where code = v_code;
  return private.respond(v_code, v_id);
end $$;

-- Joins a lobby, or reconnects (same key) to a room in any phase.
create or replace function public.join_room(p_code text, p_key text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r private.rooms;
  v_id uuid;
  v_left timestamptz;
begin
  select * into r from private.rooms where code = btrim(p_code) for update;
  if not found then raise exception 'ルームが見つかりません'; end if;
  perform private.tick(r.code);
  select * into r from private.rooms where code = r.code;

  select id, left_at into v_id, v_left
    from private.players where room_code = r.code and key_hash = private.hash_key(p_key);
  if v_id is not null and v_left is null then
    if r.phase = 'lobby' then
      update private.players set name = private.clean_name(p_name) where id = v_id;
      perform private.notify(r.code);
    end if;
    return private.respond(r.code, v_id);
  end if;

  if r.phase <> 'lobby' then raise exception 'このルームはすでにゲーム中です'; end if;
  if (select count(*) from private.players where room_code = r.code and left_at is null) >= 5 then
    raise exception 'ルームが満員です（最大5人）';
  end if;
  if v_id is not null then
    -- Returning after leaving the lobby: reuse the row as a fresh join.
    update private.players
       set left_at = null, name = private.clean_name(p_name), role = null, ready = false,
           joined_at = clock_timestamp()
     where id = v_id;
  else
    insert into private.players (room_code, key_hash, name)
    values (r.code, private.hash_key(p_key), private.clean_name(p_name))
    returning id into v_id;
  end if;
  if r.host_id is null then update private.rooms set host_id = v_id where code = r.code; end if;
  perform private.notify(r.code);
  return private.respond(r.code, v_id);
end $$;

-- In the lobby the player is marked as left; mid-game the player stays (presence shows them offline).
create or replace function public.leave_room(p_code text, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
begin
  p := private.me(p_code, p_key);
  select * into r from private.rooms where code = p_code;
  if r.phase <> 'lobby' then return; end if;
  update private.players set left_at = now(), role = null, ready = false where id = p.id;
  if r.host_id = p.id then
    -- Next host is the earliest remaining player (null if the room is now empty).
    update private.rooms
       set host_id = (select id from private.players where room_code = p_code and left_at is null order by joined_at limit 1)
     where code = p_code;
  end if;
  perform private.notify(p_code);
end $$;

create or replace function public.get_room_view(p_code text, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
begin
  p := private.me(p_code, p_key);
  return private.respond(p_code, p.id);
end $$;

create or replace function public.set_role(p_code text, p_key text, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
  cap integer;
begin
  p := private.me(p_code, p_key);
  select * into r from private.rooms where code = p_code;
  if r.phase <> 'lobby' then raise exception 'ゲーム開始後は変更できません'; end if;
  if p_role is not null and p_role not in ('runner', 'chaser') then raise exception '不正な役割です'; end if;
  if p_role is not null and p.role is distinct from p_role then
    cap := case p_role when 'runner' then left(r.team_mode, 1)::int else right(r.team_mode, 1)::int end;
    if (select count(*) from private.players where room_code = p_code and role = p_role and left_at is null) >= cap then
      raise exception 'その役割は定員に達しています';
    end if;
  end if;
  update private.players set role = p_role, ready = false where id = p.id;
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

create or replace function public.set_settings(
  p_code text,
  p_key text,
  p_team_mode text default null,
  p_center_lat double precision default null,
  p_center_lng double precision default null,
  p_radius_m integer default null,
  p_duration_min integer default null,
  -- Demo/testing only: shorten the 10-minute selfie interval (10..600 s).
  p_photo_interval_s integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
begin
  p := private.me(p_code, p_key);
  select * into r from private.rooms where code = p_code;
  if r.phase <> 'lobby' then raise exception 'ゲーム開始後は変更できません'; end if;
  if p.id is distinct from r.host_id then raise exception '設定を変更できるのはホストだけです'; end if;

  if p_team_mode is not null then
    if p_team_mode not in ('1v4', '2v3', '3v2') then raise exception '不正なチーム構成です'; end if;
    update private.rooms set team_mode = p_team_mode where code = p_code;
    -- Drop players who no longer fit their role under the new caps (latest joiners first).
    update private.players set role = null, ready = false
     where id in (
       select id from (
         select id, role, row_number() over (partition by role order by joined_at) as n
           from private.players where room_code = p_code and role is not null and left_at is null
       ) x
       where x.n > case x.role when 'runner' then left(p_team_mode, 1)::int else right(p_team_mode, 1)::int end
     );
  end if;
  if p_center_lat is not null or p_center_lng is not null then
    if not private.valid_latlng(p_center_lat, p_center_lng) then raise exception '不正な座標です'; end if;
    update private.rooms set center_lat = p_center_lat, center_lng = p_center_lng where code = p_code;
  end if;
  if p_radius_m is not null then
    update private.rooms set radius_m = least(10000, greatest(500, p_radius_m)) where code = p_code;
  end if;
  if p_duration_min is not null then
    if p_duration_min not in (30, 45, 60) then raise exception '不正なゲーム時間です'; end if;
    update private.rooms set duration_min = p_duration_min where code = p_code;
  end if;
  if p_photo_interval_s is not null then
    update private.rooms set photo_interval_s = least(600, greatest(10, p_photo_interval_s)) where code = p_code;
  end if;
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

create or replace function public.set_ready(p_code text, p_key text, p_ready boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
begin
  p := private.me(p_code, p_key);
  if (select phase from private.rooms where code = p_code) <> 'lobby' then
    raise exception 'ゲーム開始後は変更できません';
  end if;
  if p_ready and p.role is null then raise exception '先に役割を選んでください'; end if;
  update private.players set ready = coalesce(p_ready, false) where id = p.id;
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
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

-- Returns nothing to keep frequent GPS updates light; other clients are pinged to re-fetch.
create or replace function public.update_location(p_code text, p_key text, p_lat double precision, p_lng double precision, p_acc double precision default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
  was_violation boolean;
  now_violation boolean;
begin
  if not private.valid_latlng(p_lat, p_lng) then raise exception '不正な座標です'; end if;
  p := private.me(p_code, p_key);
  select * into r from private.rooms where code = p_code;
  update private.players
     set lat = p_lat, lng = p_lng, pos_at = now(),
         acc = case when p_acc is null or p_acc = 'NaN'::float8 then null else least(p_acc, 100000)::int end
   where id = p.id;
  if r.phase <> 'playing' then return; end if;

  if not exists (select 1 from private.track_points where player_id = p.id and t > now() - interval '5 seconds') then
    insert into private.track_points (player_id, lat, lng, t) values (p.id, p_lat, p_lng, now());
  end if;
  was_violation := p.violation;
  perform private.refresh_violation(p.id);
  select violation into now_violation from private.players where id = p.id;
  -- Only teammates (and chasers, while a runner is exposed) can see this update,
  -- but a ping is cheap and keeps every view fresh.
  if now_violation or was_violation <> now_violation or exists (
    select 1 from private.players where room_code = p_code and role = p.role and id <> p.id and left_at is null
  ) then
    perform private.notify(p_code);
  end if;
end $$;

create or replace function public.request_capture(p_code text, p_key text, p_runner_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  runner private.players;
begin
  p := private.me(p_code, p_key);
  if (select phase from private.rooms where code = p_code) <> 'playing' then raise exception 'ゲーム中ではありません'; end if;
  if p.role is distinct from 'chaser' then raise exception '確保できるのは追跡者だけです'; end if;
  select * into runner from private.players where id = p_runner_id and room_code = p_code and role = 'runner' and left_at is null;
  if not found then raise exception '対象の逃走者が見つかりません'; end if;
  if runner.captured then raise exception 'その逃走者はすでに確保済みです'; end if;
  insert into private.capture_requests (room_code, chaser_id, runner_id, expires_at, distance_m)
  values (
    p_code, p.id, runner.id, now() + interval '60 seconds',
    case when p.lat is not null and runner.lat is not null
         then round(private.haversine_m(p.lat, p.lng, runner.lat, runner.lng))::int end
  )
  on conflict (chaser_id, runner_id) do update
    set expires_at = excluded.expires_at, distance_m = excluded.distance_m, resolved_at = null;
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

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
    update private.players set captured = true, violation = false where id = p.id;
    update private.capture_requests set resolved_at = now() where runner_id = p.id and resolved_at is null;
    if not exists (select 1 from private.players where room_code = p_code and role = 'runner' and not captured and left_at is null) then
      perform private.finish(p_code, 'chaser', 'all_captured');
    end if;
  end if;
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

-- Selfie upload, step 1: validates the mission and returns a one-time storage path.
-- Storage RLS only accepts uploads to a reserved, not-yet-uploaded path.
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
  if p_mission is null or p_mission < 1 or p_mission > private.missions_due(r, now()) then
    raise exception 'このミッションはまだ始まっていません';
  end if;
  select path into v_path from private.photos where player_id = p.id and mission = p_mission;
  if found then
    if (select uploaded from private.photos where player_id = p.id and mission = p_mission) then
      raise exception 'このミッションは送信済みです';
    end if;
    return v_path;
  end if;
  v_path := p_code || '/' || gen_random_uuid() || '.jpg';
  insert into private.photos (room_code, player_id, mission, path) values (p_code, p.id, p_mission, v_path);
  return v_path;
end $$;

-- Selfie upload, step 2: after the file is in storage, publish it to the room.
create or replace function public.confirm_photo(p_code text, p_key text, p_path text, p_lat double precision default null, p_lng double precision default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
begin
  p := private.me(p_code, p_key);
  if (select phase from private.rooms where code = p_code) <> 'playing' then raise exception 'ゲーム中ではありません'; end if;
  if not exists (select 1 from private.photos where path = p_path and player_id = p.id and not uploaded) then
    raise exception '写真が見つかりません';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'drokei-photos' and name = p_path) then
    raise exception '写真のアップロードが完了していません';
  end if;
  update private.photos
     set uploaded = true,
         created_at = now(),
         lat = case when private.valid_latlng(p_lat, p_lng) then p_lat else p.lat end,
         lng = case when private.valid_latlng(p_lat, p_lng) then p_lng else p.lng end
   where path = p_path;
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

