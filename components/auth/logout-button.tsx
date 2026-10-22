"use client";

import { useState } from "react";

export function LogoutButton() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    setError("");

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        setError("Could not sign out. Please try again.");
        return;
      }

      if ("BroadcastChannel" in window) {
        const channel = new BroadcastChannel("daymark-session");
        channel.postMessage({ type: "logged-out" });
        channel.close();
      }
      window.location.replace("/login");
    } catch {
      setError("Unable to reach the app. Check your connection and retry.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        aria-busy={pending}
        className="logout-button min-h-11 cursor-pointer whitespace-nowrap rounded-xl border border-stone-300 px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
        onClick={logout}
        type="button"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error && (
        <p className="mt-2 max-w-60 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
