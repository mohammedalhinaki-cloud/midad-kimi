-- The application has one current book; when it is finished, its private PDF is replaced.
-- Historical inactive rows remain possible, but only one book can be active.
create unique index if not exists books_only_one_active_idx
  on public.books ((is_active))
  where is_active;

-- Add the optional metadata used to publish a numbered daily reading.
-- Existing assignment rows are deliberately left untouched.
alter table public.assignments
  add column if not exists day_number integer,
  add column if not exists from_quote text,
  add column if not exists to_quote text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'assignments_day_number_positive'
       and conrelid = 'public.assignments'::regclass
  ) then
    alter table public.assignments
      add constraint assignments_day_number_positive
      check (day_number is null or day_number >= 1);
  end if;
end;
$$;

-- Keep the legacy RPC name for older clients, but make it lookup-only:
-- reading a member page or a report must never create/publish a reading.
create or replace function public.ensure_assignment(p_date date)
returns public.assignments
language plpgsql security definer set search_path = public as $$
declare
  v_assignment public.assignments;
begin
  select a.* into v_assignment
    from public.assignments a
    join public.books b on b.id = a.book_id
   where b.is_active
     and a.assignment_date = p_date
   order by b.created_at desc
   limit 1;

  return v_assignment;
end;
$$;

-- A member sees today's reading only after an administrator has published it.
create or replace function public.get_today_assignment()
returns public.assignments
language plpgsql security definer set search_path = public as $$
declare
  v_assignment public.assignments;
begin
  select a.* into v_assignment
    from public.assignments a
    join public.books b on b.id = a.book_id
   where b.is_active
     and not b.is_paused
     and a.assignment_date = (now() at time zone 'Asia/Riyadh')::date
   order by b.created_at desc
   limit 1;

  return v_assignment;
end;
$$;

-- Publish or replace a day's reading atomically. The database clock starts the
-- member completion window at the exact time this administrator action runs.
create or replace function public.publish_assignment(
  p_book_id uuid,
  p_date date,
  p_start_page integer,
  p_end_page integer,
  p_day_number integer,
  p_from_quote text,
  p_to_quote text
)
returns public.assignments
language plpgsql security definer set search_path = public as $$
declare
  v_book public.books;
  v_assignment public.assignments;
  v_last_page integer;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;

  if p_book_id is null or p_date is null
     or p_start_page is null or p_end_page is null
     or p_start_page < 1 or p_end_page < p_start_page
     or p_day_number is null or p_day_number < 1 then
    raise exception using errcode = '22023', message = 'invalid_reading_details';
  end if;

  select * into v_book
    from public.books
   where id = p_book_id
     and is_active
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'active_book_not_found';
  end if;

  v_last_page := coalesce(v_book.end_page, v_book.page_count);
  if p_start_page < v_book.start_page
     or (v_last_page is not null and p_end_page > v_last_page) then
    raise exception using errcode = '22023', message = 'reading_pages_out_of_book_range';
  end if;

  insert into public.assignments (
    book_id, assignment_date, start_page, end_page, published_at,
    is_no_reading, no_reading_reason, is_override, created_by,
    day_number, from_quote, to_quote
  ) values (
    p_book_id, p_date, p_start_page, p_end_page, now(),
    false, null, true, auth.uid(),
    p_day_number, nullif(btrim(p_from_quote), ''), nullif(btrim(p_to_quote), '')
  )
  on conflict (book_id, assignment_date) do update set
    start_page = excluded.start_page,
    end_page = excluded.end_page,
    published_at = now(),
    is_no_reading = false,
    no_reading_reason = null,
    is_override = true,
    created_by = auth.uid(),
    day_number = excluded.day_number,
    from_quote = excluded.from_quote,
    to_quote = excluded.to_quote
  returning * into v_assignment;

  return v_assignment;
end;
$$;

revoke all on function public.publish_assignment(uuid, date, integer, integer, integer, text, text) from public;
grant execute on function public.publish_assignment(uuid, date, integer, integer, integer, text, text) to authenticated;
