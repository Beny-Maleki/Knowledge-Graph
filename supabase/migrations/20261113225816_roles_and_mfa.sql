-- Roles: new accounts start as 'pending' (no cloud access) until an admin approves them.
alter table public.profiles
  add column role text not null default 'pending' check (role in ('pending', 'member', 'admin'));

-- Users may edit their display name but never their own role.
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Does the current session have a verified second factor (or need one)?
create function public.session_mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified'
      );
$$;

-- Cloud access: approved members; admins only in a 2FA-verified (aal2) session;
-- anyone who enabled 2FA must use it.
create function public.has_cloud_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and (
        (p.role = 'member' and public.session_mfa_ok())
        or (p.role = 'admin' and coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2')
      )
  );
$$;

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
      and coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
  );
$$;

revoke execute on function public.session_mfa_ok(), public.has_cloud_access(), public.is_admin() from public, anon;
grant execute on function public.session_mfa_ok(), public.has_cloud_access(), public.is_admin() to authenticated;

-- Restrictive policies are ANDed with the existing owner-only policies.
create policy "requires cloud access" on public.workspaces as restrictive for all to authenticated
  using ((select public.has_cloud_access())) with check ((select public.has_cloud_access()));
create policy "requires cloud access" on public.kg_nodes as restrictive for all to authenticated
  using ((select public.has_cloud_access())) with check ((select public.has_cloud_access()));
create policy "requires cloud access" on public.kg_links as restrictive for all to authenticated
  using ((select public.has_cloud_access())) with check ((select public.has_cloud_access()));
create policy "requires cloud access" on public.mcp_tokens as restrictive for all to authenticated
  using ((select public.has_cloud_access())) with check ((select public.has_cloud_access()));

-- ---------- admin API (callable only by an admin in a 2FA session) ----------

create function public.admin_list_users()
returns table (
  id uuid, email text, display_name text, role text, created_at timestamptz,
  last_sign_in_at timestamptz, email_confirmed boolean, mfa_enabled boolean,
  workspaces bigint, pages bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin privileges (with two-factor authentication) required' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, p.display_name, coalesce(p.role, 'pending'), u.created_at, u.last_sign_in_at,
           u.email_confirmed_at is not null,
           exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified'),
           (select count(*) from public.workspaces w where w.owner_id = u.id),
           (select count(*) from public.kg_nodes n where n.owner_id = u.id and not n.deleted)
    from auth.users u
    left join public.profiles p on p.id = u.id
    order by u.created_at desc;
end;
$$;

create function public.admin_set_role(target uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin privileges (with two-factor authentication) required' using errcode = '42501';
  end if;
  if new_role not in ('pending', 'member', 'admin') then
    raise exception 'invalid role %', new_role;
  end if;
  if new_role <> 'admin'
     and exists (select 1 from public.profiles where id = target and role = 'admin')
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'cannot remove the last admin';
  end if;
  update public.profiles set role = new_role where id = target;
  if not found then
    raise exception 'no such user';
  end if;
end;
$$;

create function public.admin_delete_user(target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin privileges (with two-factor authentication) required' using errcode = '42501';
  end if;
  if target = (select auth.uid()) then
    raise exception 'use “Delete account” to delete your own account';
  end if;
  delete from auth.users where id = target;
end;
$$;

revoke execute on function public.admin_list_users(), public.admin_set_role(uuid, text), public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_list_users(), public.admin_set_role(uuid, text), public.admin_delete_user(uuid) to authenticated;
