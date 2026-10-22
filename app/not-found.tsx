import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f7f3] px-4 py-10 text-stone-900">
      <section
        aria-labelledby="not-found-title"
        className="w-full max-w-lg rounded-3xl border border-stone-200 bg-white p-7 text-center shadow-sm sm:p-10"
      >
        <p className="text-sm font-semibold tracking-wide text-emerald-800">
          DAYMARK
        </p>
        <p className="mt-6 text-sm font-semibold uppercase tracking-wider text-stone-500">
          Page not found
        </p>
        <h1
          className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl"
          id="not-found-title"
        >
          We couldn’t find that page.
        </h1>
        <p className="mt-3 text-sm leading-6 text-stone-600">
          Check the address or return to your personal task list.
        </p>
        <Link
          className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-emerald-800 px-5 py-2.5 font-medium text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
          href="/"
        >
          Go to Daymark
        </Link>
      </section>
    </main>
  );
}
