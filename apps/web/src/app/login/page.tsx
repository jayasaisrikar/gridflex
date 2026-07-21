import { redirect } from 'next/navigation';
import { apiLogin, ApiError } from '@/lib/api';
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

  return (
    <main
      className="content"
      style={{ maxWidth: '26rem', margin: '0 auto', paddingTop: 'var(--space-3xl)' }}
    >
      <header className="pagehead">
        <h1>Sign in</h1>
        <p className="pagehead__sub">GridFlex operator console</p>
      </header>

      {params.error ? (
        <div
          className="panel"
          role="alert"
          style={{
            borderColor: 'var(--color-violation)',
            background: 'var(--color-violation-wash)',
            marginBottom: 'var(--space-md)',
          }}
        >
          <span className="row" style={{ color: 'var(--color-violation)' }}>
            <span aria-hidden="true">✕</span>
            {params.error === 'INVALID_CREDENTIALS'
              ? 'Email or password is incorrect.'
              : 'Sign-in failed. Check that the API is running.'}
          </span>
        </div>
      ) : null}

      <form action={signIn} className="panel stack">
        <div>
          <label className="metric__label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="username"
            style={inputStyle}
          />
        </div>

        <div>
          <label className="metric__label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            style={inputStyle}
          />
        </div>

        <button type="submit" className="btn btn--primary" style={{ justifyContent: 'center' }}>
          Sign in
        </button>
      </form>
    </main>
  );
}

const inputStyle = {
  width: '100%',
  padding: 'var(--space-xs) var(--space-sm)',
  background: 'var(--color-paper-sunk)',
  border: '1px solid var(--color-rule-strong)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--color-ink)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-base)',
} as const;
