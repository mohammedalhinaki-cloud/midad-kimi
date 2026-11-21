-- Assistant admins can participate in daily reading with a session keyed to
-- their own profile. The super administrator remains outside the reading role.
create or replace function public.is_active_reader()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.profiles
     where id = auth.uid()
       and status = 'active'
       and role in ('member', 'assistant_admin')
  );
$$;

revoke all on function public.is_active_reader() from public;
grant execute on function public.is_active_reader() to authenticated;

-- Require an active profile for privileges that depend on the admin helpers;
-- hiding the admin screens alone is not an authorization boundary.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and status = 'active'
       and role in ('super_admin', 'assistant_admin')
  );
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and status = 'active' and role = 'super_admin'
  );
$$;

-- Administrators may continue monitoring member progress, but assistant admins
-- can only read their own assistant-reading records (not another assistant's).
drop policy if exists sessions_select on public.reading_sessions;
create policy sessions_select on public.reading_sessions for select
  using (
    (member_id = auth.uid() and public.is_active_reader())
    or (public.is_super_admin() and member_id <> auth.uid())
    or (
      public.is_admin()
      and exists (
        select 1 from public.profiles p
         where p.id = reading_sessions.member_id and p.role = 'member'
      )
    )
  );

drop policy if exists views_select on public.page_views;
create policy views_select on public.page_views for select
  using (
    (member_id = auth.uid() and public.is_active_reader())
    or (public.is_super_admin() and member_id <> auth.uid())
    or (
      public.is_admin()
      and exists (
        select 1 from public.profiles p
         where p.id = page_views.member_id and p.role = 'member'
      )
    )
  );

drop policy if exists completions_select on public.completions;
create policy completions_select on public.completions for select
  using (
    (member_id = auth.uid() and public.is_active_reader())
    or (public.is_super_admin() and member_id <> auth.uid())
    or (
      public.is_admin()
      and exists (
        select 1 from public.profiles p
         where p.id = completions.member_id and p.role = 'member'
      )
    )
  );

-- Sessions are unique per profile + assignment. Since member_id is auth.uid(),
-- each assistant has an independent session and completion for every reading.
create or replace function public.start_or_get_session(p_assignment_id uuid)
returns public.reading_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_session public.reading_sessions;
  v_assignment public.assignments;
  v_status text;
  v_role text;
begin
  select role, status into v_role, v_status
    from public.profiles
   where id = auth.uid();
  if v_status is null then raise exception 'profile_not_found'; end if;
  if v_status <> 'active' then raise exception 'account_not_active'; end if;
  if v_role not in ('member', 'assistant_admin') then raise exception 'reader_required'; end if;

  select * into v_assignment from public.assignments where id = p_assignment_id;
  if v_assignment.id is null then raise exception 'assignment_not_found'; end if;
  if v_assignment.is_no_reading then raise exception 'no_reading_day'; end if;

  insert into public.reading_sessions (member_id, assignment_id)
  values (auth.uid(), p_assignment_id)
  on conflict (member_id, assignment_id) do nothing;

  select * into v_session from public.reading_sessions
   where member_id = auth.uid() and assignment_id = p_assignment_id;

  return v_session;
end;
$$;

-- Re-check role and active status for every page confirmation so an inactive
-- account or super administrator cannot keep progressing an old session.
create or replace function public.confirm_page_view(p_session_id uuid, p_position integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.reading_sessions;
  v_assignment public.assignments;
  v_min_seconds integer;
  v_last_view timestamptz;
  v_page integer;
  v_total integer;
begin
  if not public.is_active_reader() then raise exception 'reader_required'; end if;

  select * into v_session from public.reading_sessions
   where id = p_session_id and member_id = auth.uid();
  if v_session.id is null then raise exception 'session_not_found'; end if;
  if v_session.status = 'completed' then raise exception 'already_completed'; end if;

  select * into v_assignment from public.assignments where id = v_session.assignment_id;
  v_total := v_assignment.end_page - v_assignment.start_page + 1;

  if p_position <> v_session.current_position then
    raise exception 'wrong_order';
  end if;
  if p_position >= v_total then raise exception 'already_finished'; end if;

  select min_page_seconds into v_min_seconds from public.app_settings where id = 1;
  v_min_seconds := coalesce(v_min_seconds, 60);

  if v_session.current_position = 0 then
    v_last_view := v_session.started_at;
  else
    select viewed_at into v_last_view from public.page_views
     where session_id = p_session_id order by position_index desc limit 1;
  end if;

  if v_last_view is not null and extract(epoch from (now() - v_last_view)) < v_min_seconds then
    raise exception 'too_fast';
  end if;

  v_page := v_assignment.start_page + p_position;

  insert into public.page_views (session_id, member_id, assignment_id, page_number, position_index)
  values (p_session_id, auth.uid(), v_session.assignment_id, v_page, p_position);

  update public.reading_sessions
     set current_position = current_position + 1, last_activity_at = now()
   where id = p_session_id;

  return jsonb_build_object('ok', true, 'page', v_page,
    'confirmed', v_session.current_position + 1, 'total', v_total);
end;
$$;

create or replace function public.complete_reading(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.reading_sessions;
  v_assignment public.assignments;
  v_total integer;
  v_counts boolean;
begin
  if not public.is_active_reader() then raise exception 'reader_required'; end if;

  select * into v_session from public.reading_sessions
   where id = p_session_id and member_id = auth.uid();
  if v_session.id is null then raise exception 'session_not_found'; end if;

  select * into v_assignment from public.assignments where id = v_session.assignment_id;
  v_total := v_assignment.end_page - v_assignment.start_page + 1;

  if v_session.current_position < v_total then raise exception 'not_finished'; end if;

  v_counts := now() <= v_assignment.published_at + interval '48 hours';

  insert into public.completions (member_id, assignment_id, completed_at, counts_as_completed)
  values (auth.uid(), v_session.assignment_id, now(), v_counts)
  on conflict (member_id, assignment_id) do nothing;

  update public.reading_sessions
     set status = 'completed', completed_at = now(), last_activity_at = now()
   where id = p_session_id;

  return jsonb_build_object('ok', true, 'counts', v_counts, 'completed_at', now());
end;
$$;
