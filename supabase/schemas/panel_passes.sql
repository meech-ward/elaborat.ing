-- Passes for the app in a chat's panel (docs/architecture.md, Frontend
-- hosting: the app in a chat's panel). The panel's view gets a pass from the
-- MCP server, which mints it with the person's own token, and puts it in the
-- framed page's address. The app in the panel redeems it once, with its own
-- sign-in, before it shows any project, so only a page this site's own server
-- set up opens there. A pass is 32 random bytes, sent as 64 hex characters;
-- only its SHA-256 hash is kept. It lasts 5 minutes and works once.

create table private.panel_passes (
  hash bytea primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint panel_passes_hash_length check (octet_length(hash) = 32)
);

create index panel_passes_user_id_idx on private.panel_passes (user_id, created_at);
create index panel_passes_expires_at_idx on private.panel_passes (expires_at);

alter table private.panel_passes enable row level security;

revoke all on table private.panel_passes from anon, authenticated;

-- A new pass for the caller. Expired and used passes go first, and a person
-- keeps at most 10 that can still be used: minting another drops the oldest.
create function public.mint_panel_pass()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  pass bytea := extensions.gen_random_bytes(32);
begin
  delete from private.panel_passes p
  where p.expires_at <= now()
    or (p.user_id = uid and p.used_at is not null);

  delete from private.panel_passes p
  where p.hash in (
    select k.hash
    from private.panel_passes k
    where k.user_id = uid
    order by k.created_at desc, k.hash
    offset 9
  );

  insert into private.panel_passes (hash, user_id, expires_at)
  values (sha256(pass), uid, now() + interval '5 minutes');

  return encode(pass, 'hex');
end;
$$;

revoke all on function public.mint_panel_pass() from public, anon;
grant execute on function public.mint_panel_pass() to authenticated;

-- True when `pass` is the caller's, unexpired and unused, and marks it used.
-- False for anything else (no such pass, another person's, expired, used, not
-- a pass at all, or a token issued to an agent: the panel runs with the
-- person's own sign-in).
create function public.redeem_panel_pass(pass text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null or private.is_oauth_client() or redeem_panel_pass.pass is null
    or redeem_panel_pass.pass !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  update private.panel_passes p
  set used_at = now()
  where p.hash = sha256(decode(redeem_panel_pass.pass, 'hex'))
    and p.user_id = uid
    and p.used_at is null
    and p.expires_at > now();

  return found;
end;
$$;

revoke all on function public.redeem_panel_pass(text) from public, anon;
grant execute on function public.redeem_panel_pass(text) to authenticated;
