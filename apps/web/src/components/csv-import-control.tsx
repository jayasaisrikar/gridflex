'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  commitCsvAction,
  previewCsvAction,
} from '@/app/(console)/actions';
import { INITIAL_ACTION_RESULT, type ActionResult } from '@/lib/action-result';
import type { Connector } from '@/lib/api';

type Snapshot = {
  csv: string;
  sourceKey: string;
  connectorId: string;
};

export function CsvImportControl({
  facilityId,
  connectors,
}: {
  facilityId: string;
  connectors: Connector[];
}) {
  const [csv, setCsv] = useState('');
  const [sourceKey, setSourceKey] = useState('pilot-interval-meter');
  const [connectorId, setConnectorId] = useState(
    connectors.find((connector) => connector.connector_type === 'CSV_UPLOAD')?.id ?? '',
  );
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [fileError, setFileError] = useState('');
  const [preview, previewAction] = useActionState(previewCsvAction, INITIAL_ACTION_RESULT);

  async function loadFile(file: File | undefined) {
    // A file-selection attempt invalidates the prior commit-ready snapshot
    // immediately. An invalid replacement must never leave older bytes
    // available behind a preview that appears to describe the new file.
    setCsv('');
    setSnapshot(null);
    setFileError('');
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setFileError('That file is larger than the 5 MiB pilot limit. Export a smaller window.');
      return;
    }
    try {
      setCsv(await file.text());
    } catch {
      setFileError('That file could not be read. Choose a local CSV and try again.');
    }
  }

  return (
    <div className="stack">
      <form
        action={previewAction}
        className="stack"
        onSubmit={() => setSnapshot({ csv, sourceKey, connectorId })}
      >
        <input type="hidden" name="facility_id" value={facilityId} />
        <input type="hidden" name="source_key" value={sourceKey} />
        <input type="hidden" name="connector_id" value={connectorId} />
        <textarea name="csv" value={csv} readOnly hidden />

        <div className="form-grid">
          <div className="field">
            <label htmlFor="csv-source-key">Source key</label>
            <input
              id="csv-source-key"
              value={sourceKey}
              onChange={(event) => {
                setSourceKey(event.target.value);
                setSnapshot(null);
              }}
              required
            />
            <p className="field__help">Stable identifier used for duplicate detection.</p>
          </div>
          <div className="field">
            <label htmlFor="csv-connector">Connector</label>
            <select
              id="csv-connector"
              value={connectorId}
              onChange={(event) => {
                setConnectorId(event.target.value);
                setSnapshot(null);
              }}
            >
              <option value="">Unlinked manual import</option>
              {connectors
                .filter((connector) => connector.connector_type === 'CSV_UPLOAD')
                .map((connector) => (
                  <option key={connector.id} value={connector.id}>{connector.name}</option>
                ))}
            </select>
            <p className="field__help">Linking records this connector on every accepted reading.</p>
          </div>
        </div>

        <label className="file-drop" htmlFor="csv-file">
          <span className="file-drop__mark" aria-hidden="true">CSV</span>
          <span>
            <strong>{csv ? 'Replace CSV file' : 'Choose CSV file'}</strong>
            <small>
              {csv
                ? `${csv.split(/\r?\n/).filter(Boolean).length - 1} data rows loaded locally`
                : 'Up to 5 MiB. Nothing is inserted before preview confirmation.'}
            </small>
          </span>
          <input
            id="csv-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void loadFile(event.target.files?.[0])}
          />
        </label>

        {fileError ? (
          <div className="notice notice--error" role="alert">
            <span aria-hidden="true">×</span><span>{fileError}</span>
          </div>
        ) : null}

        <PreviewButton disabled={!csv || !sourceKey} />
        {preview.status === 'error' ? <ActionMessage result={preview} /> : null}
      </form>

      {preview.status === 'success' && snapshot ? (
        <CsvPreview
          facilityId={facilityId}
          preview={preview}
          snapshot={snapshot}
        />
      ) : null}
    </div>
  );
}

function CsvPreview({
  facilityId,
  preview,
  snapshot,
}: {
  facilityId: string;
  preview: ActionResult;
  snapshot: Snapshot;
}) {
  const [commit, commitAction] = useActionState(commitCsvAction, INITIAL_ACTION_RESULT);
  const details = preview.details;

  return (
    <div className="csv-preview stack">
      <div className="section-intro">
        <div>
          <h3>Import preview</h3>
          <p>Review this exact file snapshot before committing.</p>
        </div>
        <span className="chip chip--declared">
          <span className="chip__glyph" aria-hidden="true">◇</span>
          Awaiting confirmation
        </span>
      </div>
      <dl className="definition-list tnum">
        <div><dt>Total rows</dt><dd>{details.total_rows}</dd></div>
        <div><dt>Valid rows</dt><dd>{details.valid_rows}</dd></div>
        <div><dt>Rejected rows</dt><dd>{details.invalid_rows}</dd></div>
        <div><dt>Detected interval</dt><dd>{details.detected_interval_seconds}s</dd></div>
        <div><dt>Window</dt><dd>{details.window_start} → {details.window_end}</dd></div>
      </dl>
      {details.invalid_summary ? (
        <div className="notice notice--warning">
          <span aria-hidden="true">!</span>
          <pre className="csv-preview__errors">{details.invalid_summary}</pre>
        </div>
      ) : null}
      {commit.status === 'success' ? (
        <div className="notice notice--success" role="status">
          <span aria-hidden="true">✓</span>
          <span>
            Imported {commit.details.inserted} rows; {commit.details.duplicates} exact
            duplicates skipped; {commit.details.quarantined} rows quarantined.
          </span>
        </div>
      ) : (
        <form action={commitAction} className="stack">
          <input type="hidden" name="facility_id" value={facilityId} />
          <input type="hidden" name="source_key" value={snapshot.sourceKey} />
          <input type="hidden" name="connector_id" value={snapshot.connectorId} />
          <input type="hidden" name="preview_token" value={details.preview_token} />
          <textarea name="csv" value={snapshot.csv} readOnly hidden />
          <CommitButton />
          {commit.status === 'error' ? <ActionMessage result={commit} /> : null}
        </form>
      )}
    </div>
  );
}

function PreviewButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn--primary" type="submit" disabled={disabled || pending}>
      {pending ? 'Validating CSV…' : 'Preview CSV'}
    </button>
  );
}

function CommitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn--primary" type="submit" disabled={pending}>
      {pending ? 'Committing exact preview…' : 'Confirm and import'}
    </button>
  );
}

function ActionMessage({ result }: { result: ActionResult }) {
  return (
    <div className="notice notice--error" role="alert">
      <span aria-hidden="true">×</span><span>{result.message}</span>
    </div>
  );
}
