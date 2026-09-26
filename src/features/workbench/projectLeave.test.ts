import { describe, expect, test } from 'bun:test';
import { prepareProjectLeave } from './projectLeave';
import type { OperationSession, OperationState } from './operationSession';

function fixture(state: Partial<OperationState> = {}) {
  let frozen = false; let writes = 0;
  const current = { dirty: false, pending: false, saving: false, reconciled: true, ...state };
  const session: OperationSession = { state: () => current, freeze: () => { frozen = true; }, release: () => { frozen = false; }, persistDraft: async () => { writes++; } };
  return { session, current, sessions: new Map([['note.mdx',session]]), frozen: () => frozen, writes: () => writes };
}
describe('live project departure', () => {
  test('existing move recovery lock is neither frozen again nor released on refused departure',async()=>{
    const f=fixture();f.session.freeze();let freezes=0;let releases=0;
    const session={...f.session,freeze:()=>{freezes++;},release:()=>{releases++;}};
    await expect(prepareProjectLeave(new Map([['note.mdx',session]]),true,async()=>{},()=> 'Retry recovery')).rejects.toThrow('Retry recovery');
    expect(freezes).toBe(0);expect(releases).toBe(0);expect(f.frozen()).toBe(true);
  });
  test('dirty edits without durable drafts refuse without saving, and release', async () => {
    const f = fixture({dirty:true}); let flushed = false;
    await expect(prepareProjectLeave(f.sessions,false,async()=>{flushed=true;})).rejects.toThrow('unsaved changes');
    expect(f.writes()).toBe(0); expect(flushed).toBe(false); expect(f.frozen()).toBe(false);
  });
  test.each(['pending','saving'] as const)('%s live edit blocks even with a clean tab flag', async key => {
    const f = fixture({[key]:true});
    await expect(prepareProjectLeave(f.sessions,true,async()=>{})).rejects.toThrow('in progress'); expect(f.frozen()).toBe(false);
  });
  test('unreconciled view refuses', async()=>{
    const f=fixture({reconciled:false}); await expect(prepareProjectLeave(f.sessions,true,async()=>{})).rejects.toThrow('Save or reload');
  });
  test('shared current draft is explicitly persisted before flush and leave',async()=>{
    const f=fixture({dirty:true}); const order:string[]=[];
    f.session.persistDraft=async()=>{expect(f.frozen()).toBe(true);order.push('current snapshot');};
    const release=await prepareProjectLeave(f.sessions,true,async()=>{order.push('IDB complete');});
    expect(order).toEqual(['current snapshot','IDB complete']);expect(f.frozen()).toBe(true);release();expect(f.frozen()).toBe(false);
    f.session.freeze();release();expect(f.frozen()).toBe(true);
  });
  test('quota or flush rejection retains the session and restores editing',async()=>{
    const f=fixture({dirty:true});
    await expect(prepareProjectLeave(f.sessions,true,async()=>{throw new Error('QuotaExceededError');})).rejects.toThrow('QuotaExceededError');
    expect(f.current.dirty).toBe(true);expect(f.frozen()).toBe(false);
  });
  test('live state is rechecked after asynchronous durability work',async()=>{
    const f=fixture();
    await expect(prepareProjectLeave(f.sessions,true,async()=>{f.current.pending=true;})).rejects.toThrow('in progress');expect(f.frozen()).toBe(false);
  });
});
