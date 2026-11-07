-- Migración 009 - Suscripciones Web Push por dispositivo del alumno.
-- Idempotente: si una versión previa creó la tabla con UNIQUE(user_id, endpoint),
-- depura duplicados por endpoint conservando el registro más reciente, agrega
-- session_id para aislar el cierre de sesión por dispositivo y migra la
-- restricción a UNIQUE(endpoint).
BEGIN;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  session_id TEXT,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Si la tabla existía con UNIQUE(user_id, endpoint), conserva solo el titular
-- más reciente de cada endpoint antes de imponer UNIQUE(endpoint).
DELETE FROM public.push_subscriptions a
USING public.push_subscriptions b
WHERE a.endpoint = b.endpoint
  AND a.id <> b.id
  AND (
    a.updated_at < b.updated_at
    OR (a.updated_at = b.updated_at AND a.id < b.id)
  );

ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_user_endpoint_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'push_subscriptions_endpoint_unique'
      AND conrelid = 'public.push_subscriptions'::regclass
  ) THEN
    ALTER TABLE public.push_subscriptions
      ADD CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
  ON public.push_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_session_id
  ON public.push_subscriptions (user_id, session_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.push_subscriptions FROM public, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO service_role;

COMMIT;
