import "server-only";

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { Pool } from "pg";
import {
  DuplicateEmailError,
  ExpiredSessionError,
  InvalidSessionError,
  InvalidCredentialsError,
  LoginRateLimitError,
  getValidSession,
  isRotatedSessionCredential,
  loginUser,
  registerUser,
  revokeSession,
  rotateSession,
  SESSION_RENEWAL_INTERVAL_MS,
  SESSION_LIFETIME_MS,
  SessionRenewalNotDueError,
  SessionRotationConflictError,
} from "@/lib/auth/service";
import {
  loginSchema,
  registrationSchema,
} from "@/lib/auth/validation";

export const SESSION_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Host-todo_session"
    : "todo_session";

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  priority: "high" as const,
};

type ApiError = {
  code: string;
  message: string;
  fields?: Record<string, string>;
};

function json(
  status: number,
  data: unknown,
  error: ApiError | null = null,
): NextResponse {
  return NextResponse.json(
    { data, error },
    {
      status,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    },
  );
}

function responseWithClearedCookie(request: Request): NextResponse {
  const response = json(401, null, {
    code: "UNAUTHENTICATED",
    message: "Your session has expired. Please sign in again.",
  });
  response.cookies.set(SESSION_COOKIE, "", {
    ...SESSION_COOKIE_OPTIONS,
    secure:
      process.env.NODE_ENV === "production" ||
      new URL(request.url).protocol === "https:",
    expires: new Date(0),
    maxAge: 0,
  });
  return response;
}

function setSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: string,
  request: Request,
  now = new Date(),
): void {
  const requestIsHttps = new URL(request.url).protocol === "https:";
  response.cookies.set(SESSION_COOKIE, token, {
    ...SESSION_COOKIE_OPTIONS,
    secure: process.env.NODE_ENV === "production" || requestIsHttps,
    expires: new Date(expiresAt),
    maxAge: Math.max(
      0,
      Math.ceil((Date.parse(expiresAt) - now.getTime()) / 1000),
    ),
  });
}

function clearSessionCookie(response: NextResponse, request: Request): void {
  const requestIsHttps = new URL(request.url).protocol === "https:";
  response.cookies.set(SESSION_COOKIE, "", {
    ...SESSION_COOKIE_OPTIONS,
    secure: process.env.NODE_ENV === "production" || requestIsHttps,
    expires: new Date(0),
    maxAge: 0,
  });
}

export function isSameOrigin(request: Request): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) {
    return false;
  }

  try {
    const origin = new URL(originHeader);
    const requestUrl = new URL(request.url);
    const host = request.headers.get("host") ?? requestUrl.host;
    const forwardedProtocol = request.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      .trim();
    const protocol = forwardedProtocol
      ? `${forwardedProtocol.replace(/:$/, "")}:`
      : requestUrl.protocol;
    return (
      !origin.username &&
      !origin.password &&
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.host.toLowerCase() === host.toLowerCase() &&
      origin.protocol === protocol
    );
  } catch {
    return false;
  }
}

function csrfFailure(): NextResponse {
  return json(403, null, {
    code: "CSRF_REJECTED",
    message: "This request could not be verified. Refresh the page and try again.",
  });
}

function validationFailure(error: ZodError): NextResponse {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !fields[field]) {
      fields[field] = issue.message;
    }
  }
  return json(400, null, {
    code: "VALIDATION_ERROR",
    message: "Please check the highlighted fields.",
    fields,
  });
}

async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function internalFailure(event: string, error: unknown): NextResponse {
  console.error(
    `${event} failed`,
    error instanceof Error ? error.name : "UnknownError",
  );
  return json(500, null, {
    code: "INTERNAL_ERROR",
    message: "Something went wrong. Please try again.",
  });
}

