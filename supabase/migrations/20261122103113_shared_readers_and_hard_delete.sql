-- Let every active administrator monitor the reading records of all readers,
-- including assistant administrators. The super administrator remains outside
-- the reader role but can view reader activity for administration.
drop policy if exists sessions_select on public.reading_sessions;
create policy sessions_select on public.reading_sessions for select
  using (
    (member_id = auth.uid() and public.is_active_reader())
    or (
      public.is_admin()
      and exists (
        select 1 from public.profiles p
         where p.id = reading_sessions.member_id
           and p.role in ('member', 'assistant_admin')
      )
    )
  );

drop policy if exists views_select on public.page_views;
create policy views_select on public.page_views for select
  using (
    (member_id = auth.uid() and public.is_active_reader())
    or (
      public.is_admin()
      and exists (
        select 1 from public.profiles p
         where p.id = page_views.member_id
           and p.role in ('member', 'assistant_admin')
      )
    )
  );

drop policy if exists completions_select on public.completions;
create policy completions_select on public.completions for select
  using (
    (member_id = auth.uid() and public.is_active_reader())
    or (
      public.is_admin()
      and exists (
        select 1 from public.profiles p
         where p.id = completions.member_id
           and p.role in ('member', 'assistant_admin')
      )
    )
  );

-- Auth-user deletion cascades to profiles, sessions, page views, completions,
-- leaves and status history. Purge activity rows referring to the profile in
-- the same transaction so neither a delete log nor identifying history remains.
create or replace function public.purge_profile_activity_logs()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.activity_logs
   where actor_id = old.id
      or target_id = old.id::text;
  return old;
end;
$$;

revoke all on function public.purge_profile_activity_logs() from public, anon, authenticated;

drop trigger if exists trg_purge_profile_activity_logs on public.profiles;
create trigger trg_purge_profile_activity_logs
  before delete on public.profiles
  for each row execute function public.purge_profile_activity_logs();
