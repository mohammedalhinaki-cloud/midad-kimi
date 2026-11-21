-- ============================================================
-- Midad — Group Reading Management Platform
-- Initial schema, RLS policies, private storage bucket,
-- and server-side reading-verification RPCs.
--
-- Dates are stored as Gregorian ISO values; the frontend
-- displays them in Hijri (Umm al-Qura) using Asia/Riyadh.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- profiles (roles live here, never trusted from the frontend) ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('super_admin', 'assistant_admin', 'member')),
  full_name text not null,
  phone text unique,          -- normalized E.164 (+9665xxxxxxxx) for members
  email text unique,          -- for administrators
  status text not null default 'active' check (status in ('active', 'suspended', 'excluded')),
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- books ----------
create table public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text,
  storage_path text,          -- path inside the private 'books' bucket
  file_name text,
  page_count integer,
  start_page integer not null default 1 check (start_page >= 1),
  end_page integer check (end_page is null or end_page >= start_page),
  daily_pages integer not null default 3 check (daily_pages >= 1),
  printed_page_offset integer, -- printed page number = PDF page number + offset (optional)
  start_date date,             -- first assignment date (Gregorian, Asia/Riyadh)
  is_paused boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- global reading settings (singleton) ----------
create table public.app_settings (
  id integer primary key check (id = 1),
  min_page_seconds integer not null default 60 check (min_page_seconds >= 0),
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1);

-- ---------- daily assignments (auto-generated or admin-overridden) ----------
create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  assignment_date date not null,        -- Gregorian date in Asia/Riyadh
  start_page integer not null check (start_page >= 1),
  end_page integer not null check (end_page >= start_page),
  published_at timestamptz not null,    -- midnight Asia/Riyadh of assignment_date
  is_no_reading boolean not null default false,
  no_reading_reason text,
  is_override boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (book_id, assignment_date)
);

-- ---------- reading sessions (one per member per assignment) ----------
create table public.reading_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles (id) on delete cascade,
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  current_position integer not null default 0 check (current_position >= 0),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (member_id, assignment_id)
);

-- ---------- page-view verification records (server timestamps only) ----------
create table public.page_views (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.reading_sessions (id) on delete cascade,
  member_id uuid not null references public.profiles (id) on delete cascade,
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  page_number integer not null check (page_number >= 1),
  position_index integer not null check (position_index >= 0),
  viewed_at timestamptz not null default now(),
  unique (session_id, position_index)
);

-- ---------- completions (unique per member per assignment) ----------
create table public.completions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles (id) on delete cascade,
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  completed_at timestamptz not null default now(),
  counts_as_completed boolean not null default true, -- false when completed after 48h
  unique (member_id, assignment_id)
);

-- ---------- leave periods ----------
create table public.leaves (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles (id) on delete cascade,
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  reason text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- suspension / exclusion / restoration history ----------
create table public.member_status_history (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles (id) on delete cascade,
  status text not null check (status in ('active', 'suspended', 'excluded')),
  note text,
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz not null default now()
);

-- ---------- administrative activity log ----------
create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

-- ---------- indexes ----------
create index idx_assignments_book_date on public.assignments (book_id, assignment_date);
create index idx_sessions_member on public.reading_sessions (member_id);
create index idx_views_session on public.page_views (session_id);
create index idx_completions_member on public.completions (member_id);
create index idx_leaves_member on public.leaves (member_id);
create index idx_logs_created on public.activity_logs (created_at desc);
create index idx_profiles_role on public.profiles (role);

-- ---------- updated_at trigger ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger trg_books_updated before update on public.books
  for each row execute function public.set_updated_at();
create trigger trg_settings_updated before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------- role helpers (SECURITY DEFINER so RLS policies can use them safely) ----------
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('super_admin', 'assistant_admin'));
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin');
$$;

