-- 015 - ITN-60 - Calendario académico ITSON
-- Supabase / PostgreSQL 15+
--
-- calendar_events: fechas del calendario académico público de ITSON (portal
-- institucional, CalendarPublic). No tiene datos de alumnos: es el mismo
-- calendario para todos. El worker lo descarga y el backend lo guarda con upsert
-- por external_id (POST /internal/calendar-events); el alumno lo lee con
-- GET /api/calendar. Detalle en backend/ITN-60.md.
--
--   - external_id: calendarID del portal, como texto. Único: correr la
--     sincronización dos veces no crea filas nuevas.
--   - starts_at / ends_at: instantes absolutos. El portal manda hora local de
--     Hermosillo (UTC-7 todo el año) y el worker la convierte con -07:00.
--   - all_day: true cuando el evento cubre días completos. Entonces starts_at es
--     00:00:00 y ends_at 23:59:59 (hora de Hermosillo) de sus días de inicio y fin.
--   - updated_at: última vez que cambió el contenido del evento (no la última
--     sincronización): el backend solo reescribe filas que cambiaron.
--
-- Aditiva e idempotente: la misma base la usan desarrollo y producción. Se puede
-- ejecutar más de una vez sin error ni efectos extra. Todo corre en una sola
-- transacción.

begin;

set local lock_timeout = '5s';

create table if not exists calendar_events (
  id uuid primary key default gen_random_uuid(),
  external_id text not null
    constraint calendar_events_external_id_check
    check (external_id ~ '^[0-9]{1,12}$'),
  title text not null
    constraint calendar_events_title_check
    check (char_length(title) between 1 and 300),
  description text
    constraint calendar_events_description_check
    check (description is null or char_length(description) <= 4000),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  category text
    constraint calendar_events_category_check
    check (category is null or char_length(category) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_events_external_id_key unique (external_id),
  constraint calendar_events_range_check check (ends_at >= starts_at)
);

-- GET /api/calendar busca eventos que intersectan [from, to]:
-- starts_at <= fin del rango y ends_at >= inicio del rango.
create index if not exists idx_calendar_events_starts_at
  on calendar_events (starts_at);
create index if not exists idx_calendar_events_ends_at
  on calendar_events (ends_at);

-- RLS sin políticas: solo la service_role del backend accede.
alter table calendar_events enable row level security;

revoke all on public.calendar_events from anon, authenticated, service_role;
grant select, insert, update, delete on public.calendar_events to service_role;

commit;

-- Rollback (manual, comentado)
-- Borra el calendario guardado; la siguiente sincronización lo vuelve a llenar
-- con los eventos que el portal siga publicando (los ya pasados no regresan).
--
-- begin;
-- set local lock_timeout = '5s';
-- drop table if exists calendar_events;
-- commit;

-- Verificación (después de aplicar)
--
-- Permisos, esperado: solo service_role, con DELETE,INSERT,SELECT,UPDATE
-- select grantee, string_agg(privilege_type, ',' order by privilege_type)
-- from information_schema.role_table_grants
-- where table_schema = 'public' and table_name = 'calendar_events'
--   and grantee in ('service_role', 'anon', 'authenticated')
-- group by grantee order by grantee;
--
-- RLS, esperado: rls = true y politicas = 0
-- select c.relrowsecurity as rls,
--        (select count(*) from pg_policies p
--         where p.schemaname = 'public' and p.tablename = c.relname) as politicas
-- from pg_class c
-- where c.oid = 'public.calendar_events'::regclass;
