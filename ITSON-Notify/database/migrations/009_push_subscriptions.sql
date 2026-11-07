-- Migración 009 - Suscripciones Web Push por dispositivo del alumno.
-- Cada endpoint pertenece exclusivamente a un alumno (UNIQUE(endpoint)):
-- si otra cuenta inicia sesión en el mismo navegador y registra el mismo
-- endpoint, la suscripción se reasigna al nuevo titular evitando alertas cruzadas.
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
  ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.push_subscriptions FROM public, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO service_role;
