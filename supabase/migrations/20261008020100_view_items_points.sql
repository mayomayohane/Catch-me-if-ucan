-- Room view for phase 2: spots, items, sightings, mission skips, and result scores.

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
       ) and not exists (
         select 1 from private.mission_skips k where k.player_id = v.id and k.mission = m
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
      'footprintSpanS', r.footprint_span_s,
      'spotCandidates', jsonb_array_length(r.spot_candidates)
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
    -- Untaken item spots and the challenge spot (everyone sees them).
    'spots', case when r.phase = 'playing' then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'kind', s.kind, 'lat', s.lat, 'lng', s.lng, 'name', s.name)), '[]'::jsonb)
        from private.spots s where s.room_code = r.code and s.taken_by is null
    ) else '[]'::jsonb end,
    'myItems', case when r.phase = 'playing' then (
      select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'type', i.type) order by i.acquired_at), '[]'::jsonb)
        from private.items i where i.player_id = v.id and i.used_at is null
    ) else '[]'::jsonb end,
    -- Chasers: radar hits and decoys, indistinguishable. Runners: only their own decoys.
    'sightings', case when r.phase = 'playing' then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'lat', e.lat, 'lng', e.lng, 'name', x.name,
        'until', private.ms(e.ends_at), 'mine', e.player_id = v.id)), '[]'::jsonb)
        from private.effects e join private.players x on x.id = e.player_id
       where e.room_code = r.code and e.ends_at > now()
         and (v.role = 'chaser' or (e.kind = 'decoy' and e.player_id = v.id))
    ) else '[]'::jsonb end,
    'mySkippedMissions', (
      select coalesce(jsonb_agg(k.mission order by k.mission), '[]'::jsonb)
        from private.mission_skips k where k.player_id = v.id
    ),
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
      -- Points (mirrored in src/shared/game.ts POINTS for display).
      'scores', (
        select coalesce(jsonb_agg(sc.obj order by (sc.obj->>'points')::int desc), '[]'::jsonb) from (
          select case when p.role = 'runner' then jsonb_build_object(
                   'playerId', p.id,
                   'points', k.surv + k.pics * 5 + e.escape_pts,
                   'breakdown', jsonb_build_array(
                     jsonb_build_object('label', '生存 ' || k.surv || '分', 'pts', k.surv),
                     jsonb_build_object('label', '自撮り ×' || k.pics, 'pts', k.pics * 5),
                     jsonb_build_object('label', case when p.captured then '確保された'
                                                      when k.chal then '逃げ切り 🔥×3' else '逃げ切り' end,
                                        'pts', e.escape_pts)))
                 else jsonb_build_object(
                   'playerId', p.id,
                   'points', k.caps * 50 + case when r.winner = 'chaser' then 20 else 0 end,
                   'breakdown', jsonb_build_array(
                     jsonb_build_object('label', '確保 ×' || k.caps, 'pts', k.caps * 50),
                     jsonb_build_object('label', case when r.winner = 'chaser' then 'チーム勝利' else 'チーム敗北' end,
                                        'pts', case when r.winner = 'chaser' then 20 else 0 end)))
                 end as obj
            from private.players p
            cross join lateral (
              select greatest(0, floor(extract(epoch from (coalesce(p.captured_at, r.ended_at) - r.started_at)) / 60))::int as surv,
                     (select count(*)::int from private.photos ph where ph.player_id = p.id and ph.uploaded and ph.mission >= 1) as pics,
                     exists (select 1 from private.photos ph where ph.player_id = p.id and ph.uploaded and ph.mission = 0) as chal,
                     (select count(*)::int from private.players y where y.captured_by = p.id) as caps
            ) k
            cross join lateral (
              select case when p.role = 'runner' and not p.captured then case when k.chal then 90 else 30 end else 0 end as escape_pts
            ) e
           where p.room_code = r.code and p.left_at is null and p.role is not null
        ) sc
      ),
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
