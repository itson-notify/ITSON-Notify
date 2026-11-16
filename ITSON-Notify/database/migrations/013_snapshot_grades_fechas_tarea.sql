-- 013 - ITN-56 - Fechas de las tareas de iVirtual en snapshot_grades
-- Supabase / PostgreSQL 15+
--
-- El worker de iVirtual lee mod_assign_get_assignments y une cada tarea con su
-- ítem de calificación por cmid. Por ítem guarda:
--   due_at     fecha de entrega (duedate de Moodle)
--   opens_at   apertura de entregas (allowsubmissionsfromdate)
--   closes_at  cierre / fecha límite (cutoffdate)
-- Las tres son timestamptz nullable: null = la tarea no tiene esa fecha o el ítem
-- no es una tarea (examen, manual, total del curso). itson_api no las usa.
--
-- No hay tablas nuevas: RLS y los grants de snapshot_grades (002, 005) ya cubren
-- las columnas nuevas.
--
-- Orden de aplicación: aplicar ANTES de desplegar el backend de ITN-56. Si el
-- backend corre sin la 013, guarda el snapshot sin fechas y lo registra en el log
-- (fechas_sin_migracion); la extracción de iVirtual no se rompe.
--
-- Requiere 001 y 003. Idempotente: se puede ejecutar más de una vez sin error ni
-- efectos extra. Todo corre en una sola transacción.

begin;

set local lock_timeout = '5s';

-- 0) Verificar dependencias
do $$
begin
  if to_regclass('public.snapshot_grades') is null then
    raise exception '013 requiere la migracion 001 (falta snapshot_grades)';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'snapshot_grades'
      and column_name = 'external_item_id'
  ) then
    raise exception '013 requiere la migracion 003 (falta snapshot_grades.external_item_id)';
  end if;
end $$;

-- 1) Fechas de la tarea
alter table snapshot_grades
  add column if not exists due_at timestamptz,
  add column if not exists opens_at timestamptz,
  add column if not exists closes_at timestamptz;

comment on column snapshot_grades.due_at is
  'ITN-56: fecha de entrega de la tarea de iVirtual (duedate); null = sin fecha o no es tarea';
comment on column snapshot_grades.opens_at is
  'ITN-56: apertura de entregas (allowsubmissionsfromdate); null = sin fecha';
comment on column snapshot_grades.closes_at is
  'ITN-56: cierre de entregas (cutoffdate); null = sin fecha';

commit;

-- 2) Rollback (manual, comentado)
-- Quita las fechas guardadas. El backend de ITN-56 sigue funcionando sin ellas
-- (guarda los snapshots sin fechas y el aviso de tarea nueva no muestra la fecha).
--
-- begin;
-- set local lock_timeout = '5s';
-- alter table snapshot_grades
--   drop column if exists due_at,
--   drop column if exists opens_at,
--   drop column if exists closes_at;
-- commit;

-- 3) Verificación (después de aplicar)
--
-- Columnas nuevas, esperado: tres filas timestamp with time zone, nullable YES
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'snapshot_grades'
--   and column_name in ('due_at', 'opens_at', 'closes_at')
-- order by column_name;
--
-- RLS sigue activo, esperado: true
-- select relrowsecurity from pg_class where oid = 'public.snapshot_grades'::regclass;
