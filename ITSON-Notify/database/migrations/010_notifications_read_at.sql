-- 010 - ITN-53 - Estado de lectura de las notificaciones
-- Supabase / PostgreSQL 15+
-- notifications_log tiene una fila por aviso y canal. La API del alumno lista solo
-- las filas de channel = 'log' (ese canal siempre existe, ver buildChannels), asi
-- que read_at solo se escribe en esas filas. NULL significa sin leer.
--
-- Las notificaciones que ya existen quedan sin leer.
-- La columna hereda los grants de la tabla (005): no necesita permisos nuevos. El
-- indice de 002 (user_id, created_at desc) cubre la consulta de la API.
--
-- Requiere 002. Idempotente: se puede ejecutar mas de una vez sin error ni efectos
-- extra. Todo corre en una sola transaccion.
-- Pendiente de aplicar.

begin;

-- Si el worker tiene tomada la tabla, fallar rapido en lugar de bloquear las
-- lecturas detras de este ALTER.
set local lock_timeout = '5s';

-- 0) Verificar que 002 ya se aplico
do $$
begin
  if to_regclass('public.notifications_log') is null then
    raise exception '009 requiere la migracion 002 (falta notifications_log)';
  end if;
end $$;

-- 1) Columna
alter table notifications_log
  add column if not exists read_at timestamptz;

commit;

-- 2) Rollback (manual, comentado)
-- Se pierde lo que cada alumno ya habia leido.
--
-- begin;
-- set local lock_timeout = '5s';
-- alter table notifications_log drop column if exists read_at;
-- commit;

-- 3) Verificacion (despues de aplicar)
-- Esperado: read_at, timestamp with time zone, YES
--
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'notifications_log'
--   and column_name = 'read_at';
