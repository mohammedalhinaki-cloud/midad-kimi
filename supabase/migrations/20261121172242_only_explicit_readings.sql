-- Ignore legacy schedule rows that were generated automatically by the old
-- client-side flow. They remain in history, but are not visible as today's
-- reading until an administrator explicitly presses Publish Reading.
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
     and a.is_override
     and a.assignment_date = p_date
   order by b.created_at desc
   limit 1;

  return v_assignment;
end;
$$;

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
     and a.is_override
     and a.assignment_date = (now() at time zone 'Asia/Riyadh')::date
   order by b.created_at desc
   limit 1;

  return v_assignment;
end;
$$;
