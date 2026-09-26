import { expect, test } from 'bun:test';
import { withSignOutGuards } from './beforeSignOut';

test('rejected logout releases the prepared live editor', async () => {
  let frozen = false;
  await expect(withSignOutGuards([async()=>{frozen=true;return()=>{frozen=false;};}],async()=>{expect(frozen).toBe(true);throw new Error('logout unavailable');})).rejects.toThrow('logout unavailable');
  expect(frozen).toBe(false);
});
test('a later refusal releases earlier prepared guards and never logs out', async () => {
  let released=false;let signedOut=false;
  await expect(withSignOutGuards([async()=>()=>{released=true;},async()=>{throw new Error('dirty');}],async()=>{signedOut=true;})).rejects.toThrow('dirty');
  expect(released).toBe(true);expect(signedOut).toBe(false);
});
test('legacy void guards remain supported',async()=>{
  let signedOut=false;await withSignOutGuards([async()=>{}],async()=>{signedOut=true;});expect(signedOut).toBe(true);
});
