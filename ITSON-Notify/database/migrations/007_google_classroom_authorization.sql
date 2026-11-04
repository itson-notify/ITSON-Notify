-- ITN-41 - Autorización de Google Classroom, vinculada a app_users.
-- El equipo aplica las migraciones manualmente; no ejecutar en Supabase compartido.
-- El refresh_token se cifra en backend antes de persistirlo.
begin;
set local lock_timeout = '5s';

create table if not exists public.google_authorizations (
    user_id uuid primary key references public.app_users(id) on delete cascade,
    google_id text not null unique,
    email text not null,
    scope text not null,
    refresh_token text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Sesión de aplicación independiente del consentimiento de Classroom.
-- id es SHA-256 del identificador aleatorio; nunca se almacena la cookie.
create table if not exists public.google_app_sessions (
    id text primary key,
    user_id uuid not null references public.app_users(id) on delete cascade,
    google_id text not null references public.google_authorizations(google_id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists idx_google_app_sessions_user on public.google_app_sessions(user_id);
create index if not exists idx_google_app_sessions_expiry on public.google_app_sessions(expires_at);

-- Igual que 006: RLS sin políticas; acceso exclusivo del backend service_role.
alter table public.google_authorizations enable row level security;
alter table public.google_app_sessions enable row level security;
revoke all on public.google_authorizations, public.google_app_sessions from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.google_app_sessions to service_role;
grant select, insert, update, delete on public.google_authorizations to service_role;

commit;
