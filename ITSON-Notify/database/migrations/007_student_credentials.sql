-- 007 - ITN-36 - Credenciales de portales cifradas por estudiante
-- Supabase / PostgreSQL 15+
-- Guarda el token de cada portal cifrado con AES-256-GCM. El backend cifra antes
-- de escribir: la base nunca ve el texto plano ni la llave maestra
-- (CREDENTIALS_ENCRYPTION_KEY, solo en el servicio backend).
--
-- Esquema:
--   student_credentials: una credencial por estudiante, portal y tipo.
--     Llave natural: (user_id, portal, kind).
--     kind:
--       ivirtual_token: token del servicio moodle_mobile_app (la opcion preferida).
--       google_refresh_token: refresh token de OAuth de Classroom, solo lectura.
--       ivirtual_password: ULTIMO RECURSO para el fallback de Playwright. Solo
--         se admite en el esquema: la API del backend aun lo rechaza.
--     ciphertext, nonce y auth_tag van en columnas separadas. El nonce mide 12
--     bytes y el tag 16; esos checks tambien detectan bytea mal codificado.
--     key_version indica con que llave se cifro la fila, para poder rotarla.
--     status: needs_relink detiene los reintentos hasta que el estudiante vuelva
--     a vincular la cuenta. No hay trigger de updated_at: la app actualiza la
--     columna, como en el resto del repo.
--
-- Requiere 001. Idempotente: se puede ejecutar mas de una vez sin error ni efectos
-- extra. Todo corre en una sola transaccion.
-- Pruebas en 007_README.md.

begin;

-- Si otra sesion tiene tomada una tabla, fallar rapido en lugar de bloquear las
-- lecturas detras de los ALTER.
set local lock_timeout = '5s';

-- 0) Verificar que 001 ya se aplico
do $$
begin
  if to_regclass('public.app_users') is null then
    raise exception '007 requiere la migracion 001 (falta app_users)';
  end if;
end $$;

-- 1) Tabla
create table if not exists student_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  portal text not null
    constraint student_credentials_portal_check
    check (portal in ('ivirtual', 'google_classroom')),
  kind text not null
    constraint student_credentials_kind_check
    check (kind in ('ivirtual_token', 'google_refresh_token', 'ivirtual_password')),
  ciphertext bytea not null,
  nonce bytea not null
    constraint student_credentials_nonce_length_check
    check (octet_length(nonce) = 12),
  auth_tag bytea not null
    constraint student_credentials_auth_tag_length_check
    check (octet_length(auth_tag) = 16),
  key_version int not null default 1,
  status text not null default 'active'
    constraint student_credentials_status_check
    check (status in ('active', 'needs_relink')),
  last_validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_credentials_user_portal_kind_key unique (user_id, portal, kind),
  -- Un token de un portal no puede quedar registrado bajo otro portal.
  constraint student_credentials_portal_kind_check check (
    (portal = 'ivirtual' and kind in ('ivirtual_token', 'ivirtual_password'))
    or (portal = 'google_classroom' and kind = 'google_refresh_token')
  )
);

-- 2) RLS (sin politicas: solo la service_role del backend accede)
alter table student_credentials enable row level security;

-- 3) Permisos: solo service_role. El revoke quita lo que la tabla puede heredar
-- en proyectos creados antes del 30 de octubre de 2026 (ver 005 y 006).
revoke all on public.student_credentials from anon, authenticated, service_role;

grant select, insert, update, delete on public.student_credentials to service_role;

commit;

-- 4) Rollback (manual, comentado)
-- Borra la tabla y todos los tokens guardados: cada estudiante tendra que volver a
-- vincular sus cuentas.
--
-- begin;
-- set local lock_timeout = '5s';
-- drop table if exists student_credentials;
-- commit;

-- 5) Verificacion (despues de aplicar)
--
-- Permisos, esperado: solo service_role, con DELETE,INSERT,SELECT,UPDATE
-- select grantee, string_agg(privilege_type, ',' order by privilege_type)
-- from information_schema.role_table_grants
-- where table_schema = 'public' and table_name = 'student_credentials'
--   and grantee in ('service_role', 'anon', 'authenticated')
-- group by grantee order by grantee;
--
-- RLS, esperado: rls = true y politicas = 0
-- select c.relrowsecurity as rls,
--        (select count(*) from pg_policies p
--         where p.schemaname = 'public' and p.tablename = c.relname) as politicas
-- from pg_class c
-- where c.oid = 'public.student_credentials'::regclass;
