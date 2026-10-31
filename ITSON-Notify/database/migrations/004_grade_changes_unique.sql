-- 004 - ITN-24 - Unique de la llave natural de grade_changes
-- Supabase / PostgreSQL 15+
-- gradeChangeService.detectChanges inserta ignorando duplicados segun la llave
-- (previous_snapshot_id, current_snapshot_id, subject_id, external_item_id,
-- field_name) (ver backend/src/services/README.md). Sin un unique sobre esas
-- columnas, correr el detector dos veces sobre el mismo par de snapshots
-- duplica filas y vuelve a notificar.
-- Las cuatro primeras columnas aceptan NULL (FK con on delete set null, y
-- external_item_id es NULL en cambios historicos), asi que se usa
-- nulls not distinct, como en 002 y 003.
-- Requiere 003. Idempotente: se puede ejecutar mas de una vez sin error ni
-- efectos extra. Todo corre en una sola transaccion.
-- No crea tablas: no necesita grants nuevos.
-- Aplicada en itson-notify-dev el 21/10/2026

-- 0) Antes de aplicar: filas duplicadas que impedirian crear el unique.
-- group by trata los NULL como iguales, igual que nulls not distinct.
-- Si devuelve filas, hay que resolverlas primero (no se borran aqui):
--
-- select previous_snapshot_id, current_snapshot_id, subject_id,
--        external_item_id, field_name, count(*), array_agg(id order by created_at) as ids
-- from grade_changes
-- group by previous_snapshot_id, current_snapshot_id, subject_id,
--          external_item_id, field_name
-- having count(*) > 1;

begin;

-- Si el worker tiene tomada la tabla, fallar rapido en lugar de bloquear
-- las lecturas detras de este ALTER.
set local lock_timeout = '5s';

-- 1) Verificar que 003 ya se aplico
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'grade_changes'
      and column_name = 'external_item_id'
  ) then
    raise exception '004 requiere la migracion 003 (falta grade_changes.external_item_id)';
  end if;
end $$;

-- 2) Unique de la llave natural (solo si no existe todavia)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'grade_changes_natural_key'
      and conrelid = 'public.grade_changes'::regclass
  ) then
    alter table grade_changes
      add constraint grade_changes_natural_key
      unique nulls not distinct (previous_snapshot_id, current_snapshot_id,
                                 subject_id, external_item_id, field_name);
  end if;
end $$;

commit;

-- 3) Rollback (manual, comentado)
--
-- begin;
-- set local lock_timeout = '5s';
-- alter table grade_changes drop constraint if exists grade_changes_natural_key;
-- commit;
