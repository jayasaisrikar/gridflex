'use client';

import type { ReactNode } from 'react';
import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import {
  INITIAL_ACTION_RESULT,
  type ActionResult,
} from '@/lib/action-result';

type OperatorAction = (
  previous: ActionResult,
  formData: FormData,
) => Promise<ActionResult>;

export function OperatorForm({
  action,
  children,
  buttonLabel,
  pendingLabel = 'Working…',
  buttonTone = 'primary',
  hidden = {},
  showSuccess = false,
  className = 'stack',
}: {
  action: OperatorAction;
  children?: ReactNode;
  buttonLabel: string;
  pendingLabel?: string;
  buttonTone?: 'primary' | 'neutral' | 'stop';
  hidden?: Record<string, string>;
  showSuccess?: boolean;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_ACTION_RESULT);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldErrors = Object.entries(state.fieldErrors ?? {});

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    for (const control of form.querySelectorAll<HTMLElement>('[data-gridflex-field-error]')) {
      control.removeAttribute('aria-invalid');
      control.removeAttribute('data-gridflex-field-error');
      const describedBy = (control.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((id) => id && !id.startsWith('operator-field-error-'));
      if (describedBy.length > 0) control.setAttribute('aria-describedby', describedBy.join(' '));
      else control.removeAttribute('aria-describedby');
    }

    const invalidControls: HTMLElement[] = [];
    fieldErrors.forEach(([name], index) => {
      const named = form.elements.namedItem(name);
      if (!(named instanceof HTMLElement)) return;
      const errorId = `operator-field-error-${index}`;
      const describedBy = new Set(
        (named.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean),
      );
      describedBy.add(errorId);
      named.setAttribute('aria-describedby', [...describedBy].join(' '));
      named.setAttribute('aria-invalid', 'true');
      named.setAttribute('data-gridflex-field-error', 'true');
      invalidControls.push(named);
    });
    invalidControls[0]?.focus();
  }, [state.fieldErrors]);

  return (
    <form ref={formRef} action={formAction} className={className}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <div className="button-row">
        <SubmitButton
          label={buttonLabel}
          pendingLabel={pendingLabel}
          tone={buttonTone}
        />
      </div>
      {state.status === 'error' || (showSuccess && state.status === 'success') ? (
        <div
          className={`notice ${state.status === 'error' ? 'notice--error' : 'notice--success'}`}
          role={state.status === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <span aria-hidden="true">{state.status === 'error' ? '×' : '✓'}</span>
          <span>
            {state.message}
            {fieldErrors.length > 0 ? (
              <ul>
                {fieldErrors.map(([name, message], index) => (
                  <li id={`operator-field-error-${index}`} key={name}>
                    <strong>{fieldLabel(name)}:</strong> {message}
                  </li>
                ))}
              </ul>
            ) : null}
          </span>
        </div>
      ) : null}
    </form>
  );
}

function fieldLabel(name: string): string {
  const label = name.replaceAll('_', ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function SubmitButton({
  label,
  pendingLabel,
  tone,
}: {
  label: string;
  pendingLabel: string;
  tone: 'primary' | 'neutral' | 'stop';
}) {
  const { pending } = useFormStatus();
  const toneClass =
    tone === 'primary' ? 'btn--primary' : tone === 'stop' ? 'btn--stop' : '';

  return (
    <button className={`btn ${toneClass}`} type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}
