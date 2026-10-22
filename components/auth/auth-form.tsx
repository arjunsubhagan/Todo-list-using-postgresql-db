"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type AuthFormProps = {
  mode: "login" | "register";
  registered?: boolean;
  sessionExpired?: boolean;
};

type ApiResponse = {
  error?: {
    message?: string;
    fields?: Record<string, string>;
  } | null;
};

export function AuthForm({
  mode,
  registered = false,
  sessionExpired = false,
}: AuthFormProps) {
  const router = useRouter();
  const isRegistration = mode === "register";
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFormError("");
    setFieldErrors({});

    const formData = new FormData(event.currentTarget);
    const body = Object.fromEntries(formData.entries());
    const endpoint = isRegistration
      ? "/api/auth/register"
      : "/api/auth/login";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as ApiResponse;

      if (!response.ok) {
        setFormError(
          result.error?.message ??
            "Something went wrong. Please check your details and try again.",
        );
        setFieldErrors(result.error?.fields ?? {});
        return;
      }

      if (isRegistration) {
        router.replace("/login?registered=1");
      } else {
        router.replace("/dashboard");
      }
      router.refresh();
    } catch {
      setFormError("Unable to reach the app. Check your connection and retry.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-4 py-12 text-stone-900">
      <section className="w-full max-w-md rounded-3xl border border-stone-200 bg-white p-7 shadow-sm sm:p-10">
        <Link
          href="/"
          className="text-sm font-semibold tracking-wide text-emerald-800"
        >
          DAYMARK
        </Link>
        <h1 className="mt-8 text-3xl font-semibold tracking-tight">
          {isRegistration ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          {isRegistration
            ? "A calmer place to keep track of what matters."
            : "Sign in to pick up where you left off."}
        </p>

        {!isRegistration && (registered || sessionExpired) && (
            <p
              className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
              role="status"
            >
              {sessionExpired
                ? "Your session expired. Sign in to continue."
                : "Account created. Sign in to continue."}
            </p>
        )}

        <form
          aria-busy={pending}
          className="mt-7 space-y-5"
          onSubmit={handleSubmit}
          noValidate
        >
          {isRegistration && (
            <div>
              <label
                className="mb-2 block text-sm font-medium"
                htmlFor="name"
              >
                Name
              </label>
              <input
                aria-describedby={fieldErrors.name ? "name-error" : undefined}
                aria-invalid={Boolean(fieldErrors.name)}
                autoComplete="name"
                className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 py-3 outline-none transition placeholder:text-stone-400 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/20"
                id="name"
                maxLength={80}
                name="name"
                required
              />
              {fieldErrors.name && (
                <p className="mt-1 text-sm text-red-700" id="name-error">
                  {fieldErrors.name}
                </p>
              )}
            </div>
          )}

          <div>
            <label className="mb-2 block text-sm font-medium" htmlFor="email">
              Email
            </label>
            <input
              aria-describedby={fieldErrors.email ? "email-error" : undefined}
              aria-invalid={Boolean(fieldErrors.email)}
              autoComplete="email"
              className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 py-3 outline-none transition placeholder:text-stone-400 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/20"
              id="email"
              maxLength={254}
              name="email"
              required
              type="email"
            />
            {fieldErrors.email && (
              <p className="mt-1 text-sm text-red-700" id="email-error">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div>
            <label
              className="mb-2 block text-sm font-medium"
              htmlFor="password"
            >
              Password
            </label>
            <div className="flex rounded-xl border border-stone-300 focus-within:border-emerald-700 focus-within:ring-2 focus-within:ring-emerald-700/20">
              <input
                aria-describedby={[
                  isRegistration ? "password-hint" : "",
                  fieldErrors.password ? "password-error" : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined}
                aria-invalid={Boolean(fieldErrors.password)}
                autoComplete={
                  isRegistration ? "new-password" : "current-password"
                }
                className="min-h-12 min-w-0 flex-1 rounded-l-xl bg-transparent px-4 py-3 outline-none"
                id="password"
                maxLength={128}
                minLength={isRegistration ? 12 : 1}
                name="password"
                required
                type={passwordVisible ? "text" : "password"}
              />
              <button
                aria-label={passwordVisible ? "Hide password" : "Show password"}
                className="cursor-pointer rounded-r-xl px-4 text-sm font-medium text-stone-600 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-emerald-700"
                onClick={() => setPasswordVisible((visible) => !visible)}
                type="button"
              >
                {passwordVisible ? "Hide" : "Show"}
              </button>
            </div>
            {isRegistration && (
              <p className="mt-2 text-xs leading-5 text-stone-500" id="password-hint">
                Use 12–128 characters. A longer, unique passphrase is stronger.
              </p>
            )}
            {fieldErrors.password && (
              <p className="mt-1 text-sm text-red-700" id="password-error">
                {fieldErrors.password}
              </p>
            )}
          </div>

          {isRegistration && (
            <div>
              <label
                className="mb-2 block text-sm font-medium"
                htmlFor="confirmPassword"
              >
                Confirm password
              </label>
              <div className="flex rounded-xl border border-stone-300 focus-within:border-emerald-700 focus-within:ring-2 focus-within:ring-emerald-700/20">
                <input
                  aria-describedby={
                    fieldErrors.confirmPassword
                      ? "confirm-password-error"
                      : undefined
                  }
                  aria-invalid={Boolean(fieldErrors.confirmPassword)}
                  autoComplete="new-password"
                  className="min-h-12 min-w-0 flex-1 rounded-l-xl bg-transparent px-4 py-3 outline-none"
                  id="confirmPassword"
                  maxLength={128}
                  minLength={12}
                  name="confirmPassword"
                  required
                  type={confirmVisible ? "text" : "password"}
                />
                <button
                  aria-label={
                    confirmVisible ? "Hide confirmation" : "Show confirmation"
                  }
                  className="rounded-r-xl px-4 text-sm font-medium text-stone-600 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-emerald-700"
                  onClick={() => setConfirmVisible((visible) => !visible)}
                  type="button"
                >
                  {confirmVisible ? "Hide" : "Show"}
                </button>
              </div>
              {fieldErrors.confirmPassword && (
                <p
                  className="mt-1 text-sm text-red-700"
                  id="confirm-password-error"
                >
                  {fieldErrors.confirmPassword}
                </p>
              )}
            </div>
          )}

          {formError && (
            <p
              className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800"
              role="alert"
            >
              {formError}
            </p>
          )}

          <button
            className={`flex w-full items-center justify-center rounded-xl bg-emerald-800 px-4 py-3 font-medium text-white transition hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 ${isRegistration ? "" : "cursor-pointer"} disabled:cursor-wait disabled:opacity-60`}
            disabled={pending}
            type="submit"
          >
            {pending
              ? "Please wait…"
              : isRegistration
                ? "Create account"
                : "Sign in"}
          </button>
        </form>

        <p className="mt-7 text-center text-sm text-stone-600">
          {isRegistration ? "Already have an account?" : "New to Daymark?"}{" "}
          <Link
            className="font-semibold text-emerald-800 underline-offset-4 hover:underline"
            href={isRegistration ? "/login" : "/register"}
          >
            {isRegistration ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </section>
    </main>
  );
}
