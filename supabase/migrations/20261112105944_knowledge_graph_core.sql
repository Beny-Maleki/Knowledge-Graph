-- Profiles: one per auth user
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Workspaces: a user can keep several separate knowledge graphs
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'My knowledge' check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workspaces_owner_idx on public.workspaces (owner_id);

-- Pages and relations, one row each, so sync is incremental.
-- `deleted` rows are tombstones so other devices learn about deletions.
create table public.kg_nodes (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint kg_nodes_size check (octet_length(data::text) <= 5000000)
);
create index kg_nodes_sync_idx on public.kg_nodes (workspace_id, updated_at);
create index kg_nodes_owner_idx on public.kg_nodes (owner_id);

create table public.kg_links (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint kg_links_size check (octet_length(data::text) <= 20000)
);
create index kg_links_sync_idx on public.kg_links (workspace_id, updated_at);
create index kg_links_owner_idx on public.kg_links (owner_id);

-- Server-side timestamps drive the sync cursor
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before insert or update on public.profiles for each row execute function public.touch_updated_at();
create trigger workspaces_touch before insert or update on public.workspaces for each row execute function public.touch_updated_at();
create trigger kg_nodes_touch before insert or update on public.kg_nodes for each row execute function public.touch_updated_at();
create trigger kg_links_touch before insert or update on public.kg_links for each row execute function public.touch_updated_at();

-- Create a profile automatically for every new user
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(left(new.raw_user_meta_data ->> 'display_name', 80), split_part(new.email, '@', 1)));
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Let signed-in users delete their own account (cascades to all their data)
create function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Row level security: every row is visible only to its owner
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.kg_nodes enable row level security;
alter table public.kg_links enable row level security;

create policy "own profile: read" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile: update" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "own workspaces: read" on public.workspaces for select to authenticated using (owner_id = (select auth.uid()));
create policy "own workspaces: create" on public.workspaces for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "own workspaces: update" on public.workspaces for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own workspaces: delete" on public.workspaces for delete to authenticated using (owner_id = (select auth.uid()));

create policy "own nodes: read" on public.kg_nodes for select to authenticated using (owner_id = (select auth.uid()));
create policy "own nodes: create" on public.kg_nodes for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy "own nodes: update" on public.kg_nodes for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy "own nodes: delete" on public.kg_nodes for delete to authenticated using (owner_id = (select auth.uid()));

create policy "own links: read" on public.kg_links for select to authenticated using (owner_id = (select auth.uid()));
create policy "own links: create" on public.kg_links for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy "own links: update" on public.kg_links for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy "own links: delete" on public.kg_links for delete to authenticated using (owner_id = (select auth.uid()));

-- Data API access: only signed-in users, never anonymous visitors
revoke all on public.profiles, public.workspaces, public.kg_nodes, public.kg_links from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.workspaces, public.kg_nodes, public.kg_links to authenticated;
