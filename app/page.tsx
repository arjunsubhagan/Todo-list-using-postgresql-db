import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";

export const instant = false;

export default async function Home() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-5 py-16 text-stone-900">
      <section className="w-full max-w-5xl rounded-[2rem] border border-stone-200 bg-white p-8 shadow-sm sm:p-14">
        <p className="text-sm font-semibold tracking-[0.2em] text-emerald-800">
          DAYMARK
        </p>
        <div className="mt-16 max-w-2xl">
          <p className="text-sm font-medium text-stone-500">
            Make room for what matters.
          </p>
          <h1 className="mt-4 text-5xl font-semibold leading-tight tracking-tight sm:text-6xl">
            A little more clarity, one task at a time.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-stone-600">
            Keep your personal to-do list in one calm, private place on this
            device.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link
              className="rounded-xl bg-emerald-800 px-6 py-3 text-center font-medium text-white transition hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
              href="/register"
            >
              Create your account
            </Link>
            <Link
              className="rounded-xl border border-stone-300 px-6 py-3 text-center font-medium transition hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
              href="/login"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
