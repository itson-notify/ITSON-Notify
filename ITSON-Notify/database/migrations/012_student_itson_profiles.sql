-- 012 - ITN-55 - Perfil ITSON del alumno y semestre de cada snapshot
-- Supabase / PostgreSQL 15+
--
-- 1) student_itson_profiles: matrícula y carrera del alumno para consultar la API
--    REST de ITSON (getGrades). La API no autentica, así que la matrícula funciona
--    como credencial: se guarda cifrada con AES-256-GCM, igual que
--    student_credentials (007). El backend cifra antes de escribir con AAD
--    "user_id:itson_api:matricula"; la base nunca ve la matrícula en claro.
--    La carrera es un código (por ejemplo INSOF) y va en claro.
--    Una fila por alumno (user_id es la llave primaria).
--
-- 2) grade_snapshots.period: semestre consultado en la API (clave "01".."08").
--    El detector compara cada snapshot solo contra el anterior del mismo
--    user_id, source y period. iVirtual deja period en null, así que su
--    comparación no cambia.
--
-- Requiere 001 y 007 (mismo esquema de cifrado). Idempotente: se puede ejecutar
-- más de una vez sin error ni efectos extra. Todo corre en una sola transacción.

begin;

set local lock_timeout = '5s';

-- 0) Verificar dependencias
do $$
begin
  if to_regclass('public.app_users') is null then
    raise exception '012 requiere la migracion 001 (falta app_users)';
  end if;
  if to_regclass('public.grade_snapshots') is null then
    raise exception '012 requiere la migracion 001 (falta grade_snapshots)';
  end if;
  if to_regclass('public.student_credentials') is null then
    raise exception '012 requiere la migracion 007 (falta student_credentials)';
  end if;
end $$;

-- 1) Perfil ITSON
create table if not exists student_itson_profiles (
  user_id uuid primary key references app_users(id) on delete cascade,
  matricula_ciphertext bytea not null,
  matricula_nonce bytea not null
    constraint student_itson_profiles_nonce_length_check
    check (octet_length(matricula_nonce) = 12),
  matricula_auth_tag bytea not null
    constraint student_itson_profiles_auth_tag_length_check
    check (octet_length(matricula_auth_tag) = 16),
  key_version int not null default 1,
  career text not null
    constraint student_itson_profiles_career_check
    check (career ~ '^[A-Z]{2,8}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS sin políticas: solo la service_role del backend accede.
alter table student_itson_profiles enable row level security;

revoke all on public.student_itson_profiles from anon, authenticated, service_role;
grant select, insert, update, delete on public.student_itson_profiles to service_role;

-- 2) Semestre del snapshot
alter table grade_snapshots
  add column if not exists period text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'grade_snapshots_period_check'
      and conrelid = 'public.grade_snapshots'::regclass
  ) then
    alter table grade_snapshots
      add constraint grade_snapshots_period_check
      check (period is null or period ~ '^[0-9]{2}$');
  end if;
end $$;

-- El snapshot anterior se busca por (user_id, source, period, captured_at).
create index if not exists idx_grade_snapshots_user_source_period_captured
  on grade_snapshots (user_id, source, period, captured_at desc);

commit;

-- 3) Rollback (manual, comentado)
-- Borra los perfiles: cada alumno tendrá que volver a capturar matrícula y carrera.
-- Quitar period hace que el detector vuelva a mezclar semestres de itson_api.
--
-- begin;
-- set local lock_timeout = '5s';
-- drop table if exists student_itson_profiles;
-- drop index if exists idx_grade_snapshots_user_source_period_captured;
-- alter table grade_snapshots drop constraint if exists grade_snapshots_period_check;
-- alter table grade_snapshots drop column if exists period;
-- commit;

-- 4) Verificación (después de aplicar)
--
-- Permisos, esperado: solo service_role, con DELETE,INSERT,SELECT,UPDATE
-- select grantee, string_agg(privilege_type, ',' order by privilege_type)
-- from information_schema.role_table_grants
-- where table_schema = 'public' and table_name = 'student_itson_profiles'
--   and grantee in ('service_role', 'anon', 'authenticated')
-- group by grantee order by grantee;
--
-- RLS, esperado: rls = true y politicas = 0
-- select c.relrowsecurity as rls,
--        (select count(*) from pg_policies p
--         where p.schemaname = 'public' and p.tablename = c.relname) as politicas
-- from pg_class c
-- where c.oid = 'public.student_itson_profiles'::regclass;
--
-- Columna nueva, esperado: period text, nullable
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'grade_snapshots' and column_name = 'period';