-- ---------- enable RLS on every application table ----------
alter table public.profiles enable row level security;
alter table public.books enable row level security;
alter table public.app_settings enable row level security;
alter table public.assignments enable row level security;
alter table public.reading_sessions enable row level security;
alter table public.page_views enable row level security;
alter table public.completions enable row level security;
alter table public.leaves enable row level security;
alter table public.member_status_history enable row level security;
alter table public.activity_logs enable row level security;

-- profiles: members read their own row, admins read all.
-- No direct writes: all profile changes go through the manage-users Edge Function.
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());

-- books
create policy books_select on public.books for select using (auth.uid() is not null);
create policy books_insert on public.books for insert with check (public.is_admin());
create policy books_update on public.books for update using (public.is_admin()) with check (public.is_admin());
create policy books_delete on public.books for delete using (public.is_admin());

-- app_settings
create policy settings_select on public.app_settings for select using (auth.uid() is not null);
create policy settings_update on public.app_settings for update using (public.is_admin()) with check (public.is_admin());

-- assignments
create policy assignments_select on public.assignments for select using (auth.uid() is not null);
create policy assignments_insert on public.assignments for insert with check (public.is_admin());
create policy assignments_update on public.assignments for update using (public.is_admin()) with check (public.is_admin());
create policy assignments_delete on public.assignments for delete using (public.is_admin());

-- reading_sessions: members touch only their own rows; progress fields are
-- updated exclusively by the verification RPCs (column grant below).
create policy sessions_select on public.reading_sessions for select
  using (member_id = auth.uid() or public.is_admin());
create policy sessions_update on public.reading_sessions for update
  using (member_id = auth.uid()) with check (member_id = auth.uid());

-- page_views: read-only for clients; writes happen only inside confirm_page_view.
create policy views_select on public.page_views for select
  using (member_id = auth.uid() or public.is_admin());

-- completions: read-only for clients; writes happen only inside complete_reading.
create policy completions_select on public.completions for select
  using (member_id = auth.uid() or public.is_admin());

-- leaves
create policy leaves_select on public.leaves for select
  using (member_id = auth.uid() or public.is_admin());
create policy leaves_insert on public.leaves for insert with check (public.is_admin());
create policy leaves_update on public.leaves for update using (public.is_admin()) with check (public.is_admin());
create policy leaves_delete on public.leaves for delete using (public.is_admin());

-- member_status_history: read-only for clients; writes via the Edge Function.
create policy history_select on public.member_status_history for select
  using (member_id = auth.uid() or public.is_admin());

-- activity_logs: super admin sees all; assistant admin sees their own actions.
create policy logs_select on public.activity_logs for select
  using (public.is_super_admin() or actor_id = auth.uid());
create policy logs_insert on public.activity_logs for insert
  with check (actor_id = auth.uid() and public.is_admin());

-- ---------- grants ----------
grant usage on schema public to authenticated;

grant select on public.profiles, public.books, public.app_settings, public.assignments,
  public.reading_sessions, public.page_views, public.completions, public.leaves,
  public.member_status_history, public.activity_logs to authenticated;

grant insert, update, delete on public.books, public.assignments, public.leaves to authenticated;
grant update on public.app_settings to authenticated;
grant update (last_activity_at) on public.reading_sessions to authenticated;
grant insert on public.activity_logs to authenticated;

revoke all on function public.my_role() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.is_super_admin() from public;
grant execute on function public.my_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_super_admin() to authenticated;

-- ---------- private PDF bucket ----------
insert into storage.buckets (id, name, public) values ('books', 'books', false);

create policy storage_books_select on storage.objects for select
  using (bucket_id = 'books' and exists (select 1 from public.profiles where id = auth.uid()));
create policy storage_books_insert on storage.objects for insert
  with check (bucket_id = 'books' and public.is_admin());
create policy storage_books_update on storage.objects for update
  using (bucket_id = 'books' and public.is_admin())
  with check (bucket_id = 'books' and public.is_admin());
create policy storage_books_delete on storage.objects for delete
  using (bucket_id = 'books' and public.is_admin());

