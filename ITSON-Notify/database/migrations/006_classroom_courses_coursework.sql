-- 006 - ITN-48 - Cursos y tareas de Google Classroom por estudiante
-- Supabase / PostgreSQL 15+
-- Guarda el estado anterior de Classroom por estudiante para que el detector de
-- tareas nuevas (ITN-43) pueda comparar corridas. La persistencia es idempotente,
-- igual que grade_snapshots: repetir una corrida no duplica filas.
--
-- Esquema:
--   classroom_courses: un curso por estudiante.
--     Llave natural: (user_id, external_course_id).
--   classroom_coursework: una tarea de un curso.
--     Llave natural: (course_id, external_coursework_id). user_id se repite aqui
--     para consultar por estudiante sin join; la base no valida que coincida con
--     el user_id del curso, asi que la app debe copiarlo del curso.
--   Las columnas external_* son los ids de la API de Classroom, como texto.
--
-- Decisiones:
--   - first_seen_at es la clave de ITN-43: una tarea es nueva si se vio por
--     primera vez en la corrida actual. Solo se escribe al insertar (default), asi
--     que el upsert NUNCA debe incluirla: si la incluye, una tarea conocida
--     pareceria nueva y se volveria a notificar.
--   - Primera corrida: ITN-43 no debe notificar, como el baseline de calificaciones
--     (todas las tareas tendrian first_seen_at reciente). Lo mismo aplica a un curso
--     que aparece despues: sus tareas ya existentes no son tareas nuevas; su
--     classroom_courses.first_seen_at permite detectarlo.
--   - last_seen_at y updated_at tienen default solo para el insert. El repo no usa
--     triggers (001 a 005): la app debe enviarlas en cada upsert. Una tarea que
--     deja de verse conserva su fila, con un last_seen_at antiguo.
--   - due_at es NULL si la tarea no tiene fecha. source_created_at y
--     source_updated_at son las fechas que reporta Classroom, distintas de las
--     nuestras (created_at, updated_at).
--   - unique simple, no nulls not distinct: todas las columnas de las llaves son
--     not null.
--   - course_state, work_type y state sin check: los valores los define Classroom
--     y un valor nuevo no debe romper la corrida.
--
-- Datos: sin tokens, secretos ni raw_payload. Son datos academicos del propio
-- estudiante, por eso RLS esta activado y sin politicas (patron 002): solo la
-- service_role del backend accede.
--
-- Permisos: grants explicitos solo a service_role (patron 005). El revoke es
-- necesario: en proyectos creados antes del 30 de octubre de 2026, como
-- itson-notify-dev, las tablas nuevas pueden heredar permisos por defecto (ver
-- 005): anon y authenticated no deben conservarlos, y service_role heredaria
-- tambien truncate, references y trigger, que el backend no necesita.
--
-- Requiere 001. Idempotente: se puede ejecutar mas de una vez sin error ni efectos
-- extra. Todo corre en una sola transaccion.
-- Pendiente de aplicar en itson-notify-dev (ver 006_README.md).

begin;

-- Si otra sesion tiene tomada una tabla, fallar rapido en lugar de bloquear las
-- lecturas detras de los ALTER.
set local lock_timeout = '5s';

-- 0) Verificar que 001 ya se aplico
do $$
begin
  if to_regclass('public.app_users') is null then
    raise exception '006 requiere la migracion 001 (falta app_users)';
  end if;
end $$;

-- 1) Tablas
create table if not exists classroom_courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  external_course_id text not null,
  name text not null,
  section text,
  course_state text,
  alternate_link text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists classroom_coursework (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  course_id uuid not null references classroom_courses(id) on delete cascade,
  external_coursework_id text not null,
  title text not null,
  description text,
  work_type text,
  state text,
  due_at timestamptz,
  max_points numeric,
  alternate_link text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) Unique de las llaves naturales (solo si no existen todavia)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'classroom_courses_user_course_key'
      and conrelid = 'public.classroom_courses'::regclass
  ) then
    alter table classroom_courses
      add constraint classroom_courses_user_course_key
      unique (user_id, external_course_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'classroom_coursework_course_work_key'
      and conrelid = 'public.classroom_coursework'::regclass
  ) then
    alter table classroom_coursework
      add constraint classroom_coursework_course_work_key
      unique (course_id, external_coursework_id);
  end if;
end $$;

-- 3) Indices
create index if not exists idx_classroom_courses_user_id
  on classroom_courses(user_id);

create index if not exists idx_classroom_coursework_user_first_seen
  on classroom_coursework(user_id, first_seen_at desc);

create index if not exists idx_classroom_coursework_course_id
  on classroom_coursework(course_id);

-- 4) RLS (sin politicas: solo la service_role del backend accede)
alter table classroom_courses    enable row level security;
alter table classroom_coursework enable row level security;

-- 5) Permisos: solo service_role
revoke all on public.classroom_courses, public.classroom_coursework
  from anon, authenticated, service_role;

grant select, insert, update, delete on public.classroom_courses    to service_role;
grant select, insert, update, delete on public.classroom_coursework to service_role;

commit;

-- 6) Rollback (manual, comentado)
-- Borra las tablas y sus datos. Se pierde first_seen_at: la siguiente corrida de
-- ITN-43 debe tratarse como primera corrida para no notificar todas las tareas.
--
-- begin;
-- set local lock_timeout = '5s';
-- drop table if exists classroom_coursework;
-- drop table if exists classroom_courses;
-- commit;

-- 7) Verificacion (despues de aplicar)
--
-- Llaves naturales, esperado: classroom_courses_user_course_key y
-- classroom_coursework_course_work_key
-- select conrelid::regclass as tabla, conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where contype = 'u'
--   and conrelid in ('public.classroom_courses'::regclass, 'public.classroom_coursework'::regclass)
-- order by 1, 2;
--
-- Permisos, esperado: solo service_role, con DELETE,INSERT,SELECT,UPDATE
-- select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in ('classroom_courses', 'classroom_coursework')
--   and grantee in ('service_role', 'anon', 'authenticated')
-- group by table_name, grantee order by table_name, grantee;
--
-- RLS, esperado: rls = true y politicas = 0 en ambas tablas
-- select c.relname, c.relrowsecurity as rls,
--        (select count(*) from pg_policies p
--         where p.schemaname = 'public' and p.tablename = c.relname) as politicas
-- from pg_class c
-- where c.oid in ('public.classroom_courses'::regclass, 'public.classroom_coursework'::regclass);
