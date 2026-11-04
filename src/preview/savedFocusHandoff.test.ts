import {describe,expect,test} from 'bun:test';
import {SavedFocusLease} from './savedFocusHandoff';

describe('saved-copy focus lease', () => {
  test('only a focused capture and its matching ready render can restore once', () => {
    const lease = new SavedFocusLease();
    lease.prepare('note',{id:2,capture:true},false);
    expect(lease.take('note',{id:2,capture:false})).toBe(false);
    lease.prepare('note',{id:2,capture:true},true);
    lease.prepare('note',{id:2,capture:true},false);
    lease.prepare('note',{id:2,capture:false},false);
    expect(lease.take('note',{id:2,capture:false})).toBe(true);
    expect(lease.take('note',{id:2,capture:false})).toBe(false);
  });

  test('user activity, a different saved copy, session or source scope cancels focus', () => {
    const lease = new SavedFocusLease();
    for (const invalidate of [
      () => lease.cancel(),
      () => lease.prepare('note',{id:3,capture:false},false),
      () => lease.prepare('other',{id:2,capture:false},false),
      () => lease.prepare('note',undefined,false),
    ]) {
      lease.prepare('note',{id:2,capture:true},true);
      invalidate();
      expect(lease.take('note',{id:2,capture:false})).toBe(false);
    }
  });
});