-- ---------- assignment auto-generation ----------
create or replace function public.ensure_assignment(p_date date)
returns public.assignments
language plpgsql security definer set search_path = public as $$
declare
  v_book public.books;
  v_assignment public.assignments;
  v_offset integer;
  v_start integer;
  v_end integer;
begin
  select * into v_book from public.books
   where is_active and not is_paused
   order by created_at desc limit 1;
  if v_book.id is null then return null; end if;

  select * into v_assignment from public.assignments
   where book_id = v_book.id and assignment_date = p_date;
  if v_assignment.id is not null then return v_assignment; end if;

  if v_book.start_date is null then
    update public.books set start_date = p_date where id = v_book.id;
    v_book.start_date := p_date;
  end if;

  v_offset := p_date - v_book.start_date;
  if v_offset < 0 then return null; end if;

  v_start := v_book.start_page + v_offset * v_book.daily_pages;
  if v_book.end_page is not null and v_start > v_book.end_page then return null; end if;

  v_end := v_start + v_book.daily_pages - 1;
  if v_book.end_page is not null and v_end > v_book.end_page then v_end := v_book.end_page; end if;

  insert into public.assignments (book_id, assignment_date, start_page, end_page, published_at)
  values (v_book.id, p_date, v_start, v_end, (p_date::timestamp at time zone 'Asia/Riyadh'))
  returning * into v_assignment;

  return v_assignment;
end;
$$;

create or replace function public.get_today_assignment()
returns public.assignments
language plpgsql security definer set search_path = public as $$
begin
  return public.ensure_assignment((now() at time zone 'Asia/Riyadh')::date);
end;
$$;

-- ---------- reading session ----------
create or replace function public.start_or_get_session(p_assignment_id uuid)
returns public.reading_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_session public.reading_sessions;
  v_assignment public.assignments;
  v_status text;
begin
  select status into v_status from public.profiles where id = auth.uid();
  if v_status is null then raise exception 'profile_not_found'; end if;
  if v_status <> 'active' then raise exception 'account_not_active'; end if;

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

-- ---------- page-view verification (trusted server timestamps) ----------
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
  select * into v_session from public.reading_sessions
   where id = p_session_id and member_id = auth.uid();
  if v_session.id is null then raise exception 'session_not_found'; end if;
  if v_session.status = 'completed' then raise exception 'already_completed'; end if;

  select * into v_assignment from public.assignments where id = v_session.assignment_id;
  v_total := v_assignment.end_page - v_assignment.start_page + 1;

  -- pages must be confirmed strictly in order; skipping is impossible
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

-- ---------- completion (24h deadline + 48h grace, enforced server-side) ----------
create or replace function public.complete_reading(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.reading_sessions;
  v_assignment public.assignments;
  v_total integer;
  v_counts boolean;
begin
  select * into v_session from public.reading_sessions
   where id = p_session_id and member_id = auth.uid();
  if v_session.id is null then raise exception 'session_not_found'; end if;

  select * into v_assignment from public.assignments where id = v_session.assignment_id;
  v_total := v_assignment.end_page - v_assignment.start_page + 1;

  if v_session.current_position < v_total then raise exception 'not_finished'; end if;

  -- counts only when completed within 48 hours of publication
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

-- ---------- RPC grants ----------
revoke all on function public.ensure_assignment(date) from public;
revoke all on function public.get_today_assignment() from public;
revoke all on function public.start_or_get_session(uuid) from public;
revoke all on function public.confirm_page_view(uuid, integer) from public;
revoke all on function public.complete_reading(uuid) from public;

grant execute on function public.ensure_assignment(date) to authenticated;
grant execute on function public.get_today_assignment() to authenticated;
grant execute on function public.start_or_get_session(uuid) to authenticated;
grant execute on function public.confirm_page_view(uuid, integer) to authenticated;
grant execute on function public.complete_reading(uuid) to authenticated;
