-- Account settings are for people: the database refuses a password change
-- made by an agent (an OAuth session). TOTP is off in config.toml.
--
-- Auth changes a password in one transaction: it writes the new hash, clears
-- the one-time tokens (reauthentication_token among them), and signs out every
-- other session of the user, or all of them when no session asked (the admin
-- API, a recovery link). So at commit, a user whose only sessions left came
-- from OAuth clients had the change made by one of them.
create function private.refuse_agent_password_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from auth.sessions s
    where s.user_id = new.id and s.oauth_client_id is not null
  ) and not exists (
    select 1 from auth.sessions s
    where s.user_id = new.id and s.oauth_client_id is null
  ) then
    raise exception 'Agents can''t change a password' using errcode = '42501';
  end if;
  return null;
end;
$$;

revoke all on function private.refuse_agent_password_change() from public, anon, authenticated;

-- Checked at commit, once the other sessions are gone. It fires on writes to
-- reauthentication_token, not encrypted_password: a password sign-in that only
-- re-encrypts the stored hash writes encrypted_password alone, and must work.
create constraint trigger refuse_agent_password_change
  after update of reauthentication_token on auth.users
  deferrable initially deferred
  for each row
  when (new.encrypted_password is distinct from old.encrypted_password)
  execute function private.refuse_agent_password_change();
