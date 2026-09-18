-- Loo Kooli isteplaani rakenduse esmane andmebaasiskeem
-- Käivita Supabase SQL Editoris ühe korraga.

create type public.user_role as enum ('teacher', 'admin');
create type public.seat_type as enum ('pair', 'single');
create type public.draw_mode as enum ('guided', 'random');

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role public.user_role not null default 'teacher',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_email_lower_idx
  on public.profiles (lower(email));

create table public.school_classes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 50),
  academic_year text not null check (length(trim(academic_year)) between 4 and 20),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (academic_year, name)
);

create table public.students (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.school_classes(id) on delete cascade,
  first_name text not null check (length(trim(first_name)) between 1 and 100),
  last_name text not null check (length(trim(last_name)) between 1 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index students_class_id_idx on public.students(class_id);

create table public.teacher_favorite_classes (
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  class_id uuid not null references public.school_classes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (teacher_id, class_id)
);

create index teacher_favorite_classes_class_id_idx
  on public.teacher_favorite_classes(class_id);

create table public.seating_plans (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  class_id uuid not null references public.school_classes(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  rows smallint not null check (rows between 1 and 12),
  cols smallint not null check (cols between 1 and 12),
  seat_type public.seat_type not null default 'pair',
  mode public.draw_mode not null default 'guided',
  seats jsonb not null default '[]'::jsonb check (jsonb_typeof(seats) = 'array'),
  avoid_pairs jsonb not null default '[]'::jsonb check (jsonb_typeof(avoid_pairs) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index seating_plans_teacher_id_idx on public.seating_plans(teacher_id);
create index seating_plans_class_id_idx on public.seating_plans(class_id);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger school_classes_set_updated_at
before update on public.school_classes
for each row execute function private.set_updated_at();

create trigger students_set_updated_at
before update on public.students
for each row execute function private.set_updated_at();

create trigger seating_plans_set_updated_at
before update on public.seating_plans
for each row execute function private.set_updated_at();

create or replace function private.is_school_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active
      and split_part(lower(p.email), '@', 2) = 'lookool.ee'
  );
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active
      and p.role = 'admin'
      and split_part(lower(p.email), '@', 2) = 'lookool.ee'
  );
$$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(new.email);
  assigned_role public.user_role;
begin
  if normalized_email is null
     or split_part(normalized_email, '@', 2) <> 'lookool.ee' then
    raise exception 'Sisselogimine on lubatud ainult @lookool.ee kontoga.';
  end if;

  assigned_role := case
    when normalized_email = 'taave.proom@lookool.ee'
      then 'admin'::public.user_role
    else 'teacher'::public.user_role
  end;

  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    normalized_email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    assigned_role
  );

  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;
revoke all on function private.is_school_user() from public, anon;
revoke all on function private.is_admin() from public, anon;
revoke all on function private.handle_new_user() from public, anon, authenticated;

grant usage on schema private to authenticated;
grant execute on function private.is_school_user() to authenticated;
grant execute on function private.is_admin() to authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

alter table public.profiles enable row level security;
alter table public.school_classes enable row level security;
alter table public.students enable row level security;
alter table public.teacher_favorite_classes enable row level security;
alter table public.seating_plans enable row level security;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.school_classes from anon, authenticated;
revoke all on table public.students from anon, authenticated;
revoke all on table public.teacher_favorite_classes from anon, authenticated;
revoke all on table public.seating_plans from anon, authenticated;

grant select on table public.profiles to authenticated;
grant select, insert, update, delete on table public.school_classes to authenticated;
grant select, insert, update, delete on table public.students to authenticated;
grant select, insert, update, delete on table public.teacher_favorite_classes to authenticated;
grant select, insert, update, delete on table public.seating_plans to authenticated;

create policy "users read own profile"
on public.profiles for select
to authenticated
using ((select auth.uid()) = id);

create policy "admins read profiles"
on public.profiles for select
to authenticated
using ((select private.is_admin()));

create policy "school users read classes"
on public.school_classes for select
to authenticated
using ((select private.is_school_user()));

create policy "admins insert classes"
on public.school_classes for insert
to authenticated
with check ((select private.is_admin()));

create policy "admins update classes"
on public.school_classes for update
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy "admins delete classes"
on public.school_classes for delete
to authenticated
using ((select private.is_admin()));

create policy "school users read students"
on public.students for select
to authenticated
using ((select private.is_school_user()));

create policy "admins insert students"
on public.students for insert
to authenticated
with check ((select private.is_admin()));

create policy "admins update students"
on public.students for update
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy "admins delete students"
on public.students for delete
to authenticated
using ((select private.is_admin()));

create policy "teachers read own favorites"
on public.teacher_favorite_classes for select
to authenticated
using (
  (select private.is_school_user())
  and (select auth.uid()) = teacher_id
);

create policy "teachers insert own favorites"
on public.teacher_favorite_classes for insert
to authenticated
with check (
  (select private.is_school_user())
  and (select auth.uid()) = teacher_id
);

create policy "teachers delete own favorites"
on public.teacher_favorite_classes for delete
to authenticated
using (
  (select private.is_school_user())
  and (select auth.uid()) = teacher_id
);

create policy "teachers read own plans"
on public.seating_plans for select
to authenticated
using (
  (select private.is_school_user())
  and (select auth.uid()) = teacher_id
);

create policy "teachers insert own plans"
on public.seating_plans for insert
to authenticated
with check (
  (select private.is_school_user())
  and (select auth.uid()) = teacher_id
);

create policy "teachers update own plans"
on public.seating_plans for update
to authenticated
using (
  (select private.is_school_user())
  and (select auth.uid()) = teacher_id
)
with check (
  (select private.is_school_user())
  and (select auth.uid()) = teacher_id
);

create policy "teachers delete own plans"
on public.seating_plans for delete
to authenticated
using (
  (select private.is_school_user())
  and (select auth.uid()) = teacher_id
);
