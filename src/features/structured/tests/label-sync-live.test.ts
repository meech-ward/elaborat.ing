import { afterAll, expect, test } from 'bun:test';
import { compileStructured, createD2CompilePort, disposeSharedD2 } from '../compiler.ts';
import { synchronizeLabels } from '../labelSync.ts';
import { mergeRegeneration } from '../merge.ts';

const live = test.if(process.env.STRUCTURED_D2_LIVE === '1');
afterAll(disposeSharedD2);

live('canvas rename updates effective D2 label while source comments and identity survive', async () => {
  const source = '# retain exactly\na: Old # user comment\na -> b: untouched\n';
  const prior = await compileStructured(source);
  const compile = (source: string) => createD2CompilePort()({ source });
  const result = await synchronizeLabels(source, prior.baseline!, [
    { elementId: 'd2:a:label', before: 'Old', after: 'New' },
  ], compile);
  expect(result.error).toBeNull();
  const actual = await compile(result.source);
  expect(actual.shapes?.find(s => s.id === 'a')?.label).toBe('New');
  expect(result.source).toContain('# retain exactly\n');
  expect(result.source).toContain('# user comment\na -> b: untouched\n');
  expect(actual.shapes?.map(s => s.id)).toEqual(['a', 'b']);
}, 90000);

live('nested and quoted identities, overrides, escaping and repeated edits retain effective meaning', async () => {
  const compile = (source: string) => createD2CompilePort()({ source });
  for (const [source, id, before] of [
    ['group: { a: Old }\ngroup.a.label: Last\n', 'group.a', 'Last'],
    ['"space name": Old\n', '"space name"', 'Old'],
    ['"a.b": Old\n', '"a.b"', 'Old'],
    ['a: First\na: Old\n', 'a', 'Old'],
  ]) {
    const prior = await compileStructured(source!);
    const actualId = (await compile(source!)).shapes!.find(s => s.label === before)!.id;
    console.log('mapped identity', id, actualId);
    const after = 'He said "yes" \\ path\nsecond line';
    const one = await synchronizeLabels(source!, prior.baseline!, [{ elementId: `d2:${actualId}:label`, before: before!, after }], compile);
    expect(one.error).toBeNull();
    expect((await compile(one.source)).shapes!.find(s => s.id === actualId)!.label).toBe(after);
    expect(one.source.startsWith(source!)).toBe(true);
    const two = await synchronizeLabels(one.source, one.baseline, [{ elementId: `d2:${actualId}:label`, before: after, after: 'Again' }], compile);
    expect(two.error).toBeNull();
    expect(two.source.match(/# canvas-label/g)?.length).toBe(1);
    const undo = await synchronizeLabels(two.source, two.baseline, [{ elementId: `d2:${actualId}:label`, before: 'Again', after }], compile);
    expect(undo.error).toBeNull();
    expect((await compile(undo.source)).shapes!.find(s => s.id === actualId)!.label).toBe(after);
  }
}, 90000);

live('source label after canvas synchronization wins regeneration while loose artwork and geometry survive', async () => {
  const source = 'a: Old\na -> b\n';
  const prior = await compileStructured(source);
  const current = structuredClone(prior.scene);
  const box = current.elements.find(el => el.id === 'd2:a')!;
  box.x += 153;
  box.roughness = 2;
  const label = current.elements.find(el => el.id === 'd2:a:label')!;
  label.text = label.originalText = 'Canvas';
  current.elements.push({id:'hand-note',type:'text',x:12,y:600,width:90,height:24,text:'loose note'}, {id:'loose-arrow',type:'arrow',x:30,y:620,width:50,height:40,points:[[0,0],[50,40]],endBinding:null});
  const synced = await synchronizeLabels(source, prior.baseline!, [{elementId:label.id,before:'Old',after:'Canvas'}], s => createD2CompilePort()({source:s}));
  expect(synced.error).toBeNull();
  // Serialize/reopen the actual stored baseline and scene before source editing.
  const reopened = JSON.parse(JSON.stringify({baseline:synced.baseline,scene:current}));
  const fresh = await compileStructured(synced.source.replace('"Canvas"', '"Code"'));
  const merged = mergeRegeneration({baseline:reopened.baseline,currentScene:reopened.scene,freshScene:fresh.scene,freshBaseline:fresh.baseline!});
  expect(merged.scene.elements.find(el=>el.id===label.id)?.text).toBe('Code');
  expect(merged.scene.elements.find(el=>el.id===box.id)?.x).toBe(box.x);
  expect(merged.scene.elements.find(el=>el.id===box.id)?.roughness).toBe(2);
  expect(merged.scene.elements.filter(el=>!el.id.startsWith('d2:'))).toEqual(current.elements.filter(el=>!el.id.startsWith('d2:')));
}, 90000);

live('invalid source, concurrent source rename and unmapped generated text are preserved with errors', async () => {
  const source = 'a: Old\n';
  const prior = await compileStructured(source);
  const compile = (source:string) => createD2CompilePort()({source});
  for (const [draft,elementId] of [['a: { {{','d2:a:label'],['a: Source edit\n','d2:a:label'],[source,'d2:a:col:id']]) {
    const result = await synchronizeLabels(draft!,prior.baseline!,[{elementId:elementId!,before:'Old',after:'Canvas'}],compile);
    expect(result.error).toContain('Canvas label not synchronized');
    expect(result.source).toBe(draft!);
    expect(result.baseline).toBe(prior.baseline!);
  }
},90000);
