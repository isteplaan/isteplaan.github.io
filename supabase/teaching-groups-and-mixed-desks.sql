-- Hübriidlaudade ja õpetaja privaatsete õpperühmade tugi.
-- Migratsioon on Supabase projektis juba rakendatud; fail säilitab skeemi muudatuse repositooriumis.

alter type public.seat_type add value if not exists 'mixed';

create table if not exists public.teaching_groups (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teaching_group_students (
  group_id uuid not null references public.teaching_groups(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  primary key (group_id, student_id)
);

create index if not exists teaching_groups_teacher_id_idx on public.teaching_groups(teacher_id);
create index if not exists teaching_group_students_student_id_idx on public.teaching_group_students(student_id);

alter table public.teaching_groups enable row level security;
alter table public.teaching_group_students enable row level security;

grant select, insert, update, delete on public.teaching_groups to authenticated;
grant select, insert, update, delete on public.teaching_group_students to authenticated;

create policy "teachers read own teaching groups" on public.teaching_groups for select to authenticated
using ((select private.is_school_user()) and (select auth.uid()) = teacher_id);
create policy "teachers insert own teaching groups" on public.teaching_groups for insert to authenticated
with check ((select private.is_school_user()) and (select auth.uid()) = teacher_id);
create policy "teachers update own teaching groups" on public.teaching_groups for update to authenticated
using ((select private.is_school_user()) and (select auth.uid()) = teacher_id)
with check ((select private.is_school_user()) and (select auth.uid()) = teacher_id);
create policy "teachers delete own teaching groups" on public.teaching_groups for delete to authenticated
using ((select private.is_school_user()) and (select auth.uid()) = teacher_id);

create policy "teachers read own teaching group members" on public.teaching_group_students for select to authenticated
using ((select private.is_school_user()) and exists (
  select 1 from public.teaching_groups g where g.id = group_id and g.teacher_id = (select auth.uid())
));
create policy "teachers insert own teaching group members" on public.teaching_group_students for insert to authenticated
with check ((select private.is_school_user()) and exists (
  select 1 from public.teaching_groups g where g.id = group_id and g.teacher_id = (select auth.uid())
));
create policy "teachers delete own teaching group members" on public.teaching_group_students for delete to authenticated
using ((select private.is_school_user()) and exists (
  select 1 from public.teaching_groups g where g.id = group_id and g.teacher_id = (select auth.uid())
));

alter table public.seating_plans
  add column if not exists teaching_group_id uuid references public.teaching_groups(id) on delete cascade,
  alter column class_id drop not null;

alter table public.seating_plans drop constraint if exists seating_plans_scope_check;
alter table public.seating_plans add constraint seating_plans_scope_check
check ((class_id is not null)::integer + (teaching_group_id is not null)::integer = 1);

create index if not exists seating_plans_teaching_group_id_idx on public.seating_plans(teaching_group_id);
