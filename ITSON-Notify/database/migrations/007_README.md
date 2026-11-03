# Migración 007: credenciales cifradas por estudiante (ITN-36)

## Qué cambia

- Tabla `student_credentials`: una credencial por estudiante, portal y tipo. Llave natural
  `student_credentials_user_portal_kind_key` (`user_id`, `portal`, `kind`).
- `ciphertext`, `nonce` (12 bytes) y `auth_tag` (16 bytes) van en columnas `bytea` separadas. Los checks de
  longitud también detectan un valor mal codificado, como base64 guardado como texto.
- `kind` admite `ivirtual_token`, `google_refresh_token` e `ivirtual_password`. Un check amarra cada `kind` con su
  `portal`.
- `ivirtual_password` es el **último recurso** para el fallback de Playwright: solo se admite en el esquema y la
  API del backend todavía lo rechaza.
- `status` es `active` o `needs_relink`. `key_version` indica con qué llave se cifró la fila.
- Borrar un `app_user` borra sus credenciales (`on delete cascade`).
- RLS activado y sin políticas, como en la 002. Permisos `select`, `insert`, `update` y `delete` solo para
  `service_role`, con el mismo `revoke` previo de la 006.
- No hay índice extra: el unique ya cubre las búsquedas por `user_id`. No hay trigger de `updated_at`: la app
  actualiza la columna.
- Todo corre en una transacción con `lock_timeout = '5s'`. Si la 001 no está aplicada, la migración se detiene.
- Al final del `.sql` hay un rollback y una verificación comentados.

## Por qué

El worker necesita el token de cada estudiante para consultar sus portales. Con la tabla cifrada, una fuga de la
base no revela tokens sin la llave maestra, que solo existe en el servicio backend.

## Contrato para el repositorio

- **Upsert:** `onConflict: "user_id,portal,kind"`. Debe enviar `status: "active"`, `updated_at` y `key_version`:
  volver a vincular reactiva una cuenta marcada.
- **`bytea`:** por PostgREST se envía y se recibe como texto hexadecimal con prefijo `\x`. Un `Buffer` no se puede
  mandar tal cual: `JSON.stringify` lo convierte en un objeto.
- **AAD:** el descifrado usa `user_id:portal:kind`. Una fila copiada a otro estudiante o tipo no se puede descifrar.

## Cómo probarla (primero en `itson-notify-dev`)

1. Respaldo o snapshot del proyecto dev.
2. Evita correrla mientras el backend escribe en `app_users`. Crear la llave foránea toma un lock sobre esa tabla;
   si está ocupada, el `lock_timeout` hará fallar la migración sin dejar nada aplicado.
3. Ejecuta `007_student_credentials.sql` en el SQL editor de dev.
4. Verifica:
   ```sql
   select grantee, string_agg(privilege_type, ',' order by privilege_type)
   from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'student_credentials'
     and grantee in ('service_role', 'anon', 'authenticated')
   group by grantee order by grantee;
   -- esperado: solo service_role, con DELETE,INSERT,SELECT,UPDATE

   select c.relrowsecurity as rls,
          (select count(*) from pg_policies p
           where p.schemaname = 'public' and p.tablename = c.relname) as politicas
   from pg_class c
   where c.oid = 'public.student_credentials'::regclass;
   -- esperado: rls = true y politicas = 0
   ```
5. Ejecuta la migración otra vez: no debe fallar. Repite las consultas del paso 4: deben dar lo mismo.
6. Corre los casos de aceptación.
7. Con el backend apuntando a dev y `CREDENTIALS_ENCRYPTION_KEY` configurada, haz `PUT` y
   `POST /internal/credentials/get` con un secreto inventado y confirma que devuelve el mismo texto. Es la única
   prueba del paso de `bytea` por PostgREST contra Supabase real. Después bórralo con `DELETE`.

## Casos de aceptación

Cada caso corre dentro de una transacción con `rollback`, así que no deja datos. Los valores `bytea` son
inventados: no hace falta cifrar nada para probar el esquema.

**A. Dos credenciales del mismo estudiante, portal y tipo fallan**

```sql
begin;
with u as (insert into app_users (email) values ('itn36-a@test.local') returning id)
insert into student_credentials (user_id, portal, kind, ciphertext, nonce, auth_tag)
select u.id, 'ivirtual', 'ivirtual_token', v.c, decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex')
from u, (values ('\x01'::bytea), ('\x02'::bytea)) as v(c);
-- esperado: ERROR 23505 duplicate key value violates unique constraint "student_credentials_user_portal_kind_key"
rollback;
```

**B. Un `kind` de otro portal se rechaza**

```sql
begin;
with u as (insert into app_users (email) values ('itn36-b@test.local') returning id)
insert into student_credentials (user_id, portal, kind, ciphertext, nonce, auth_tag)
select id, 'google_classroom', 'ivirtual_token', '\x01', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex')
from u;
-- esperado: ERROR 23514 violates check constraint "student_credentials_portal_kind_check"
rollback;
```

**C. Un nonce de otra longitud se rechaza**

```sql
begin;
with u as (insert into app_users (email) values ('itn36-c@test.local') returning id)
insert into student_credentials (user_id, portal, kind, ciphertext, nonce, auth_tag)
select id, 'ivirtual', 'ivirtual_token', '\x01', '\x00', decode(repeat('00', 16), 'hex')
from u;
-- esperado: ERROR 23514 violates check constraint "student_credentials_nonce_length_check"
rollback;
```

**D. Borrar el `app_user` borra sus credenciales**

```sql
begin;
with u as (insert into app_users (email) values ('itn36-d@test.local') returning id)
insert into student_credentials (user_id, portal, kind, ciphertext, nonce, auth_tag)
select id, 'ivirtual', 'ivirtual_token', '\x01', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex')
from u;

delete from app_users where email = 'itn36-d@test.local';

do $$
declare total int;
begin
  select count(*) into total from student_credentials c
  where not exists (select 1 from app_users u where u.id = c.user_id);
  if total <> 0 then raise exception 'quedaron % credenciales huerfanas', total; end if;
  if exists (select 1 from student_credentials where ciphertext = '\x01'::bytea) then
    raise exception 'la credencial de prueba no se borro';
  end if;
end $$;
rollback;
-- esperado: termina sin error
```
