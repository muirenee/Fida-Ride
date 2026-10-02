'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

type LoginForm = {
  email: string;
  password: string;
};

type FieldErrors = Partial<Record<keyof LoginForm, string>>;

const EMAIL_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const MIN_PASSWORD_LENGTH = 12;

function validate(form: LoginForm): FieldErrors {
  const errors: FieldErrors = {};
  const email = form.email.trim();

  if (!email) {
    errors.email = 'Administrative email is required.';
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = 'Enter a valid administrative email address.';
  }

  if (!form.password) {
    errors.password = 'Password is required.';
  } else if (form.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Password must contain at least ${MIN_PASSWORD_LENGTH} characters.`;
  } else if (
    !/[a-z]/.test(form.password) ||
    !/[A-Z]/.test(form.password) ||
    !/[0-9]/.test(form.password) ||
    !/[^A-Za-z0-9]/.test(form.password)
  ) {
    errors.password =
      'Password must include uppercase, lowercase, number, and special characters.';
  }

  return errors;
}

function safeError(status: number): string {
  switch (status) {
    case 400:
      return 'The authentication request was not accepted.';
    case 401:
      return 'The administrative credentials were not accepted.';
    case 403:
      return 'Your account is not permitted to access the command center.';
    case 429:
      return 'Too many authentication attempts. Try again later.';
    case 503:
      return 'Administrative authentication is temporarily unavailable.';
    default:
      return 'Unable to authenticate. Please try again.';
  }
}

export default function AdminLoginPage(): React.JSX.Element {
  const router = useRouter();
  const [form, setForm] = useState<LoginForm>({
    email: '',
    password: '',
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(field: keyof LoginForm, value: string): void {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setAuthError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const errors = validate(form);
    setFieldErrors(errors);
    setAuthError(null);

    if (errors.email || errors.password) return;

    setSubmitting(true);

    try {
      const response = await fetch('/admin/auth/login', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: form.email.trim().toLowerCase(),
          password: form.password,
        }),
      });

      if (!response.ok) {
        setAuthError(safeError(response.status));
        return;
      }

      router.replace('/admin/dashboard');
      router.refresh();
    } catch {
      setAuthError(
        'The authentication service could not be reached. Check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950 px-5 py-12 text-white">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.07),transparent_35%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.035] [background-image:linear-gradient(rgba(255,255,255,0.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.8)_1px,transparent_1px)] [background-size:48px_48px]"
      />

      <section className="relative z-10 w-full max-w-[430px]">
        <header className="mb-8 flex flex-col items-center text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-white text-lg font-black text-black shadow-2xl">
            F
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">
            Fida-Ride Admin Panel
          </h1>
          <p className="mt-2 text-sm text-zinc-500">
            Secure command center authentication
          </p>
        </header>

        <div className="rounded-2xl border border-white/[0.08] bg-zinc-900/60 p-6 shadow-2xl shadow-black/40 backdrop-blur-xl sm:p-8">
          <div className="mb-7">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
              Administrator sign in
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-zinc-500">
              Enter your authorized Fida-Ride administrative credentials.
            </p>
          </div>

          <form noValidate onSubmit={submit} className="space-y-5">
            <div>
              <label
                htmlFor="admin-email"
                className="mb-2 block text-sm font-medium text-zinc-200"
              >
                Administrative email
              </label>
              <input
                id="admin-email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={submitting}
                value={form.email}
                onChange={(event) => update('email', event.target.value)}
                aria-invalid={fieldErrors.email ? 'true' : 'false'}
                className="h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 text-[15px] text-white outline-none transition placeholder:text-zinc-600 hover:border-zinc-700 focus:border-zinc-500 focus:ring-4 focus:ring-white/5 disabled:cursor-not-allowed disabled:opacity-60"
                placeholder="admin@fida.rw"
              />
              {fieldErrors.email ? (
                <p className="mt-2 text-sm text-red-400">{fieldErrors.email}</p>
              ) : null}
            </div>

            <div>
              <label
                htmlFor="admin-password"
                className="mb-2 block text-sm font-medium text-zinc-200"
              >
                Password
              </label>
              <input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                disabled={submitting}
                value={form.password}
                onChange={(event) => update('password', event.target.value)}
                aria-invalid={fieldErrors.password ? 'true' : 'false'}
                className="h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 text-[15px] text-white outline-none transition placeholder:text-zinc-600 hover:border-zinc-700 focus:border-zinc-500 focus:ring-4 focus:ring-white/5 disabled:cursor-not-allowed disabled:opacity-60"
                placeholder="Enter your password"
              />
              {fieldErrors.password ? (
                <p className="mt-2 text-sm text-red-400">{fieldErrors.password}</p>
              ) : null}
            </div>

            {authError ? (
              <div
                role="alert"
                className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200"
              >
                {authError}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={submitting || !form.email.trim() || !form.password}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-black transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {submitting ? (
                <>
                  <span
                    aria-hidden="true"
                    className="size-4 animate-spin rounded-full border-2 border-zinc-500 border-t-black"
                  />
                  Authenticating…
                </>
              ) : (
                'Sign in to command center'
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-600">
          Protected administrative environment
        </p>
      </section>
    </main>
  );
}
