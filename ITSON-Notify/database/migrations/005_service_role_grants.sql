-- 005 - ITN-28 - Grants explicitos a service_role
-- Supabase / PostgreSQL 15+
-- Desde el 30 de octubre de 2026 Supabase ya no otorga acceso automatico a la
-- Data API en tablas nuevas de public. Ninguna migracion (001 a 004) tenia
-- grants explicitos: hasta ahora dependian de los permisos por defecto.
-- Esta migracion los deja explicitos para que un entorno nuevo funcione igual.
--
-- notifications_log tambien esta aqui: su grant se agrego a la 002 despues de
-- que esa migracion ya se habia aplicado en itson-notify-dev.
--
-- Solo service_role (backend). anon y authenticated no reciben permisos;
-- todas las tablas siguen con RLS activado y sin politicas.
-- Idempotente: un grant repetido no falla ni cambia nada.
-- NO aplicada todavia en ningun entorno.

begin;

grant select, insert, update, delete on public.app_users         to service_role;
grant select, insert, update, delete on public.subjects          to service_role;
grant select, insert, update, delete on public.grade_snapshots   to service_role;
grant select, insert, update, delete on public.snapshot_grades   to service_role;
grant select, insert, update, delete on public.grade_changes     to service_role;
grant select, insert, update, delete on public.notifications_log to service_role;

commit;

-- Opcional, REQUIERE APROBACION DEL EQUIPO (comentado):
-- En itson-notify-dev, anon y authenticated tienen todos los permisos en estas
-- tablas porque se crearon antes del cambio. RLS sin politicas ya les bloquea
-- las filas, pero quitarlos agrega una segunda barrera. Revisar antes que el
-- frontend no lea estas tablas con la anon key.
--
-- begin;
-- revoke all on public.app_users, public.subjects, public.grade_snapshots,
--   public.snapshot_grades, public.grade_changes, public.notifications_log
--   from anon, authenticated;
-- commit;

-- Verificacion (despues de aplicar):
-- select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
-- from information_schema.role_table_grants
-- where table_schema = 'public' and grantee in ('service_role', 'anon', 'authenticated')
-- group by table_name, grantee order by table_name, grantee;
