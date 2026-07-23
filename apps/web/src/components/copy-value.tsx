'use client';

import { useState } from 'react';

export function CopyValue({ value, label = 'Copy hash' }: { value: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('copied');
      window.setTimeout(() => setStatus('idle'), 2500);
    } catch {
      setStatus('error');
    }
  }

  return (
    <>
      <button className="btn copy-value" type="button" onClick={() => void copy()}>
        {status === 'copied' ? '✓ Copied' : status === 'error' ? 'Copy failed' : label}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {status === 'copied'
          ? `${label} copied to clipboard.`
          : status === 'error'
            ? `${label} could not be copied. Select the value manually.`
            : ''}
      </span>
    </>
  );
}
