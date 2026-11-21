-- Grant the minimal SQL privileges required by the manage-users Edge Function.
-- RLS stays enabled on every application table; service_role remains server-side only.
grant select, insert, update on table public.profiles to service_role;
grant insert on table public.activity_logs to service_role;
grant insert on table public.member_status_history to service_role;
