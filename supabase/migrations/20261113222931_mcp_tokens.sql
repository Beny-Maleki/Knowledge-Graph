-- Personal access tokens for the Claude (MCP) connector.
-- Only a SHA-256 hash is stored; the token itself is shown once when created.
create table public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null check (char_length(token_prefix) between 4 and 16),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz
);
create index mcp_tokens_owner_idx on public.mcp_tokens (owner_id);

alter table public.mcp_tokens enable row level security;

create policy "own tokens: read" on public.mcp_tokens for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "own tokens: create (max 20)" on public.mcp_tokens for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (expires_at is null or expires_at > now())
    and (select count(*) from public.mcp_tokens t where t.owner_id = (select auth.uid())) < 20
  );
create policy "own tokens: revoke" on public.mcp_tokens for delete to authenticated
  using (owner_id = (select auth.uid()));

-- Signed-in users may list their tokens but never read the hashes back.
revoke all on public.mcp_tokens from anon, authenticated;
grant select (id, name, token_prefix, created_at, last_used_at, expires_at) on public.mcp_tokens to authenticated;
grant insert (name, token_hash, token_prefix, expires_at) on public.mcp_tokens to authenticated;
grant delete on public.mcp_tokens to authenticated;
