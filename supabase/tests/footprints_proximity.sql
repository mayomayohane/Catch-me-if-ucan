-- Footprint radar + proximity alert, run as `anon`. Rolls back; success = no error.

begin;

set local role anon;
do $$
declare
  k text[] := array['key-host-0123456789', 'key-p2-0123456789ab', 'key-p3-0123456789ab', 'key-p4-0123456789ab', 'key-p5-0123456789ab'];
  v jsonb;
  c text;
  i int;
begin
  v := public.create_room(k[1], 'ランナー');
  c := v->'room'->>'code';
  perform set_config('fp.code', c, true);
  for i in 2..5 loop perform public.join_room(c, k[i], 'p' || i); end loop;
  perform public.set_settings(c, k[1], '1v4', 35.681236, 139.767125);

  -- Footprint settings: host only, lobby only.
  v := public.set_footprints(c, k[1], 300, 600);
  assert (v->'room'->'settings'->>'footprintDelayS')::int = 300 and (v->'room'->'settings'->>'footprintSpanS')::int = 600, 'footprint settings';
  begin
    perform public.set_footprints(c, k[2], 0, 0);
    raise exception 'guest must not change footprints';
  exception when others then
    if sqlerrm not like '%ホスト%' then raise; end if;
  end;

  perform public.set_role(c, k[1], 'runner');
  perform public.set_ready(c, k[1], true);
  for i in 2..5 loop
    perform public.set_role(c, k[i], 'chaser');
    perform public.set_ready(c, k[i], true);
  end loop;
  perform public.start_game(c, k[1]);
  perform set_config('fp.runner', (public.get_room_view(c, k[1])->'room'->>'meId'), true);

  -- Proximity: nobody else has a position yet.
  perform public.update_location(c, k[1], 35.681236, 139.767125);
  v := public.get_room_view(c, k[1]);
  assert v->'room'->'proximityM' = 'null'::jsonb, 'no opponent nearby';

  -- Chaser ~80 m north -> both sides get the 100 m band.
  perform public.update_location(c, k[2], 35.681236 + 0.00072, 139.767125);
  assert (public.get_room_view(c, k[1])->'room'->>'proximityM')::int = 100, 'runner feels 100 m';
  assert (public.get_room_view(c, k[2])->'room'->>'proximityM')::int = 100, 'chaser feels 100 m';
  -- A far-away chaser feels nothing.
  perform public.update_location(c, k[3], 35.70, 139.767125);
  assert public.get_room_view(c, k[3])->'room'->'proximityM' = 'null'::jsonb, 'far chaser feels nothing';
  -- ~30 m -> 50 band, ~15 m -> 20 band.
  perform public.update_location(c, k[2], 35.681236 + 0.00027, 139.767125);
  assert (public.get_room_view(c, k[1])->'room'->>'proximityM')::int = 50, '50 m band';
  perform public.update_location(c, k[2], 35.681236 + 0.000135, 139.767125);
  assert (public.get_room_view(c, k[1])->'room'->>'proximityM')::int = 20, '20 m band';
  -- The exact live position of the runner is still hidden from chasers.
  assert not (public.get_room_view(c, k[2])->'room'->'players'->0 ? 'pos'), 'runner still hidden';
end $$;

-- Make the runner's trail: one point 6 min ago (inside 5-15 min window),
-- one 20 min ago and one 1 min ago (both outside).
reset role;
update private.track_points set t = now() - interval '6 minutes'
 where player_id = current_setting('fp.runner')::uuid;
insert into private.track_points (player_id, lat, lng, t) values
  (current_setting('fp.runner')::uuid, 35.60, 139.70, now() - interval '20 minutes'),
  (current_setting('fp.runner')::uuid, 35.61, 139.71, now() - interval '1 minute');
-- A stale opponent position (> 60 s) no longer counts for proximity.
update private.players set pos_at = now() - interval '2 minutes'
 where room_code = current_setting('fp.code') and id <> current_setting('fp.runner')::uuid;
set local role anon;

do $$
declare
  c text := current_setting('fp.code');
  runner uuid := current_setting('fp.runner')::uuid;
  v jsonb;
  fp jsonb;
begin
  v := public.get_room_view(c, 'key-p2-0123456789ab');
  fp := v->'room'->'footprints'->(runner::text);
  assert jsonb_array_length(fp) = 1, 'exactly one footprint in window: ' || coalesce(fp::text, 'null');
  assert (fp->0->>0)::float8 = 35.681236, 'footprint is the 6-min-old point';
  v := public.get_room_view(c, 'key-host-0123456789');
  assert v->'room'->'proximityM' = 'null'::jsonb, 'stale opponents ignored';
  raise notice 'footprints/proximity test passed';
end $$;

rollback;
