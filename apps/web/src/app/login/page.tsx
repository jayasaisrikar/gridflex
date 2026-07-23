import type { InputHTMLAttributes } from 'react';
import { redirect } from 'next/navigation';
import { AuthSubmitButton } from '@/components/auth-submit-button';
import { BrandLockup } from '@/components/brand';
import {
  apiBootstrapOwner,
  apiBootstrapStatus,
  apiLogin,
  ApiError,
} from '@/lib/api';
import { setSession } from '@/lib/session';

/**
 * Sign-in. A server action posts the credentials so the password never enters a
 * client bundle and the tokens land straight in httpOnly cookies (spec §18).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const bootstrapAvailable = await apiBootstrapStatus()
    .then((status) => status.bootstrap_available)
    .catch(() => false);

  async function signIn(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');

    try {
      const tokens = await apiLogin(email, password);
      await setSession(tokens);
    } catch (error) {
      // Never echo the submitted credentials back into the URL.
      const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      redirect(`/login?error=${encodeURIComponent(code)}`);
    }
    redirect('/console');
  }

  async function createWorkspace(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const passwordConfirmation = String(formData.get('password_confirmation') ?? '');

    if (password !== passwordConfirmation) {
      redirect('/login?error=PASSWORD_MISMATCH');
    }

    try {
      await apiBootstrapOwner({
        email,
        display_name: String(formData.get('display_name') ?? '').trim(),
        password,
        organization_name: String(formData.get('organization_name') ?? '').trim(),
        organization_slug: String(formData.get('organization_slug') ?? '').trim(),
      });
      const tokens = await apiLogin(email, password);
      await setSession(tokens);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      redirect(`/login?error=${encodeURIComponent(code)}`);
    }
    redirect('/setup');
  }

  return (
    <main className="auth-shell">
      <header className="auth-intro">
        <div className="auth-brand">
          <BrandLockup />
          <span>operator workspace</span>
        </div>
        <h1>{bootstrapAvailable ? 'Create the first owner' : 'Return to the control room'}</h1>
        <p>
          {bootstrapAvailable
            ? 'This one-time step locks bootstrap, creates the pilot organization, and assigns the owner role.'
            : 'Sign in to inspect facility readiness, run a simulation drill, and verify its evidence chain.'}
        </p>
      </header>

      {params.error ? (
        <div className="notice notice--error auth-notice" role="alert">
          <span aria-hidden="true">×</span>
          <span>{authErrorMessage(params.error)}</span>
        </div>
      ) : null}

      {bootstrapAvailable ? (
        <form action={createWorkspace} className="panel auth-panel stack">
          <div className="panel__head">
            <div>
              <span className="panel__title">Owner &amp; organization</span>
              <p className="panel__meta">Bootstrap closes permanently after this succeeds.</p>
            </div>
            <span className="chip chip--neutral">One time</span>
          </div>
          <div className="form-grid">
            <AuthField label="Your name" name="display_name" autoComplete="name" required />
            <AuthField label="Work email" name="email" type="email" autoComplete="email" required />
            <AuthField label="Organization" name="organization_name" autoComplete="organization" required />
            <AuthField label="Organization slug" name="organization_slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="northstar-energy" required help="Lowercase letters, numbers, and hyphens." />
            <AuthField label="Password" name="password" type="password" autoComplete="new-password" minLength={12} required help="At least 12 characters. Stored only as an Argon2id hash." />
            <AuthField label="Confirm password" name="password_confirmation" type="password" autoComplete="new-password" minLength={12} required />
          </div>
          <AuthSubmitButton label="Create secure workspace" pendingLabel="Securing workspace…" />
        </form>
      ) : (
        <form action={signIn} className="panel auth-panel stack">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required autoComplete="username" autoFocus />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required autoComplete="current-password" />
          </div>
          <AuthSubmitButton label="Sign in" pendingLabel="Signing in…" />
        </form>
      )}

      <footer className="auth-ledger">
        Session tokens remain in secure, httpOnly cookies · UTC evidence ledger
      </footer>
    </main>
  );
}

function AuthField({
  label,
  name,
  help,
  ...inputProps
}: {
  label: string;
  name: string;
  help?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  const id = `auth-${name}`;
  const helpId = `${id}-help`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} aria-describedby={help ? helpId : undefined} {...inputProps} />
      {help ? <p className="field__help" id={helpId}>{help}</p> : null}
    </div>
  );
}

function authErrorMessage(code: string): string {
  if (code === 'INVALID_CREDENTIALS') return 'Email or password is incorrect.';
  if (code === 'PASSWORD_MISMATCH') return 'The two passwords do not match.';
  if (code === 'SESSION_EXPIRED') return 'Your session ended. Sign in to continue.';
  if (code === 'BOOTSTRAP_ALREADY_COMPLETED' || code === 'CONFLICT') {
    return 'A workspace already exists. Reload this page and sign in.';
  }
  if (code === 'VALIDATION_FAILED') {
    return 'One or more values are invalid. Check the slug, email, and password length.';
  }
  return 'The request could not be completed. Confirm the API and database are available, then retry.';
}
