import { isDocumentPath } from '@/features/document/documentPaths';

/** Keep an embedded note link inside the current file's project. */
export function documentLink(fileUrl: string | null | undefined, path: unknown): string | null {
  if (!fileUrl || typeof path !== 'string' || !isDocumentPath(path)) return null;
  try {
    const url = new URL(fileUrl);
    const prefix = /^\/projects\/[^/]+\//.exec(url.pathname)?.[0];
    if (!prefix || !['https:','http:'].includes(url.protocol)) return null;
    url.pathname = prefix + path.split('/').map(encodeURIComponent).join('/');
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}
