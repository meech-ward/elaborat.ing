import { expect, test } from 'bun:test';
import { checkParentMessage } from './protocol';

const session = 'dimension-session';
const size = {key:'images/detail.svg',width:400,height:300};
const message = {kind:'image-dimensions',session,revision:3,sizes:[size]};
const check = (data: unknown, activeSession: string | null = session) => checkParentMessage({data,source:{},activeSession});

test('bounded pending image dimensions follow an established session without executing code', () => {
  expect(check(message).ok).toBe(true);
  expect(check(message,null).ok).toBe(false);
  expect(check(message,'another-session').ok).toBe(false);
  expect(check({...message,code:'untrusted'}).ok).toBe(false);
});

test('pending dimensions reject excessive pixels, malformed keys and unbounded batches', () => {
  for (const invalid of [{...size,width:0},{...size,height:1.5},{...size,width:4000,height:4000},{...size,key:''}]) {
    expect(check({...message,sizes:[invalid]}).ok).toBe(false);
  }
  expect(check({...message,sizes:Array.from({length:1025},() => size)}).ok).toBe(false);
});


test('dimension metadata names current references independently from known sizes', () => {
  expect(check({...message,keys:[size.key,'images/pending.png']}).ok).toBe(true);
  expect(check({...message,keys:[size.key],sizes:[]}).ok).toBe(true);
  expect(check({...message,keys:['images/another.png']}).ok).toBe(false);
  expect(check({...message,keys:[size.key,size.key]}).ok).toBe(false);
  expect(check({...message,keys:Array.from({length:1025},(_,index) => `image-${index}.png`),sizes:[]}).ok).toBe(false);
});
