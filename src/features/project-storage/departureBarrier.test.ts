import { expect, test } from 'bun:test';
import { DepartureBarrier, reconnectAfterDeparture } from './departureBarrier';

test('immediate online event waits for selected project completion and coalesces duplicate events',async()=>{
  const barrier=new DepartureBarrier();const finish=barrier.begin();let selected='original';const seen:string[]=[];
  const reconnect=reconnectAfterDeparture(barrier,async()=>{seen.push(selected);});
  const first=reconnect();const second=reconnect();expect(first).toBe(second);
  const nextEffect=reconnectAfterDeparture(barrier,async()=>{seen.push('duplicate effect');});expect(nextEffect()).toBe(first);
  await Promise.resolve();expect(seen).toEqual([]);
  selected='fork';finish();await first;expect(seen).toEqual(['fork']);
});
test('refused departure completion releases recovery and does not let stale finish release a newer departure',async()=>{
  const barrier=new DepartureBarrier();const finish=barrier.begin();finish();const next=barrier.begin();finish();
  let resumed=false;const waiter=barrier.wait().then(()=>{resumed=true;});await Promise.resolve();expect(resumed).toBe(false);next();await waiter;expect(resumed).toBe(true);
});
test('ordinary overlapping departure still refuses; failed reconnect can be retried',async()=>{
  const barrier=new DepartureBarrier();const finish=barrier.begin();expect(()=>barrier.begin()).toThrow('already in progress');finish();
  let attempts=0;const reconnect=reconnectAfterDeparture(barrier,async()=>{if(++attempts===1)throw new Error('offline');});
  await expect(reconnect()).rejects.toThrow('offline');await reconnect();expect(attempts).toBe(2);
});
