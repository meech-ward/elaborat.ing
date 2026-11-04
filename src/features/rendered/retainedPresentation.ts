import type { WriteIn } from '../document/writeIn';
import type { DocumentSnapshot } from './types';

type Presentation = {
  path: string;
  text: string;
  format: DocumentSnapshot['format'];
  provisional?: boolean;
  components: {code: readonly unknown[]; modules: readonly unknown[]};
};

export type PresentationScope = Pick<DocumentSnapshot,'text' | 'format' | 'revision'> & {identity?:number;path:string};

export function matchesPresentationScope(exposed: PresentationScope | null, scope: PresentationScope): boolean {
  return exposed !== null && exposed.identity === scope.identity && exposed.path === scope.path &&
    exposed.text === scope.text && exposed.format === scope.format && exposed.revision === scope.revision;
}

/** Only an already approved full tree for the exact current source may retain
 * its focus while that source's module environment is prepared again. */
export function canRetainPreparingPresentation(
  exposed: (PresentationScope & {provisional?:boolean;components:{key:string}}) | null,
  scope: PresentationScope,
  environmentKey: string | undefined,
): boolean {
  return environmentKey !== undefined && matchesApprovedPresentation(exposed,scope,environmentKey);
}

export function matchesApprovedPresentation(
  exposed: (PresentationScope & {provisional?:boolean;components:{key:string}}) | null,
  scope: PresentationScope,
  environmentKey: string | undefined,
): boolean {
  return exposed !== null && !exposed.provisional && matchesPresentationScope(exposed,scope) &&
    exposed.components.key === (environmentKey ?? '');
}

/** A saved-copy adoption changes edit identity, but may keep safe builtin state
 * on screen while its new source is checked. This grants no editing authority. */
export function canRetainSavedBuiltinPresentation(
  exposed: Presentation | null,
  document: Pick<DocumentSnapshot, 'text' | 'format'>,
  identity: number | undefined,
  path: string,
  arrival: WriteIn | null | undefined,
): boolean {
  return exposed !== null && !exposed.provisional && exposed.path === path &&
    document.format === exposed.format &&
    exposed.components.code.length === 0 && exposed.components.modules.length === 0 &&
    arrival != null && arrival.documentId === identity &&
    arrival.text === document.text && arrival.before === exposed.text;
}
