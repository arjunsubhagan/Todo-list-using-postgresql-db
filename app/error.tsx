"use client";

export default function ErrorPage({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f7f3] px-4 py-10 text-stone-900">
      <section
        aria-labelledby="error-title"
        className="w-full max-w-lg rounded-3xl border border-stone-200 bg-white p-7 text-center shadow-sm sm:p-10"
      >
        <p className="text-sm font-semibold tracking-wide text-rose-800">
          DAYMARK
        </p>
        <h1
          className="mt-5 text-2xl font-semibold tracking-tight sm:text-3xl"
          id="error-title"
        >
          Something went wrong
        </h1>
        <p className="mt-3 text-sm leading-6 text-stone-600">
          We could not complete that request. Your data has not been reported as
          saved unless you saw a confirmation.
        </p>
        <button
          className="mt-6 min-h-11 rounded-xl bg-emerald-800 px-5 py-2.5 font-medium text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
          onClick={retry}
          type="button"
        >
          Try again
        </button>
      </section>
    </main>
  );
}
