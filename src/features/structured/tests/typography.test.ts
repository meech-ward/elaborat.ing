import { expect, test } from 'bun:test';
import { emitNativeScene } from '../emitter';
import { afterAll } from 'bun:test';
import { compileStructured, disposeSharedD2 } from '../compiler';

afterAll(disposeSharedD2);

test('emitted label uses the measured native font size and a full multiline line box', () => {
  const { elements } = emitNativeScene({shapes:[{
    id:'a', type:'rectangle', pos:{x:0,y:0}, width:240, height:90,
    label:'Offline regenerated\nDurable target', fontSize:24,
    labelWidth:137, labelHeight:42,
  }]});
  const label = elements.find(el => el.id === 'd2:a:label')!;
  expect(label.fontFamily).toBe(5);
  expect(label.fontSize).toBe(24);
  expect(label.lineHeight).toBe(1.25);
  expect(label.height).toBe(60);
  expect(label.width).toBe(137);
});

test('real D2 emission sizes a long label and preserves manual geometry on regeneration', async () => {
  const source = 'a: Offline regenerated\nb: Durable target\na -> b: saved offline\n';
  const first = await compileStructured(source);
  console.log('COMPILE_DIAGNOSTICS', JSON.stringify(first.diagnostics));
  expect(first.ok).toBe(true);
  const label = first.scene.elements.find(el => el.id === 'd2:a:label')!;
  console.log('NATIVE_LABEL', JSON.stringify(label));
  expect(label.fontSize).toBe(16);
  expect(label.fontFamily).toBe(5);
  expect(label.height).toBe(20);
  expect(first.scene.elements.find(el => el.id === 'd2:a')?.roundness).toEqual({type:3});
  const current = {elements:first.scene.elements.map(el => el.id === 'd2:a' ? {...el,x:el.x+35,width:el.width+60,roundness:null} : el)};
  const next = await compileStructured(source.replace('Offline regenerated','Offline regenerated with a considerably longer label'), {prior:{baseline:first.baseline!,scene:current}});
  expect(next.ok).toBe(true);
  expect(next.scene.elements.find(el => el.id === 'd2:a')?.x).toBe(current.elements.find(el => el.id === 'd2:a')?.x);
  expect(next.scene.elements.find(el => el.id === 'd2:a')?.width).toBe(current.elements.find(el => el.id === 'd2:a')?.width);
  expect(next.scene.elements.find(el => el.id === 'd2:a')?.roundness).toBeNull();
});

test('rounded defaults apply to boxes while ellipse and diamond semantics stay intact', () => {
  const {elements} = emitNativeScene({shapes:['rectangle','square','oval','diamond'].map((type,index) => ({
    id:String(index), type, pos:{x:index*180,y:0}, width:140, height:80, label:'',
  }))});
  expect(elements.filter(el => el.type === 'rectangle').map(el => el.roundness)).toEqual([{type:3},{type:3}]);
  expect(elements.find(el => el.type === 'ellipse')?.roundness).toBeNull();
  expect(elements.find(el => el.type === 'diamond')?.roundness).toBeNull();
});
