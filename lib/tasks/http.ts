import "server-only";

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { Pool } from "pg";
import {
  getValidSession,
  isRotatedSessionCredential,
} from "@/lib/auth/service";
import { isSameOrigin, SESSION_COOKIE } from "@/lib/auth/http";
import {
  createTask,
  deleteAllTasks,
  deleteTask,
  deleteTasks,
  getTask,
  getTaskList,
  TaskConflictError,
  TaskNotFoundError,
  updateTask,
} from "./service";
import {
  bulkDeleteTasksSchema,
  createTaskSchema,
  deleteAllTasksSchema,
  taskQuerySchema,
  updateTaskSchema,
} from "./validation";

type ApiError = {
  code: string;
  message: string;
  fields?: Record<string, string>;
};

type TaskRouteContext = {
  params: Promise<{ id: string }>;
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

function setExpiredCookie(response: NextResponse, request: Request): void {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    priority: "high",
    secure:
      process.env.NODE_ENV === "production" ||
      new URL(request.url).protocol === "https:",
    expires: new Date(0),
    maxAge: 0,
  });
}

function sessionToken(request: Request): string | null {
  const prefix = `${SESSION_COOKIE}=`;
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  return value || null;
}

async function authenticate(
  request: Request,
  database: Pool,
): Promise<{ userId: string } | NextResponse> {
  const token = sessionToken(request);
  if (token) {
    const authenticated = await getValidSession(database, token);
    if (authenticated) {
      return { userId: authenticated.user.id };
    }
    if (await isRotatedSessionCredential(database, token)) {
      return json(409, null, {
        code: "SESSION_ALREADY_ROTATED",
        message: "Please retry using the current session.",
      });
    }
  }
  const response = json(401, null, {
    code: "UNAUTHENTICATED",
    message: "Your session has expired. Please sign in again.",
  });
  setExpiredCookie(response, request);
  return response;
}

function isResponse(value: { userId: string } | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
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
    message: "Please check the submitted task details.",
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

function operationFailure(error: unknown): NextResponse {
  if (error instanceof TaskNotFoundError) {
    return json(404, null, {
      code: "TASK_NOT_FOUND",
      message: "This task could not be found.",
    });
  }
  if (error instanceof TaskConflictError) {
    return json(409, null, {
      code: "TASK_CONFLICT",
      message: "This task changed elsewhere. Refresh the list and try again.",
    });
  }
  if (error instanceof ZodError) {
    return validationFailure(error);
  }
  console.error(
    "Task operation failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  return json(500, null, {
    code: "INTERNAL_ERROR",
    message: "Something went wrong while saving your task. Please try again.",
  });
}

export async function listTasksHandler(
  request: Request,
  database: Pool,
): Promise<NextResponse> {
  try {
    const auth = await authenticate(request, database);
    if (isResponse(auth)) {
      return auth;
    }
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = taskQuerySchema.safeParse(params);
    if (!parsed.success) {
      return validationFailure(parsed.error);
    }
    return json(200, await getTaskList(database, auth.userId, parsed.data));
  } catch (error) {
    return operationFailure(error);
  }
}

export async function createTaskHandler(
  request: Request,
  database: Pool,
): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return csrfFailure();
  }
  try {
    const auth = await authenticate(request, database);
    if (isResponse(auth)) {
      return auth;
    }
    const body = await readJson(request);
    const parsed = createTaskSchema.safeParse(body);
    if (!parsed.success) {
      return validationFailure(parsed.error);
    }
    return json(201, {
      task: await createTask(database, auth.userId, parsed.data),
    });
  } catch (error) {
    return operationFailure(error);
  }
}

export async function readTaskHandler(
  request: Request,
  database: Pool,
  context: TaskRouteContext,
): Promise<NextResponse> {
  try {
    const auth = await authenticate(request, database);
    if (isResponse(auth)) {
      return auth;
    }
    const { id } = await context.params;
    return json(200, { task: await getTask(database, auth.userId, id) });
  } catch (error) {
    return operationFailure(error);
  }
}

export async function updateTaskHandler(
  request: Request,
  database: Pool,
  context: TaskRouteContext,
): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return csrfFailure();
  }
  try {
    const auth = await authenticate(request, database);
    if (isResponse(auth)) {
      return auth;
    }
    const { id } = await context.params;
    const parsed = updateTaskSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return validationFailure(parsed.error);
    }
    return json(200, {
      task: await updateTask(database, auth.userId, id, parsed.data),
    });
  } catch (error) {
    return operationFailure(error);
  }
}

export async function deleteTaskHandler(
  request: Request,
  database: Pool,
  context: TaskRouteContext,
): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return csrfFailure();
  }
  try {
    const auth = await authenticate(request, database);
    if (isResponse(auth)) {
      return auth;
    }
    const { id } = await context.params;
    await deleteTask(database, auth.userId, id);
    return json(200, { deleted: true });
  } catch (error) {
    return operationFailure(error);
  }
}

export async function bulkDeleteTasksHandler(
  request: Request,
  database: Pool,
): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return csrfFailure();
  }
  try {
    const auth = await authenticate(request, database);
    if (isResponse(auth)) {
      return auth;
    }
    const body = await readJson(request);
    if (
      typeof body === "object" &&
      body !== null &&
      "all" in body &&
      body.all === true
    ) {
      const parsed = deleteAllTasksSchema.safeParse(body);
      if (!parsed.success) {
        return validationFailure(parsed.error);
      }
      return json(200, {
        deleted: await deleteAllTasks(database, auth.userId),
      });
    }

    const parsed = bulkDeleteTasksSchema.safeParse(body);
    if (!parsed.success) {
      return validationFailure(parsed.error);
    }
    return json(200, {
      deleted: await deleteTasks(database, auth.userId, parsed.data.ids),
    });
  } catch (error) {
    return operationFailure(error);
  }
}
