import type { DocumentFrameBootstrap } from '../features/rendered/documentEmbeds';

/** Bootstrap labels are display metadata, never executable markup. */
export function frameLabel(embed?: Pick<DocumentFrameBootstrap, 'label'>): string {
  const label = embed?.label;
  return typeof label === 'string' && label.trim().length > 0 && label.length <= 1024
    ? label : embed ? 'Embedded document' : 'Rendered document';
}

/** Quote a string for one double-quoted HTML attribute. */
export function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
}
