import { useEffect, useState } from 'react';
import { copyCode } from './codeCopy';

/** Copies source text, independently of the highlighting's generated HTML. */
export function CodeCopyButton({ code }: { code: string | (() => string) }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (status !== 'copied') return;
    const timer = window.setTimeout(() => setStatus('idle'), 2_000);
    return () => window.clearTimeout(timer);
  }, [status]);
  return <>
    <span className="document-code-copy-status" role="status" aria-live="polite">
      {status === 'copied' ? 'Copied' : status === 'failed' ? 'Could not copy. Select the code and copy it.' : ''}
    </span>
    <button
      type="button"
      disabled={status === 'copying'}
      onPointerDown={event => {
        // Keep the code textarea/caret where it is; copying never commits a draft.
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.nativeEvent.isTrusted) return;
        setStatus('copying');
        try {
          // Do not defer this call: clipboard access uses the click's activation.
          copyCode(typeof code === 'function' ? code() : code).then(
            () => setStatus('copied'),
            () => setStatus('failed'),
          );
        } catch {
          setStatus('failed');
        }
      }}
    >Copy code</button>
  </>;
}
