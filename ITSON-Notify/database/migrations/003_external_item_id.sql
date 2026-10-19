-- 003 - ITN-33 - Id externo estable de los grade items de Moodle
-- Supabase / PostgreSQL 15+
-- Los grade items de la API de Moodle traen un id estable, pero itemname puede
-- repetirse dentro de un curso. El unique de 002 (snapshot_id, subject_id,
-- grade_label, partial_period) no distingue items con el mismo nombre, asi que
-- se reemplaza por uno anclado a external_item_id.
-- Idempotente: se puede ejecutar mas de una vez sin error ni efectos extra.
-- NO aplicada todavia en ningun entorno.

-- 1) snapshot_grades: id externo del grade item (id de Moodle como texto)
alter table snapshot_grades
  add column if not exists external_item_id text;

-- 2) Reemplazar el unique por (snapshot_id, subject_id, external_item_id)
--
-- Filas existentes sin id (datos de prueba de antes de esta migracion):
-- con NULLS NOT DISTINCT, dos filas con external_item_id NULL en el mismo
-- snapshot y materia chocarian y el constraint no se podria crear. Para no
-- borrar datos, a esas filas se les asigna un id sintetico
--   'legacy:' || md5(coalesce(grade_label, '') || '|' || coalesce(partial_period, ''))
-- que conserva exactamente la unicidad del constraint anterior (label + parcial).
-- El prefijo 'legacy:' no puede chocar con ids de Moodle (son numericos) y
-- permite ubicar y limpiar esas filas despues.
-- El backfill solo corre mientras exista el constraint anterior, para que una
-- segunda ejecucion no toque filas nuevas.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'snapshot_grades_snap_subj_label_partial_key'
      and conrelid = 'public.snapshot_grades'::regclass
  ) then
    update snapshot_grades
      set external_item_id = 'legacy:' || md5(coalesce(grade_label, '') || '|' || coalesce(partial_period, ''))
      where external_item_id is null;

    alter table snapshot_grades
      drop constraint snapshot_grades_snap_subj_label_partial_key;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'snapshot_grades_snap_subj_item_key'
      and conrelid = 'public.snapshot_grades'::regclass
  ) then
    alter table snapshot_grades
      add constraint snapshot_grades_snap_subj_item_key
      unique nulls not distinct (snapshot_id, subject_id, external_item_id);
  end if;
end $$;

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

-- 5) Rollback (manual, comentado)
-- Ojo: volver al unique anterior falla si ya hay dos items con el mismo
-- nombre y parcial en un snapshot; hay que resolver esos duplicados antes.
--
-- drop index if exists idx_snapshot_grades_subject_item;
-- drop index if exists idx_grade_changes_user_subject_item;
-- alter table grade_changes drop column if exists external_item_id;
-- alter table snapshot_grades drop constraint if exists snapshot_grades_snap_subj_item_key;
-- alter table snapshot_grades
--   add constraint snapshot_grades_snap_subj_label_partial_key
--   unique nulls not distinct (snapshot_id, subject_id, grade_label, partial_period);
-- alter table snapshot_grades drop column if exists external_item_id;
