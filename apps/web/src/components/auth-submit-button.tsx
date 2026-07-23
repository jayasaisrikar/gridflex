'use client';

import { useFormStatus } from 'react-dom';

export function AuthSubmitButton({
  label,
  pendingLabel,
}: {
  label: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button className="btn btn--primary auth-submit" type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}
