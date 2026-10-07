-- End-to-end smoke test of the game RPCs, run as the `anon` role (what the app uses).
-- Plays a full 1 vs 4 game and rolls everything back. Run in the SQL Editor; success = no error.

begin;

set local role anon;
do $$
declare
  k text[] := array['key-host-0123456789', 'key-p2-0123456789ab', 'key-p3-0123456789ab', 'key-p4-0123456789ab', 'key-p5-0123456789ab'];
  v jsonb;
  c text;
  i int;
begin
  v := public.create_room(k[1], 'ホスト');
  c := v->'room'->>'code';
  assert c ~ '^\d{5}$', 'room code';
  perform set_config('smoke.code', c, true);
  for i in 2..5 loop perform public.join_room(c, k[i], 'p' || i); end loop;

  begin
    perform public.join_room(c, 'key-sixth-0123456789', 'six');
    raise exception 'sixth player should be rejected';
  exception when others then
    if sqlerrm not like '%満員%' then raise; end if;
  end;

  perform public.set_settings(c, k[1], '1v4', 35.681236, 139.767125, 3000, 30, 10);
  perform public.set_role(c, k[1], 'runner');
  perform public.set_ready(c, k[1], true);
  begin
    perform public.set_role(c, k[2], 'runner');
    raise exception 'runner cap should apply';
  exception when others then
    if sqlerrm not like '%定員%' then raise; end if;
  end;
  for i in 2..5 loop
    perform public.set_role(c, k[i], 'chaser');
    perform public.set_ready(c, k[i], true);
  end loop;

  begin
    perform public.start_game(c, k[2]);
    raise exception 'guest should not start';
  exception when others then
    if sqlerrm not like '%ホスト%' then raise; end if;
  end;
  v := public.start_game(c, k[1]);
  assert v->'room'->>'phase' = 'playing', 'started';

  -- Runner inside the area: hidden from chasers.
  perform public.update_location(c, k[1], 35.69, 139.767125);
  perform public.update_location(c, k[2], 35.68, 139.76);
  v := public.get_room_view(c, k[2]);
  assert not (v->'room'->'players'->0 ? 'pos'), 'runner hidden while inside';
  v := public.get_room_view(c, k[3]);
  assert v->'room'->'players'->1 ? 'pos', 'chasers see each other';
  -- Runners never see chasers.
  v := public.get_room_view(c, k[1]);
  assert not (v->'room'->'players'->1 ? 'pos'), 'chaser hidden from runner';

  -- Runner leaves the area (~7.7 km north): exposed with violation.
  perform public.update_location(c, k[1], 35.75, 139.767125);
  v := public.get_room_view(c, k[2]);
  assert (v->'room'->'players'->0->>'violation')::boolean, 'violation flagged';
  assert v->'room'->'players'->0 ? 'pos', 'runner exposed while outside';

  -- Back inside: hidden again.
  perform public.update_location(c, k[1], 35.69, 139.767125);
  v := public.get_room_view(c, k[2]);
  assert not (v->'room'->'players'->0->>'violation')::boolean and not (v->'room'->'players'->0 ? 'pos'), 'hidden again';

  -- No mission yet.
  begin
    perform public.reserve_photo(c, k[1], 1);
    raise exception 'mission 1 should not be due yet';
  exception when others then
    if sqlerrm not like '%まだ始まって%' then raise; end if;
  end;

  -- Raw tables are not readable by the app role.
  begin
    perform 1 from private.players;
    raise exception 'private tables must not be readable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Fast-forward 11 seconds (selfie interval was set to 10 s above).
reset role;
update private.rooms
   set started_at = started_at - interval '11 seconds', ends_at = ends_at - interval '11 seconds'
 where code = current_setting('smoke.code');
set local role anon;

do $$
declare
  c text := current_setting('smoke.code');
  runner text := 'key-host-0123456789';
  chaser text := 'key-p3-0123456789ab';
  v jsonb;
  p text;
  req uuid;
begin
  v := public.get_room_view(c, runner);
  assert v->'room'->'myPendingMissions' = '[1]'::jsonb, 'mission 1 pending: ' || (v->'room'->'myPendingMissions')::text;
  v := public.get_room_view(c, chaser);
  assert v->'room'->'myPendingMissions' = '[]'::jsonb, 'chasers have no missions';

  begin
    perform public.reserve_photo(c, chaser, 1);
    raise exception 'chaser cannot take selfie';
  exception when others then
    if sqlerrm not like '%対象ではありません%' then raise; end if;
  end;

  p := public.reserve_photo(c, runner, 1);
  -- Storage RLS: only the reserved path is writable.
  begin
    insert into storage.objects (bucket_id, name) values ('drokei-photos', c || '/not-reserved.jpg');
    raise exception 'unreserved upload must be rejected';
  exception when insufficient_privilege then null;
  end;
  insert into storage.objects (bucket_id, name) values ('drokei-photos', p);
  v := public.confirm_photo(c, runner, p, 35.69, 139.767125);
  assert v->'room'->'myPendingMissions' = '[]'::jsonb, 'mission done';
  v := public.get_room_view(c, chaser);
  assert jsonb_array_length(v->'room'->'photos') = 1, 'chasers see the photo';

  -- Capture: chaser requests, runner rejects, then accepts.
  v := public.request_capture(c, chaser, (v->'room'->'players'->0->>'id')::uuid);
  v := public.get_room_view(c, runner);
  req := (v->'room'->'captureRequests'->0->>'id')::uuid;
  begin
    perform public.respond_capture(c, chaser, req, true);
    raise exception 'only the runner may respond';
  exception when others then
    if sqlerrm not like '%応答できません%' then raise; end if;
  end;
  v := public.respond_capture(c, runner, req, false);
  assert v->'room'->>'phase' = 'playing', 'rejected capture keeps playing';

  v := public.request_capture(c, chaser, (v->'room'->>'meId')::uuid);
  v := public.get_room_view(c, runner);
  v := public.respond_capture(c, runner, (v->'room'->'captureRequests'->0->>'id')::uuid, true);
  assert v->'room'->>'phase' = 'finished', 'finished';
  assert v->'room'->'result'->>'winner' = 'chaser', 'chasers win';
  assert jsonb_array_length(v->'room'->'result'->'tracks'->(v->'room'->>'meId')) >= 1, 'runner track recorded';
  raise notice 'smoke test passed (room %)', c;
end $$;

rollback;
