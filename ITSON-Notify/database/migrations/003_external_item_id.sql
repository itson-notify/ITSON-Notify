-- 003 - ITN-33 - Id externo estable de los grade items de Moodle
-- Supabase / PostgreSQL 15+
-- Los grade items de la API de Moodle traen un id estable, pero itemname puede
-- repetirse dentro de un curso. El unique de 002 (snapshot_id, subject_id,
-- grade_label, partial_period) no distingue items con el mismo nombre, asi que
-- se reemplaza por uno anclado a external_item_id.
-- Requiere 002. Idempotente: se puede ejecutar mas de una vez sin error ni
-- efectos extra. Todo corre en una sola transaccion: si algo falla, no queda
-- nada a medias.
-- Aplicada en itson-notify-dev (requisito de la 004, tambien aplicada ahi).

begin;

-- Si otra sesion tiene tomada la tabla (p. ej. el worker escribiendo), fallar
-- rapido en lugar de bloquear las lecturas detras de este ALTER.
set local lock_timeout = '5s';

-- 0) Verificar que 002 ya se aplico
do $$
begin
  if to_regclass('public.notifications_log') is null then
    raise exception '003 requiere la migracion 002 (falta notifications_log)';
  end if;
end $$;

-- 1) snapshot_grades: id externo del grade item (id de Moodle como texto)
alter table snapshot_grades
  add column if not exists external_item_id text;

-- 2) Reemplazar el unique por (snapshot_id, subject_id, external_item_id)
--
-- Filas existentes sin id (datos de prueba de antes de esta migracion):
-- no se borran. Se les asigna un id sintetico
--   'legacy:' || md5(coalesce(grade_label, '') || '|' || coalesce(partial_period, ''))
-- que conserva exactamente la unicidad del constraint anterior (label + parcial).
-- El prefijo 'legacy:' no puede chocar con ids de Moodle (son numericos) y
-- permite ubicar esas filas. El detector de cambios NO debe usar un snapshot
-- con items 'legacy:' como base de comparacion (ver 003_README.md).
--
-- El backfill y el cambio de constraint solo corren mientras no exista el
-- constraint nuevo, asi una segunda ejecucion no toca filas nuevas.
do $$
declare r record;
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'snapshot_grades_snap_subj_item_key'
      and conrelid = 'public.snapshot_grades'::regclass
  ) then
    update snapshot_grades
      set external_item_id = 'legacy:' || md5(coalesce(grade_label, '') || '|' || coalesce(partial_period, ''))
      where external_item_id is null;

    -- Igual que 002: se quitan todos los unique de la tabla, sin depender del
    -- nombre que tenga el constraint anterior en cada entorno
    for r in
      select conname
      from pg_constraint
      where contype = 'u'
        and conrelid = 'public.snapshot_grades'::regclass
    loop
      execute format('alter table snapshot_grades drop constraint %I', r.conname);
    end loop;

    alter table snapshot_grades
      add constraint snapshot_grades_snap_subj_item_key
      unique nulls not distinct (snapshot_id, subject_id, external_item_id);
  end if;
end $$;

-- Toda calificacion nueva debe traer el id de Moodle: si el worker lo omite,
-- falla con un error claro (not null) y no con un choque de unique entre NULL.
alter table snapshot_grades
  alter column external_item_id set not null;

-- 3) grade_changes: ancla estable del cambio
-- PROPUESTO, REQUIERE APROBACION DEL EQUIPO: comparar snapshots por
-- external_item_id en lugar de field_name/grade_label. Los cambios historicos
-- quedan con NULL (no se reconstruyen).
alter table grade_changes
  add column if not exists external_item_id text;

create index if not exists idx_grade_changes_user_subject_item
  on grade_changes(user_id, subject_id, external_item_id);

-- 4) Busqueda de un item a traves de snapshots
create index if not exists idx_snapshot_grades_subject_item
  on snapshot_grades(subject_id, external_item_id);

commit;

-- 5) Rollback (manual, comentado)
-- Antes de ejecutarlo, revisar que no haya items que el unique anterior
-- rechazaria (mismo nombre y parcial en un snapshot); si esta consulta
-- devuelve filas, hay que resolverlas primero:
--
-- select snapshot_id, subject_id, grade_label, partial_period, count(*)
-- from snapshot_grades
-- group by snapshot_id, subject_id, grade_label, partial_period
-- having count(*) > 1;
--
-- begin;
-- set local lock_timeout = '5s';
-- drop index if exists idx_snapshot_grades_subject_item;
-- drop index if exists idx_grade_changes_user_subject_item;
-- alter table grade_changes drop column if exists external_item_id;
-- alter table snapshot_grades drop constraint if exists snapshot_grades_snap_subj_item_key;
-- alter table snapshot_grades
--   add constraint snapshot_grades_snap_subj_label_partial_key
--   unique nulls not distinct (snapshot_id, subject_id, grade_label, partial_period);
-- alter table snapshot_grades drop column if exists external_item_id;
-- commit;
