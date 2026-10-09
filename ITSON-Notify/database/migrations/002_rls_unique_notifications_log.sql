-- 002 - RLS, unique con nulos y registro de notificaciones
-- Supabase / PostgreSQL 15+
-- Corrige deficiencias de 001 (sin RLS, unique que no detectan duplicados con NULL)
-- y agrega notifications_log. Ya aplicada en itson-notify-dev.

-- 1) RLS (sin politicas: solo la service_role del backend accede)
alter table app_users        enable row level security;
alter table subjects         enable row level security;
alter table grade_snapshots  enable row level security;
alter table snapshot_grades  enable row level security;
alter table grade_changes    enable row level security;

-- 2) Unique que si detectan duplicados con columnas NULL
do $$
declare r record;
begin
  for r in
    select conrelid::regclass as tbl, conname
    from pg_constraint
    where contype = 'u'
      and conrelid in ('public.subjects'::regclass, 'public.snapshot_grades'::regclass)
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table subjects
  add constraint subjects_user_ext_name_period_key
  unique nulls not distinct (user_id, external_subject_id, name, period);

alter table snapshot_grades
  add constraint snapshot_grades_snap_subj_label_partial_key
  unique nulls not distinct (snapshot_id, subject_id, grade_label, partial_period);

-- 3) Registro de notificaciones (evita duplicados y permite reintentos)
create table if not exists notifications_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  grade_change_id uuid references grade_changes(id) on delete set null,
  channel text not null check (channel in ('log', 'email', 'fcm', 'telegram')),
  payload jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (grade_change_id, channel)
);

create index if not exists idx_notifications_log_user_created
  on notifications_log(user_id, created_at desc);

alter table notifications_log enable row level security;
