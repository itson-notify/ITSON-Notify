# Migración 006: cursos y tareas de Classroom (ITN-48)

## Qué cambia

- Tabla `classroom_courses`: un curso por estudiante. Llave natural `classroom_courses_user_course_key`
  (`user_id`, `external_course_id`).
- Tabla `classroom_coursework`: una tarea de un curso. Llave natural `classroom_coursework_course_work_key`
  (`course_id`, `external_coursework_id`).
- Borrar un `app_user` borra sus cursos y tareas. Borrar un curso borra sus tareas (`on delete cascade`).
- Índices `classroom_courses(user_id)`, `classroom_coursework(user_id, first_seen_at desc)` y
  `classroom_coursework(course_id)`.
- RLS activado y sin políticas en ambas tablas, como en la 002.
- Permisos `select`, `insert`, `update` y `delete` solo para `service_role`, como en la 005. Además, un `revoke`
  explícito quita los permisos que las tablas nuevas pueden heredar en proyectos creados antes del 30 de octubre
  de 2026, como `itson-notify-dev`: todos los de `anon` y `authenticated`, y `truncate`, `references` y `trigger`
  de `service_role`.
- No hay trigger de `updated_at`, porque el repo no los usa (001 a 005). La app actualiza la columna.
- Todo corre en una transacción con `lock_timeout = '5s'`. Si falla una parte, no queda nada aplicado.
- Si la 001 no está aplicada, la migración se detiene con un error.
- Al final del `.sql` hay un rollback y una verificación comentados.

## Por qué

El detector de tareas nuevas (ITN-43) necesita el estado anterior de Classroom de cada estudiante para comparar
corridas. La persistencia es idempotente, igual que `grade_snapshots`: repetir una corrida no duplica filas.

Solo se guardan datos académicos del propio estudiante, sin tokens, secretos ni `raw_payload`. Por ser datos
personales, solo el backend accede a ellos.

## Contrato para el repositorio y el detector de tareas

- **Upsert de cursos:** `onConflict: "user_id,external_course_id"`.
- **Upsert de tareas:** `onConflict: "course_id,external_coursework_id"`. `user_id` se copia del curso, porque la
  base no valida que coincida.
- **`first_seen_at`:** nunca se envía en el upsert. Solo se escribe al insertar, y si se envía, una tarea conocida
  parece nueva y se vuelve a notificar.
- **`last_seen_at` y `updated_at`:** se envían en cada upsert. Su default solo aplica al insertar.
- **Tarea nueva:** su `first_seen_at` cae dentro de la corrida actual.
- **Primera corrida:** no se notifica, como en el baseline de calificaciones. Tampoco se notifican las tareas ya
  existentes de un curso que aparece después; `classroom_courses.first_seen_at` permite detectarlo.
- **Tarea que deja de verse:** conserva su fila, con un `last_seen_at` antiguo.

## Cómo probarla (primero en `itson-notify-dev`)

1. Respaldo o snapshot del proyecto dev.
2. Evita correrla mientras el backend escribe en `app_users`. Crear las llaves foráneas toma un lock sobre esa
   tabla; si está ocupada, el `lock_timeout` hará fallar la migración sin dejar nada aplicado.
3. Ejecuta `006_classroom_courses_coursework.sql` en el SQL editor de dev.
4. Verifica:
   ```sql
   select conname from pg_constraint
   where contype = 'u'
     and conrelid in ('public.classroom_courses'::regclass, 'public.classroom_coursework'::regclass)
   order by 1;
   -- esperado: classroom_courses_user_course_key, classroom_coursework_course_work_key

   select tablename, indexname from pg_indexes
   where schemaname = 'public' and tablename in ('classroom_courses', 'classroom_coursework')
   order by 1, 2;
   -- esperado: 3 índices en classroom_courses y 4 en classroom_coursework

   select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
   from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('classroom_courses', 'classroom_coursework')
     and grantee in ('service_role', 'anon', 'authenticated')
   group by table_name, grantee order by table_name, grantee;
   -- esperado: solo service_role, con DELETE,INSERT,SELECT,UPDATE en ambas tablas

   select c.relname, c.relrowsecurity as rls,
          (select count(*) from pg_policies p
           where p.schemaname = 'public' and p.tablename = c.relname) as politicas
   from pg_class c
   where c.oid in ('public.classroom_courses'::regclass, 'public.classroom_coursework'::regclass);
   -- esperado: rls = true y politicas = 0 en ambas tablas
   ```
5. Ejecuta la migración otra vez: no debe fallar. Repite las consultas del paso 4: deben dar lo mismo.
6. Corre los casos de aceptación.

## Casos de aceptación

Cada caso corre dentro de una transacción con `rollback`, así que no deja datos. Los casos A, C y D validan con
`raise exception`, así el resultado no depende de que el editor muestre un `select` previo al `rollback`: si
terminan sin error, pasaron.

**A. Insertar dos veces la misma tarea con `on conflict` no crea duplicados (criterio de cierre del ticket)**

