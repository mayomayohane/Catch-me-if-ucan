-- ---------------------------------------------------------------------------
-- Storage: selfies
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('drokei-photos', 'drokei-photos', true, 3 * 1024 * 1024, array['image/jpeg'])
on conflict (id) do nothing;

create or replace function private.can_upload_photo(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.photos where path = p_name and not uploaded)
$$;

drop policy if exists "Upload to a reserved selfie slot" on storage.objects;
create policy "Upload to a reserved selfie slot"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'drokei-photos' and private.can_upload_photo(name));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to anon, authenticated;
grant execute on function private.can_upload_photo(text) to anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'create_room(text, text)',
    'join_room(text, text, text)',
    'leave_room(text, text)',
    'get_room_view(text, text)',
    'set_role(text, text, text)',
    'set_settings(text, text, text, double precision, double precision, integer, integer, integer)',
    'set_ready(text, text, boolean)',
    'start_game(text, text)',
    'update_location(text, text, double precision, double precision, double precision)',
    'request_capture(text, text, uuid)',
    'respond_capture(text, text, uuid, boolean)',
    'reserve_photo(text, text, integer)',
    'confirm_photo(text, text, text, double precision, double precision)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
