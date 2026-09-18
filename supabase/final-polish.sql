-- Viimistlusringi turvaline profiilinime muutmise funktsioon.
-- Käivita Supabase SQL Editoris ühe korraga.

create or replace function public.update_my_display_name(new_name text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cleaned_name text := trim(new_name);
begin
  if not (select private.is_school_user()) then
    raise exception 'Ligipääs puudub.';
  end if;

  if length(cleaned_name) < 2 or length(cleaned_name) > 100 then
    raise exception 'Nimi peab olema 2–100 tähemärki.';
  end if;

  update public.profiles
  set display_name = cleaned_name
  where id = (select auth.uid());

  return cleaned_name;
end;
$$;

revoke all on function public.update_my_display_name(text) from public, anon;
grant execute on function public.update_my_display_name(text) to authenticated;

