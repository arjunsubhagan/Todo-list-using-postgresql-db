"use client";

import { useEffect, useState } from "react";

const RENEWAL_LOCK = "daymark-session-renewal";
const SESSION_CHANNEL = "daymark-session";
const RENEWAL_INTERVAL_MS = 30_000;
const CLOCK_SAFETY_MS = 100;

type SessionState = {
  expiresAt: string;
  nextRenewalAt: string;
  serverNow: string;
};

type SessionResponse = {
  data: SessionState | null;
  error: { message?: string } | null;
};

async function getSession(): Promise<SessionState | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("/api/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.status === 409 && attempt === 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 75));
      continue;
    }
    if (response.status === 401) {
      window.location.replace("/login?reason=expired");
      return null;
    }
    const payload = (await response.json()) as SessionResponse;
    if (!response.ok || !payload.data) {
      throw new Error(
        payload.error?.message ?? "Could not verify your session.",
      );
    }
    return payload.data;
  }
  throw new Error("Could not verify your session.");
}

export function SessionRenewal() {
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let consecutiveFailures = 0;
    let lastSession: SessionState | null = null;
    let channel: BroadcastChannel | undefined;

    function clearTimer() {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    }

    function schedule(delayMs: number) {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") {
        return;
      }
      const remainingLifetime = lastSession
        ? Date.parse(lastSession.expiresAt) - Date.parse(lastSession.serverNow)
        : RENEWAL_INTERVAL_MS;
      if (remainingLifetime <= 0) {
        timer = window.setTimeout(() => void synchronize(), 0);
        return;
      }
      timer = window.setTimeout(
        () => void renew(),
        Math.min(Math.max(0, delayMs), remainingLifetime),
      );
    }

    function scheduleFromSession(session: SessionState) {
      lastSession = session;
      const remaining = Date.parse(session.nextRenewalAt) -
        Date.parse(session.serverNow);
      schedule(Math.max(0, remaining) + CLOCK_SAFETY_MS);
    }

    function reportFailure(message: string) {
      consecutiveFailures += 1;
      setNotice(
        consecutiveFailures === 1
          ? message
          : "Session renewal is paused after repeated failures. Check your connection or reload to verify your session.",
      );
      if (consecutiveFailures === 1) {
        schedule(RENEWAL_INTERVAL_MS);
      } else {
        clearTimer();
      }
    }

    async function synchronize(
      scheduleNext = true,
    ): Promise<SessionState | null> {
      const session = await getSession();
      if (stopped || !session) {
        clearTimer();
        return null;
      }
      setNotice("");
      if (scheduleNext) {
        scheduleFromSession(session);
      } else {
        lastSession = session;
      }
      return session;
    }

    async function renewWithCurrentCookie(): Promise<void> {
      const current = await synchronize(false);
      if (!current || stopped) {
        return;
      }
      if (
        Date.parse(current.nextRenewalAt) >
        Date.parse(current.serverNow) + CLOCK_SAFETY_MS
      ) {
        scheduleFromSession(current);
        return;
      }

      const response = await fetch("/api/auth/renew", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        window.location.replace("/login?reason=expired");
        return;
      }
      if (response.status === 409) {
        await synchronize();
        return;
      }
      const payload = (await response.json()) as SessionResponse;
      if (!response.ok || !payload.data) {
        throw new Error(
          payload.error?.message ?? "Session renewal could not be completed.",
        );
      }

      lastSession = payload.data;
      consecutiveFailures = 0;
      setNotice("");
      channel?.postMessage({ type: "renewed" });
      scheduleFromSession(payload.data);
    }

    async function renew(): Promise<void> {
      if (stopped || document.visibilityState !== "visible") {
        return;
      }

      try {
        const locks = navigator.locks;
        if (locks) {
          await locks.request(RENEWAL_LOCK, { mode: "exclusive" }, async () => {
            if (!stopped) {
              await renewWithCurrentCookie();
            }
          });
        } else {
          await renewWithCurrentCookie();
        }
      } catch {
        if (stopped) {
          return;
        }
        try {
          const session = await synchronize();
          if (!session || stopped) {
            return;
          }
          reportFailure(
            "Session renewal was interrupted. The app will retry at the next renewal interval.",
          );
        } catch {
          if (!stopped) {
            reportFailure(
              "Could not verify your session. Check your connection; protected actions will remain unavailable until it is verified.",
            );
          }
        }
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        clearTimer();
      } else {
        consecutiveFailures = 0;
        void synchronize().catch(() => {
          if (!stopped) {
            reportFailure("Could not verify your session. Retrying shortly.");
          }
        });
      }
    }

    function onBroadcast(event: MessageEvent<unknown>) {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data
      ) {
        const type = (event.data as { type?: unknown }).type;
        if (type === "renewed") {
          consecutiveFailures = 0;
          void synchronize().catch(() => {
            if (!stopped) {
              reportFailure("Could not verify your session. Retrying shortly.");
            }
          });
        } else if (type === "logged-out") {
          stopped = true;
          clearTimer();
          window.location.replace("/login");
        }
      }
    }

    if ("BroadcastChannel" in window) {
      channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.addEventListener("message", onBroadcast);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    void synchronize().catch(() => {
      if (!stopped) {
        reportFailure("Could not verify your session. Retrying shortly.");
      }
    });

    return () => {
      stopped = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      channel?.removeEventListener("message", onBroadcast);
      channel?.close();
    };
  }, []);

  if (!notice) {
    return null;
  }

  return (
    <p
      className="max-w-full break-words rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:max-w-sm"
      role="status"
    >
      {notice}
    </p>
  );
}
