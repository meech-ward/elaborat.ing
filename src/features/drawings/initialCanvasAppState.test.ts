import {expect, test} from 'bun:test';
import {initialCanvasAppState} from './initialCanvasAppState';

test('new canvas tools default to Excalifont and rounded corners', () => {
  expect(initialCanvasAppState()).toMatchObject({currentItemFontFamily:5,currentItemRoundness:'round'});
});

test('initial tool defaults fill only missing choices and preserve authored app state', () => {
  const authored = {currentItemFontFamily:9,currentItemRoundness:'sharp',theme:'dark',futurePreference:{value:7}};
  expect(initialCanvasAppState(authored)).toEqual(authored);
  expect(initialCanvasAppState({theme:'dark'})).toMatchObject({theme:'dark',currentItemFontFamily:5,currentItemRoundness:'round'});
  expect(authored).toEqual({currentItemFontFamily:9,currentItemRoundness:'sharp',theme:'dark',futurePreference:{value:7}});
});