Además comprueba que el upsert actualiza la tarea y conserva su `first_seen_at`.

```sql
begin;
with u as (insert into app_users (email) values ('itn48-a@test.local') returning id)
insert into classroom_courses (user_id, external_course_id, name)
select id, 'itn48-curso-a', 'Curso ITN-48' from u;

-- Primera corrida. first_seen_at va en el pasado solo para poder compararlo despues.
insert into classroom_coursework (user_id, course_id, external_coursework_id, title, first_seen_at, last_seen_at)
select user_id, id, 'itn48-tarea-a', 'Titulo original', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
from classroom_courses where external_course_id = 'itn48-curso-a'
on conflict (course_id, external_coursework_id) do update
  set title = excluded.title, last_seen_at = now(), updated_at = now();

-- Segunda corrida: misma tarea, sin first_seen_at.
insert into classroom_coursework (user_id, course_id, external_coursework_id, title)
select user_id, id, 'itn48-tarea-a', 'Titulo editado'
from classroom_courses where external_course_id = 'itn48-curso-a'
on conflict (course_id, external_coursework_id) do update
  set title = excluded.title, last_seen_at = now(), updated_at = now();

do $$
declare total int; fila classroom_coursework;
begin
  select count(*) into total from classroom_coursework where external_coursework_id = 'itn48-tarea-a';
  if total <> 1 then raise exception 'esperado count = 1, obtenido %', total; end if;

  select * into fila from classroom_coursework where external_coursework_id = 'itn48-tarea-a';
  if fila.title <> 'Titulo editado' then raise exception 'el upsert no actualizo title'; end if;
  if fila.first_seen_at <> '2026-01-01T00:00:00Z' then raise exception 'el upsert cambio first_seen_at'; end if;
  if fila.last_seen_at <= fila.first_seen_at then raise exception 'el upsert no actualizo last_seen_at'; end if;
end $$;
rollback;
-- esperado: termina sin error
```

**B. Un insert plano duplicado falla**

```sql
begin;
with u as (insert into app_users (email) values ('itn48-b@test.local') returning id),
     c as (insert into classroom_courses (user_id, external_course_id, name)
           select id, 'itn48-curso-b', 'Curso ITN-48' from u returning id, user_id)
insert into classroom_coursework (user_id, course_id, external_coursework_id, title)
select c.user_id, c.id, 'itn48-tarea-b', v.title
from c, (values ('Tarea'), ('Tarea (repetida)')) as v(title);
-- esperado: ERROR 23505 duplicate key value violates unique constraint "classroom_coursework_course_work_key"
rollback;
```

**C. El mismo `external_coursework_id` en dos cursos distintos se guarda como dos filas**

```sql
begin;
with u as (insert into app_users (email) values ('itn48-c@test.local') returning id),
     c as (insert into classroom_courses (user_id, external_course_id, name)
           select u.id, v.curso, 'Curso ITN-48'
           from u, (values ('itn48-curso-c1'), ('itn48-curso-c2')) as v(curso)
           returning id, user_id)
insert into classroom_coursework (user_id, course_id, external_coursework_id, title)
select user_id, id, 'itn48-tarea-c', 'Tarea' from c;

do $$
declare total int;
begin
  select count(*) into total from classroom_coursework where external_coursework_id = 'itn48-tarea-c';
  if total <> 2 then raise exception 'esperado count = 2, obtenido %', total; end if;
end $$;
rollback;
-- esperado: termina sin error
```

**D. Borrar el `app_user` borra en cascada cursos y tareas**

```sql
begin;
with u as (insert into app_users (email) values ('itn48-d@test.local') returning id),
     c as (insert into classroom_courses (user_id, external_course_id, name)
           select id, 'itn48-curso-d', 'Curso ITN-48' from u returning id, user_id)
insert into classroom_coursework (user_id, course_id, external_coursework_id, title)
select user_id, id, 'itn48-tarea-d', 'Tarea' from c;

delete from app_users where email = 'itn48-d@test.local';

do $$
declare cursos int; tareas int;
begin
  select count(*) into cursos from classroom_courses where external_course_id = 'itn48-curso-d';
  select count(*) into tareas from classroom_coursework where external_coursework_id = 'itn48-tarea-d';
  if cursos <> 0 or tareas <> 0 then
    raise exception 'esperado 0 cursos y 0 tareas, obtenido % y %', cursos, tareas;
  end if;
end $$;
rollback;
-- esperado: termina sin error
```

**E. Un curso duplicado para el mismo estudiante falla**

```sql
begin;
with u as (insert into app_users (email) values ('itn48-e@test.local') returning id)
insert into classroom_courses (user_id, external_course_id, name)
select u.id, 'itn48-curso-e', v.name
from u, (values ('Curso'), ('Curso (repetido)')) as v(name);
-- esperado: ERROR 23505 duplicate key value violates unique constraint "classroom_courses_user_course_key"
rollback;
```
