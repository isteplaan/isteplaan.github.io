-- Rühmatöö ja puudujate tugi isteplaanidele.
-- Käivita Supabase SQL Editoris ühe korraga.

alter table public.seating_plans
  add column if not exists activity_type text not null default 'seating'
    check (activity_type in ('seating', 'groups')),
  add column if not exists group_size smallint
    check (group_size is null or group_size between 2 and 12),
  add column if not exists absent_students jsonb not null default '[]'::jsonb
    check (jsonb_typeof(absent_students) = 'array');

