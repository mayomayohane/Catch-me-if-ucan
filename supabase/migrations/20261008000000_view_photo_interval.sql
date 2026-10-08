-- Expose the selfie interval in the room view so the lobby can offer a demo mode
-- (shorter intervals) and the game screen can label it.

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
      'photoIntervalS', r.photo_interval_s
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