export async function registerHandler(
  request: Request,
  database: Pool,
): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return csrfFailure();
  }

  try {
    const body = await readJson(request);
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
      return validationFailure(parsed.error);
    }

    const user = await registerUser(database, parsed.data);
    return json(201, { user });
  } catch (error) {
    if (error instanceof DuplicateEmailError) {
      return json(409, null, {
        code: "EMAIL_ALREADY_REGISTERED",
        message: "An account with this email already exists. Try signing in.",
      });
    }
    return internalFailure("Registration", error);
  }
}

export async function loginHandler(
  request: Request,
  database: Pool,
  now = new Date(),
): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return csrfFailure();
  }

  try {
    const body = await readJson(request);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return validationFailure(parsed.error);
    }

    const result = await loginUser(database, parsed.data, now);
    const response = json(200, {
      user: result.user,
      expiresAt: result.session.expiresAt,
      lifetimeSeconds: SESSION_LIFETIME_MS / 1000,
    });
    setSessionCookie(
      response,
      result.session.token,
      result.session.expiresAt,
      request,
      now,
    );
    return response;
  } catch (error) {
    if (error instanceof LoginRateLimitError) {
      return json(429, null, {
        code: "TOO_MANY_ATTEMPTS",
        message: "Too many login attempts. Please wait before trying again.",
      });
    }
    if (error instanceof InvalidCredentialsError) {
      return json(401, null, {
        code: "INVALID_CREDENTIALS",
        message: "Email or password is incorrect.",
      });
    }
    return internalFailure("Login", error);
  }
}

export async function sessionHandler(
  request: Request,
  database: Pool,
  now = new Date(),
): Promise<NextResponse> {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  if (!token) {
    return responseWithClearedCookie(request);
  }

  try {
    const result = await getValidSession(database, token, now);
    if (!result) {
      if (await isRotatedSessionCredential(database, token, now)) {
        return json(409, null, {
          code: "SESSION_ALREADY_ROTATED",
          message: "The session credential has already been renewed.",
        });
      }
      return responseWithClearedCookie(request);
    }

    return json(200, {
      user: result.user,
      expiresAt: result.session.expiresAt,
      nextRenewalAt: new Date(
        Date.parse(result.session.createdAt) + SESSION_RENEWAL_INTERVAL_MS,
      ).toISOString(),
      serverNow: now.toISOString(),
    });
  } catch (error) {
    return internalFailure("Session validation", error);
  }
}

export async function renewHandler(
  request: Request,
  database: Pool,
  now = new Date(),
): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return csrfFailure();
  }

  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  if (!token) {
    return responseWithClearedCookie(request);
  }

  try {
    const result = await rotateSession(database, token, now);
    const response = json(200, {
      user: result.user,
      expiresAt: result.session.expiresAt,
      nextRenewalAt: new Date(
        now.getTime() + SESSION_RENEWAL_INTERVAL_MS,
      ).toISOString(),
      serverNow: now.toISOString(),
      rotation: result.rotation,
    });
    setSessionCookie(
      response,
      result.session.token,
      result.session.expiresAt,
      request,
      now,
    );
    return response;
  } catch (error) {
    if (error instanceof SessionRenewalNotDueError) {
      return json(409, {
        nextRenewalAt: error.nextRenewalAt,
        serverNow: now.toISOString(),
      }, {
        code: "SESSION_RENEWAL_NOT_DUE",
        message: "The session is not due for renewal yet.",
      });
    }
    if (error instanceof SessionRotationConflictError) {
      return json(409, null, {
        code: "SESSION_ALREADY_ROTATED",
        message: "The session credential has already been renewed.",
      });
    }
    if (
      error instanceof InvalidSessionError ||
      error instanceof ExpiredSessionError
    ) {
      return responseWithClearedCookie(request);
    }
    return internalFailure("Session renewal", error);
  }
}

export async function logoutHandler(
  request: Request,
  database: Pool,
  now = new Date(),
): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return csrfFailure();
  }

  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  try {
    if (token) {
      await revokeSession(database, token, now);
    }

    const response = json(200, { loggedOut: true });
    clearSessionCookie(response, request);
    return response;
  } catch (error) {
    return internalFailure("Logout", error);
  }
}
