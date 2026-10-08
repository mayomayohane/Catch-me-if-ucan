-- Footprint radar and proximity alert.
--  * rooms.footprint_delay_s / footprint_span_s: chasers see runners' trail from
--    (delay + span) to delay seconds ago. span = 0 turns footprints off.
--  * The room view gains `footprints` and `proximityM` (see private.view).
--  * update_location always pings during play so proximity bands stay fresh for everyone.

alter table private.rooms add column if not exists footprint_delay_s integer not null default 300
  check (footprint_delay_s between 0 and 1800);
alter table private.rooms add column if not exists footprint_span_s integer not null default 600
  check (footprint_span_s between 0 and 1800);

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
      'durationMin', r.duration_min,
      'photoIntervalS', r.photo_interval_s,
      'footprintDelayS', r.footprint_delay_s,
      'footprintSpanS', r.footprint_span_s
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
    -- Footprint radar: where runners were between (delay + span) and delay seconds ago,
    -- thinned to one point per 20 s. Never the live position.
    'footprints', case when r.phase = 'playing' and r.footprint_span_s > 0 then (
      select coalesce(jsonb_object_agg(f.player_id, f.pts), '{}'::jsonb) from (
        select s.player_id, jsonb_agg(jsonb_build_array(s.lat, s.lng, private.ms(s.t)) order by s.t) as pts
          from (
            select distinct on (tp.player_id, floor(extract(epoch from tp.t) / 20))
                   tp.player_id, tp.lat, tp.lng, tp.t
              from private.track_points tp
              join private.players p on p.id = tp.player_id
             where p.room_code = r.code and p.role = 'runner' and not p.captured and p.left_at is null
               and tp.t >= now() - make_interval(secs => r.footprint_delay_s + r.footprint_span_s)
               and tp.t <= now() - make_interval(secs => r.footprint_delay_s)
             order by tp.player_id, floor(extract(epoch from tp.t) / 20), tp.t
          ) s
         group by s.player_id
      ) f
    ) else '{}'::jsonb end,
    -- Proximity alert: distance band (20/50/100 m) to the nearest active opponent, or null.
    -- Only fresh (< 60 s) positions count; the exact distance is never revealed.
    'proximityM', case
      when r.phase = 'playing' and v.role is not null and not v.captured
           and v.lat is not null and v.pos_at > now() - interval '60 seconds' then (
        select case when m.d <= 20 then 20 when m.d <= 50 then 50 when m.d <= 100 then 100 end
          from (
            select min(private.haversine_m(v.lat, v.lng, o.lat, o.lng)) as d
              from private.players o
             where o.room_code = r.code and o.left_at is null and o.role is not null and o.role <> v.role
               and not o.captured and o.lat is not null and o.pos_at > now() - interval '60 seconds'
          ) m
      ) end,
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

-- Separate from set_settings so its signature stays unchanged (no overloads for PostgREST).
create or replace function public.set_footprints(p_code text, p_key text, p_delay_s integer, p_span_s integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
begin
  p := private.me(p_code, p_key);
  select * into r from private.rooms where code = p_code;
  if r.phase <> 'lobby' then raise exception 'ゲーム開始後は変更できません'; end if;
  if p.id is distinct from r.host_id then raise exception '設定を変更できるのはホストだけです'; end if;
  update private.rooms
     set footprint_delay_s = least(1800, greatest(0, coalesce(p_delay_s, 300))),
         footprint_span_s = least(1800, greatest(0, coalesce(p_span_s, 600)))
   where code = p_code;
  perform private.notify(p_code);
  return private.respond(p_code, p.id);
end $$;

revoke all on function public.set_footprints(text, text, integer, integer) from public;
grant execute on function public.set_footprints(text, text, integer, integer) to anon, authenticated;

-- Returns nothing to keep frequent GPS updates light; other clients are pinged to re-fetch.
create or replace function public.update_location(p_code text, p_key text, p_lat double precision, p_lng double precision, p_acc double precision default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  p private.players;
  r private.rooms;
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
  perform private.refresh_violation(p.id);
  -- Every move can change someone's view (teammates, exposure, proximity alerts), so always ping.
  perform private.notify(p_code);
end $$;
