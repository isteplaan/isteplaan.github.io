-- Admini kasutajavaade ja minimaalne kasutusstatistika.
-- Käivita Supabase SQL Editoris ühe korraga.

alter table public.profiles
  add column if not exists last_seen_at timestamptz;

create or replace function public.touch_last_seen()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.profiles
  set last_seen_at = now()
  where id = (select auth.uid())
    and (select private.is_school_user());
$$;

create or replace function public.admin_user_overview()
returns table (
  user_id uuid,
  email text,
  display_name text,
  role public.user_role,
  active boolean,
  joined_at timestamptz,
  last_seen_at timestamptz,
  favorite_classes jsonb,
  saved_classes jsonb,
  plan_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.email,
    p.display_name,
    p.role,
    p.active,
    p.created_at,
    p.last_seen_at,
    coalesce(f.classes, '[]'::jsonb),
    coalesce(s.classes, '[]'::jsonb),
    coalesce(s.plan_count, 0)
  from public.profiles p
  left join lateral (
    select jsonb_agg(c.name order by c.name) as classes
    from public.teacher_favorite_classes tf
    join public.school_classes c on c.id = tf.class_id
    where tf.teacher_id = p.id
  ) f on true
  left join lateral (
    select
      jsonb_agg(distinct c.name) as classes,
      count(*) as plan_count
    from public.seating_plans sp
    join public.school_classes c on c.id = sp.class_id
    where sp.teacher_id = p.id
  ) s on true
  where (select private.is_admin())
  order by coalesce(p.last_seen_at, p.created_at) desc;
$$;

revoke all on function public.touch_last_seen() from public, anon;
revoke all on function public.admin_user_overview() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;
grant execute on function public.admin_user_overview() to authenticated;
