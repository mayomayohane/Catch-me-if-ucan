-- Items, challenge spot and points, run as `anon`. Rolls back; success = no error.
-- 2 vs 3: k1, k2 are runners; k3..k5 chasers. Area centre C = Tokyo Station, radius 3 km.

begin;

set local role anon;
do $$
declare
  k text[] := array['key-r1-0123456789ab', 'key-r2-0123456789ab', 'key-c1-0123456789ab', 'key-c2-0123456789ab', 'key-c3-0123456789ab'];
  v jsonb;
  c text;
  i int;
  spot jsonb;
begin
  v := public.create_room(k[1], 'ランナー1');
  c := v->'room'->>'code';
  perform set_config('ip.code', c, true);
  for i in 2..5 loop perform public.join_room(c, k[i], 'p' || i); end loop;
  perform public.set_settings(c, k[1], '2v3', 35.681236, 139.767125, 3000, 30, 10);

  -- 8 candidates: the centre (→ challenge), 6 others inside, 1 outside the area (ignored).
  v := public.set_spots(c, k[1], jsonb_build_array(
    jsonb_build_object('lat', 35.681236, 'lng', 139.767125, 'name', '東京駅'),
    jsonb_build_object('lat', 35.685, 'lng', 139.770, 'name', 'A'),
    jsonb_build_object('lat', 35.676, 'lng', 139.760, 'name', 'B'),
    jsonb_build_object('lat', 35.690, 'lng', 139.775, 'name', 'C'),
    jsonb_build_object('lat', 35.672, 'lng', 139.772, 'name', 'D'),
    jsonb_build_object('lat', 35.688, 'lng', 139.758, 'name', 'E'),
    jsonb_build_object('lat', 35.679, 'lng', 139.780, 'name', 'F'),
    jsonb_build_object('lat', 35.75, 'lng', 139.767125, 'name', 'エリア外'),
    jsonb_build_object('lat', 'bad', 'lng', 1)
  ));
  assert (v->'room'->'settings'->>'spotCandidates')::int = 8, 'invalid candidate dropped: ' || (v->'room'->'settings'->>'spotCandidates');
  begin
    perform public.set_spots(c, k[2], '[]'::jsonb);
    raise exception 'guest must not set spots';
  exception when others then
    if sqlerrm not like '%ホスト%' then raise; end if;
  end;

  for i in 1..5 loop
    perform public.set_role(c, k[i], case when i <= 2 then 'runner' else 'chaser' end);
    perform public.set_ready(c, k[i], true);
  end loop;
  v := public.start_game(c, k[1]);
  assert jsonb_array_length(v->'room'->'spots') = 7, 'spots: ' || jsonb_array_length(v->'room'->'spots');
  assert (select count(*) from jsonb_array_elements(v->'room'->'spots') s where s->>'kind' = 'challenge') = 1, 'one challenge';
  assert (select s->>'name' from jsonb_array_elements(v->'room'->'spots') s where s->>'kind' = 'challenge') = '東京駅', 'most central is challenge';
  assert not exists (select 1 from jsonb_array_elements(v->'room'->'spots') s where s->>'name' = 'エリア外'), 'outside excluded';

  -- Pickup needs being within 40 m.
  spot := (select s from jsonb_array_elements(v->'room'->'spots') s where s->>'name' = 'A');
  perform public.update_location(c, k[1], 35.681236, 139.767125);
  begin
    perform public.pickup_item(c, k[1], (spot->>'id')::uuid);
    raise exception 'pickup from afar must fail';
  exception when others then
    if sqlerrm not like '%40m%' then raise; end if;
  end;
  perform public.update_location(c, k[1], 35.6851, 139.7701);
  v := public.pickup_item(c, k[1], (spot->>'id')::uuid);
  assert jsonb_array_length(v->'room'->'myItems') = 1 and v->'room'->'myItems'->0->>'type' in ('invisible', 'decoy'), 'runner item';
  assert not exists (select 1 from jsonb_array_elements(v->'room'->'spots') s where s->>'name' = 'A'), 'spot gone';
  perform public.update_location(c, k[2], 35.6851, 139.7701);
  begin
    perform public.pickup_item(c, k[2], (spot->>'id')::uuid);
    raise exception 'taken spot must fail';
  exception when others then
    if sqlerrm not like '%取られて%' then raise; end if;
  end;
  -- Chasers always get a radar.
  spot := (select s from jsonb_array_elements(v->'room'->'spots') s where s->>'name' = 'B');
  perform public.update_location(c, k[3], 35.676, 139.760);
  v := public.pickup_item(c, k[3], (spot->>'id')::uuid);
  assert v->'room'->'myItems'->0->>'type' = 'radar', 'chaser gets radar';
end $$;

-- Give runner 1 one of each runner item, so both can be tested deterministically.
reset role;
insert into private.items (room_code, player_id, type)
select current_setting('ip.code'), id, t from private.players, unnest(array['invisible', 'decoy']) t
 where room_code = current_setting('ip.code') and name = 'ランナー1';
set local role anon;

do $$
declare
  c text := current_setting('ip.code');
  r1 text := 'key-r1-0123456789ab';
  r2 text := 'key-r2-0123456789ab';
  c1 text := 'key-c1-0123456789ab';
  v jsonb;
  item uuid;
