-- ITN-26 - Schema de calificaciones y snapshots
-- Supabase / PostgreSQL
-- Objetivo:
-- Guardar usuarios, materias, snapshots de calificaciones por corrida
-- e historial de cambios detectados entre snapshots.

create extension if not exists "pgcrypto";

create table if not exists app_users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    full_name text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists subjects (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references app_users(id) on delete cascade,
    external_subject_id text,
    name text not null,
    teacher_name text,
    period text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, external_subject_id, name, period)
);

create table if not exists grade_snapshots (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references app_users(id) on delete cascade,
    source text not null default 'ivirtual',
    captured_at timestamptz not null default now(),
    raw_payload jsonb,
    created_at timestamptz not null default now()
);

create table if not exists snapshot_grades (
    id uuid primary key default gen_random_uuid(),
    snapshot_id uuid not null references grade_snapshots(id) on delete cascade,
    subject_id uuid not null references subjects(id) on delete cascade,
    grade_label text,
    grade_value numeric(5,2),
    grade_text text,
    partial_period text,
    raw_payload jsonb,
    created_at timestamptz not null default now(),
    unique (snapshot_id, subject_id, grade_label, partial_period)
);

create table if not exists grade_changes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references app_users(id) on delete cascade,
    subject_id uuid references subjects(id) on delete set null,
    previous_snapshot_id uuid references grade_snapshots(id) on delete set null,
    current_snapshot_id uuid references grade_snapshots(id) on delete set null,
    field_name text not null,
    previous_value text,
    current_value text,
    change_type text not null check (change_type in ('created', 'updated', 'deleted')),
    detected_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index if not exists idx_subjects_user_id
    on subjects(user_id);

create index if not exists idx_grade_snapshots_user_captured
    on grade_snapshots(user_id, captured_at desc);

create index if not exists idx_snapshot_grades_snapshot_id
    on snapshot_grades(snapshot_id);

create index if not exists idx_snapshot_grades_subject_id
    on snapshot_grades(subject_id);

create index if not exists idx_grade_changes_user_detected
    on grade_changes(user_id, detected_at desc);

create index if not exists idx_grade_changes_subject_id
    on grade_changes(subject_id);
