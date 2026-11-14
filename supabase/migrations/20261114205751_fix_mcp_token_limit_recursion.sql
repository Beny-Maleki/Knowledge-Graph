-- The token-count check queried mcp_tokens from inside its own policy, which
-- Postgres rejects as infinite recursion. Count through a SECURITY DEFINER function.
create function public.my_mcp_token_count()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from public.mcp_tokens where owner_id = (select auth.uid());
$$;
revoke execute on function public.my_mcp_token_count() from public, anon;
grant execute on function public.my_mcp_token_count() to authenticated;

drop policy "own tokens: create (max 20)" on public.mcp_tokens;
create policy "own tokens: create (max 20)" on public.mcp_tokens for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (expires_at is null or expires_at > now())
    and (select public.my_mcp_token_count()) < 20
  );