begin
  -- Invisible: skips the next mission (#1).
  v := public.get_room_view(c, r1);
  item := (select (i->>'id')::uuid from jsonb_array_elements(v->'room'->'myItems') i where i->>'type' = 'invisible' limit 1);
  v := public.use_item(c, r1, item);
  assert v->'room'->'mySkippedMissions' = '[1]'::jsonb, 'mission 1 skipped';

  -- Decoy: needs a spot inside the area; chasers see it, the other runner does not.
  item := (select (i->>'id')::uuid from jsonb_array_elements(v->'room'->'myItems') i where i->>'type' = 'decoy' limit 1);
  begin
    perform public.use_item(c, r1, item);
    raise exception 'decoy needs a location';
  exception when others then
    if sqlerrm not like '%場所%' then raise; end if;
  end;
  begin
    perform public.use_item(c, r1, item, 35.75, 139.767125);
    raise exception 'decoy outside area must fail';
  exception when others then
    if sqlerrm not like '%エリアの中%' then raise; end if;
  end;
  v := public.use_item(c, r1, item, 35.69, 139.76);
  assert (v->'room'->'sightings'->0->>'mine')::boolean, 'runner sees own decoy';
  v := public.get_room_view(c, c1);
  assert jsonb_array_length(v->'room'->'sightings') = 1 and v->'room'->'sightings'->0->>'name' = 'ランナー1', 'chaser sees decoy as a sighting';
  assert jsonb_array_length(public.get_room_view(c, r2)->'room'->'sightings') = 0, 'other runner sees nothing';

  -- Radar: pins both runners' real positions for chasers (decoy + 2 radar hits).
  item := (v->'room'->'myItems'->0->>'id')::uuid;
  v := public.use_item(c, c1, item);
  assert jsonb_array_length(v->'room'->'sightings') = 3, 'radar hits: ' || jsonb_array_length(v->'room'->'sightings');
  assert jsonb_array_length(public.get_room_view(c, r2)->'room'->'sightings') = 0, 'runners never see radar';
  begin
    perform public.use_item(c, c1, item);
    raise exception 'item is single use';
  exception when others then
    if sqlerrm not like '%見つかりません%' then raise; end if;
  end;

  -- Challenge selfie (mission 0): only at the challenge spot.
  begin
    perform public.reserve_photo(c, r2, 0);
    raise exception 'challenge away from the spot must fail';
  exception when others then
    if sqlerrm not like '%チャレンジ地点%' then raise; end if;
  end;
  perform public.update_location(c, r2, 35.68125, 139.76713);
  perform set_config('ip.path', public.reserve_photo(c, r2, 0), true);

  -- Chaser 1 captures runner 1.
  v := public.request_capture(c, c1, (public.get_room_view(c, r1)->'room'->>'meId')::uuid);
  v := public.get_room_view(c, r1);
  perform public.respond_capture(c, r1, (v->'room'->'captureRequests'->0->>'id')::uuid, true);
end $$;

-- Upload the challenge photo, then fast-forward: mission 1 is due but skipped; then time up.
reset role;
insert into storage.objects (bucket_id, name) values ('drokei-photos', current_setting('ip.path'));
update private.rooms set started_at = started_at - interval '11 seconds', ends_at = ends_at - interval '11 seconds'
 where code = current_setting('ip.code');
set local role anon;

do $$
declare
  c text := current_setting('ip.code');
  v jsonb;
begin
  v := public.confirm_photo(c, 'key-r2-0123456789ab', current_setting('ip.path'));
  assert exists (select 1 from jsonb_array_elements(v->'room'->'photos') p where (p->>'mission')::int = 0), 'challenge photo shared';
  assert public.get_room_view(c, 'key-r1-0123456789ab')->'room'->'myPendingMissions' = '[]'::jsonb, 'captured runner has no missions';
  begin
    perform public.reserve_photo(c, 'key-r2-0123456789ab', 0);
    raise exception 'challenge only once';
  exception when others then
    if sqlerrm not like '%達成済み%' then raise; end if;
  end;
end $$;

reset role;
update private.rooms
   set started_at = now() - interval '30 minutes 1 second', ends_at = now() - interval '1 second'
 where code = current_setting('ip.code');
set local role anon;

do $$
declare
  c text := current_setting('ip.code');
  v jsonb;
  s jsonb;
begin
  v := public.get_room_view(c, 'key-c1-0123456789ab');
  assert v->'room'->>'phase' = 'finished' and v->'room'->'result'->>'winner' = 'runner', 'runners win on time';
  s := v->'room'->'result'->'scores';
  assert jsonb_array_length(s) = 5, 'five scores';
  -- Runner 2: escaped with challenge → 30 min + 0 selfies + 90 = 120 and ranked first.
  assert (s->0->>'points')::int = 120, 'top score: ' || (s->0)::text;
  assert s->0->'breakdown'->2->>'label' = '逃げ切り 🔥×3', 'challenge multiplier label';
  -- Chaser 1: one capture, team lost → 50.
  assert exists (select 1 from jsonb_array_elements(s) x where (x->>'points')::int = 50
                   and x->'breakdown'->0->>'label' = '確保 ×1'), 'chaser capture points';
  raise notice 'items/points test passed: %', s;
end $$;

rollback;
