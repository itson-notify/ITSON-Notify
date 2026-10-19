# Migración 003: `external_item_id` (ITN-33)

## Qué cambia

- `snapshot_grades.external_item_id text not null`: el id del grade item de Moodle.
- El unique anterior (snapshot, materia, label, parcial) se reemplaza por `snapshot_grades_snap_subj_item_key`
  (snapshot, materia, external_item_id) con `NULLS NOT DISTINCT`. Se quitan todos los unique de la tabla, como
  hace la 002, así que no depende del nombre que tenga el constraint anterior en cada entorno.
- Las filas existentes sin id reciben `'legacy:' || md5(grade_label|partial_period)`. Así conservan la unicidad
  anterior y no se borra nada.
- Todo corre en una transacción con `lock_timeout = '5s'`. Si falla una parte, no queda nada aplicado. Si el
  worker tiene la tabla tomada, la migración falla rápido en lugar de bloquear lecturas.
- Si la 002 no está aplicada, la migración se detiene con un error.
- `grade_changes.external_item_id text`, más el índice `(user_id, subject_id, external_item_id)`.
  **Propuesto, requiere aprobación del equipo.**
- Índice `snapshot_grades(subject_id, external_item_id)`.
- Al final del `.sql` hay un rollback comentado.

## Por qué

En Moodle, `itemname` puede repetirse dentro de un curso, pero el id del item es estable. Con el unique actual,
dos items con el mismo nombre en un snapshot chocan (o uno pisa al otro). Además, un cambio de nombre se ve
como un borrado más una alta.

## Contrato para el worker y el detector de cambios

- **Worker:** cada fila de `snapshot_grades` debe traer `external_item_id` con el id del grade item de Moodle,
  como texto. Si falta, el insert falla con `23502` (not null).
- **Detector de cambios:** compara ítems por `(subject_id, external_item_id)`, no por `grade_label`. Si el snapshot
  anterior tiene ítems `legacy:%`, no lo uses como base. Toma el primer snapshot con ids reales como línea base
  y no generes notificaciones en esa corrida. Si no, cada ítem aparecería como borrado y creado.

  ```sql
  -- snapshots que no sirven como base
  select distinct snapshot_id from snapshot_grades where external_item_id like 'legacy:%';
  ```

## Cómo probarla (primero en `itson-notify-dev`)

1. Respaldo o snapshot del proyecto dev.
2. Revisa cuántas filas recibirán el id `legacy:`:
   `select count(*) from snapshot_grades;`
3. Detén el worker. Si está escribiendo, el `lock_timeout` hará fallar la migración.
   Ejecuta `003_external_item_id.sql` en el SQL editor de dev. Después vuelve a ejecutarlo: no debe fallar
   ni cambiar nada.
4. Verifica:
   ```sql
   select conname from pg_constraint where conrelid = 'public.snapshot_grades'::regclass and contype = 'u';
   -- esperado: solo snapshot_grades_snap_subj_item_key
   select count(*) from snapshot_grades where external_item_id is null;  -- esperado: 0
   ```
5. Corre los casos de aceptación. Hasta que el equipo apruebe, no la apliques en otro entorno.

## Casos de aceptación

Cada caso corre dentro de una transacción con `rollback`, así que no deja datos.

**A. Dos items con el mismo nombre en un curso se guardan como filas distintas**

```sql
begin;
with u as (insert into app_users (email) values ('itn33-a@test.local') returning id),
     s as (insert into subjects (user_id, name) select id, 'Materia ITN-33' from u returning id, user_id),
     g as (insert into grade_snapshots (user_id) select user_id from s returning id)
insert into snapshot_grades (snapshot_id, subject_id, grade_label, partial_period, grade_value, external_item_id)
select g.id, s.id, 'Tarea', 'P1', v.val, v.item
from g, s, (values (90.00, '101'), (75.00, '102')) as v(val, item);

select grade_label, external_item_id, grade_value
from snapshot_grades where grade_label = 'Tarea' and external_item_id in ('101', '102');
-- esperado: 2 filas
rollback;
```

**B. Reinsertar el mismo `external_item_id` en el mismo snapshot falla**

```sql
begin;
with u as (insert into app_users (email) values ('itn33-b@test.local') returning id),
     s as (insert into subjects (user_id, name) select id, 'Materia ITN-33' from u returning id, user_id),
     g as (insert into grade_snapshots (user_id) select user_id from s returning id)
insert into snapshot_grades (snapshot_id, subject_id, grade_label, external_item_id)
select g.id, s.id, v.label, '201'
from g, s, (values ('Examen'), ('Examen (renombrado)')) as v(label);
-- esperado: ERROR 23505 duplicate key value violates unique constraint "snapshot_grades_snap_subj_item_key"
rollback;
```

**C. Una calificación sin `external_item_id` se rechaza**

```sql
begin;
with u as (insert into app_users (email) values ('itn33-c@test.local') returning id),
     s as (insert into subjects (user_id, name) select id, 'Materia ITN-33' from u returning id, user_id),
     g as (insert into grade_snapshots (user_id) select user_id from s returning id)
insert into snapshot_grades (snapshot_id, subject_id, grade_label)
select g.id, s.id, 'Sin id' from g, s;
-- esperado: ERROR 23502 null value in column "external_item_id" violates not-null constraint
rollback;
```
