import type { WriteIn } from '../document/writeIn';
import type { DocumentSnapshot } from './types';

type Presentation = {
  path: string;
  text: string;
  format: DocumentSnapshot['format'];
  provisional?: boolean;
  components: {code: readonly unknown[]; modules: readonly unknown[]};
};

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
