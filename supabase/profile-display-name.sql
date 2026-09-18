-- Lubab sisselogitud kasutajal muuta ainult enda profiili kuvatavat nime.
-- Migratsioon on Supabase projektis juba rakendatud.

grant update (display_name) on public.profiles to authenticated;

create policy "users update own profile"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);
