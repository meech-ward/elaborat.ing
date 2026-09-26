import { expect, test } from 'bun:test';
import { changedGeneratedLabels, pendingLabelsFromArtifact } from '../labelSync.ts';
import { recordForElement } from '../merge.ts';

test('native text wrapping and loose annotations are not source renames', () => {
  const label = {id:'d2:a:label',type:'text',x:0,y:0,width:100,height:20,text:'same words',originalText:'same words'};
  const free = {...label,id:'loose'};
  const previous = {elements:[label,free]};
  const baseline = {language:'d2' as const,sourceHash:'x',elements:{[label.id]:recordForElement(label)}};
  const wrapped = {elements:[{...label,text:'same\nwords'},{...free,text:'new',originalText:'new'}]};
  expect(changedGeneratedLabels(previous,wrapped,baseline)).toEqual([]);
  const renamed = {elements:[{...label,text:'new\nname',originalText:'new name'},free]};
  expect(changedGeneratedLabels(previous,renamed,baseline)).toEqual([{elementId:label.id,before:'same words',after:'new name',rendered:'new\nname'}]);
});

test('reopening an unsynchronized draft reconstructs the original label intent without claiming loose text', () => {
  const owner={id:'d2:a',type:'rectangle',x:0,y:0,width:100,height:40};
  const label={...owner,id:'d2:a:label',type:'text',text:'Before',originalText:'Before'};
  const baseline={language:'d2' as const,sourceHash:'old',elements:{[owner.id]:recordForElement(owner),[label.id]:recordForElement(label)}};
  const scene={elements:[owner,{...label,text:'After',originalText:'After'},{...label,id:'free',text:'unbound annotation'}]};
  expect(pendingLabelsFromArtifact(scene,baseline)).toEqual([{elementId:label.id,before:'Before',after:'After',rendered:'After'}]);
});
