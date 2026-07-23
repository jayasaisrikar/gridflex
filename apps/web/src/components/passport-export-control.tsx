'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { exportPassportAction } from '@/app/(console)/actions';
import { INITIAL_ACTION_RESULT } from '@/lib/action-result';

export function PassportExportControl({ passportId }: { passportId: string }) {
  const [state, action] = useActionState(
    exportPassportAction,
    INITIAL_ACTION_RESULT,
  );

  return (
    <div className="stack">
      <form action={action} className="stack">
        <input type="hidden" name="passport_id" value={passportId} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="export-format">Export format</label>
            <select id="export-format" name="format" defaultValue="JSON">
              <option value="JSON">Canonical JSON</option>
              <option value="CSV">Reviewer summary CSV</option>
              <option value="PDF">Human-readable PDF report</option>
            </select>
            <p className="field__help">JSON is canonical; PDF is a readable derivative with both hashes.</p>
          </div>
          <div className="field">
            <label htmlFor="counterparty-name">Counterparty</label>
            <input
              id="counterparty-name"
              name="counterparty_name"
              placeholder="Pilot reviewer or organization"
            />
            <p className="field__help">Optional; recorded in the audit entry.</p>
          </div>
        </div>
        <ExportButton />
      </form>

      {state.status === 'error' ? (
        <div className="notice notice--error" role="alert">
          <span aria-hidden="true">×</span><span>{state.message}</span>
        </div>
      ) : null}
      {state.status === 'success' && state.details.export_id ? (
        <div className="notice notice--success" role="status">
          <span aria-hidden="true">✓</span>
          <span>
            Export ready.{' '}
            <Link
              href={`/api/exports/${state.details.export_id}/download`}
              download
            >
              Download {(state.details.format ?? 'file').toUpperCase()}
            </Link>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ExportButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn--primary" type="submit" disabled={pending}>
      {pending ? 'Preparing export…' : 'Prepare export'}
    </button>
  );
}
