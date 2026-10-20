import {expect,test} from 'bun:test';
import {importProjectImageURL} from './importURL';

test('a canceled URL import never starts the Supabase request',async () => {
  const controller=new AbortController();
  controller.abort();
  await expect(importProjectImageURL('5f3db947-730e-4cc1-bf82-a093d66f6909','https://example.com/image.png',controller.signal)).rejects.toHaveProperty('name','AbortError');
});
