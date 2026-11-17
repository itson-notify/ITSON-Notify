-- ITN-59. Apply manually before the backend release; never from worker startup.
begin;
set local lock_timeout = '5s';
alter table public.google_authorizations
  add column if not exists status text not null default 'active'
  check (status in ('active', 'needs_relink'));
commit;
