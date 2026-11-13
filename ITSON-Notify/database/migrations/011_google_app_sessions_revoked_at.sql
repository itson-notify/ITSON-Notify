-- Migración 011 - Marca de revocación en google_app_sessions (ITN-54).
-- El logout ya no borra la sesión: la marca con revoked_at en la misma escritura
-- obligatoria que decide el 204/500. Así, si falla la limpieza Web Push del
-- dispositivo, la marca sobrevive y la purga previa a cada envío borra después
-- las suscripciones de esa sesión. Desconectar sigue borrando las sesiones sin
-- marcarlas, por lo que no afecta el Push.
-- Idempotente: se puede correr más de una vez.
-- Aplicar ANTES de desplegar el código de ITN-54.
BEGIN;

ALTER TABLE public.google_app_sessions
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- La purga corre antes de cada envío Web Push y busca las sesiones revocadas
-- del alumno. Las filas revocadas son pocas y transitorias (la purga las borra),
-- así que un índice parcial se mantiene diminuto y evita recorrer las sesiones
-- vigentes del alumno en cada envío.
CREATE INDEX IF NOT EXISTS idx_google_app_sessions_revoked
  ON public.google_app_sessions (user_id)
  WHERE revoked_at IS NOT NULL;

COMMIT;
