import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { SESSION_COOKIE } from "@/lib/auth/http";
import { loginUser, registerUser } from "@/lib/auth/service";
import { registrationSchema } from "@/lib/auth/validation";
import { createTestDatabase } from "../database";
import {
  bulkDeleteTasksHandler,
  createTaskHandler,
  deleteTaskHandler,
  listTasksHandler,
  readTaskHandler,
  updateTaskHandler,
} from "@/lib/tasks/http";
import {
  createTask,
  getTask,
  getTaskList,
  TaskConflictError,
  TaskNotFoundError,
  updateTask,
} from "@/lib/tasks/service";
import {
  createTaskSchema,
  taskQuerySchema,
} from "@/lib/tasks/validation";

const PASSWORD = "correct horse battery staple";
const APP_ORIGIN = "http://localhost:3000";
const TEST_NOW = new Date("2026-10-15T13:00:00.000Z");

describe("authenticated task CRUD and organization", () => {
  let database: Pool;
  let closeTestDatabase: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    vi.stubEnv("APP_TIME_ZONE", "UTC");
    const testDatabase = await createTestDatabase();
    database = testDatabase.database;
    closeTestDatabase = testDatabase.close;
  });

  afterEach(async () => {
    await closeTestDatabase?.();
    closeTestDatabase = undefined;
    vi.unstubAllEnvs();
  });

  async function addUser(
    email: string,
    name: string,
  ): Promise<{ id: string; token: string }> {
    const input = registrationSchema.parse({
      name,
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
    const now = new Date();
    const user = await registerUser(database, input, now);
    const login = await loginUser(
      database,
      { email, password: PASSWORD },
      now,
    );
    return { id: user.id, token: login.session.token };
  }

  async function addTask(
    userId: string,
    task: Record<string, unknown>,
    now = TEST_NOW,
  ): Promise<Awaited<ReturnType<typeof createTask>>> {
    const clearDate = task.dueDate === null;
    const clearTime = task.dueTime === null;
    const created = await createTask(
      database,
      userId,
      createTaskSchema.parse({
        ...validTask,
        ...task,
        dueDate: clearDate ? validTask.dueDate : task.dueDate ?? validTask.dueDate,
        dueTime: clearTime ? validTask.dueTime : task.dueTime ?? validTask.dueTime,
      }),
      now,
    );
    if (!clearDate && !clearTime) {
      return created;
    }
    return updateTask(
      database,
      userId,
      created.id,
      {
        ...(clearDate ? { dueDate: null } : {}),
        ...(clearTime ? { dueTime: null } : {}),
      },
      new Date(now.getTime() + 1),
    );
  }

  function request(
    route: string,
    method: string,
    body?: unknown,
    token?: string,
  ): Request {
    const headers = new Headers({ Origin: APP_ORIGIN });
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (token) {
      headers.set("Cookie", `${SESSION_COOKIE}=${token}`);
    }
    return new Request(`${APP_ORIGIN}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function routeContext(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  const validTask = {
    title: "Prepare the weekly review",
    description: "Gather notes and priorities.",
    dueDate: "2026-10-16",
    dueTime: "10:30",
    priority: "high",
    status: "pending",
    category: "Work",
  };

  it("creates, lists, reads, edits, completes, reopens, and deletes an owned task", async () => {
    const owner = await addUser("owner@example.com", "Owner");
    const createInput = { ...validTask, dueDate: "2099-10-16" };
    const createdResponse = await createTaskHandler(
      request("/api/tasks", "POST", createInput, owner.token),
      database,
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()).data.task;
    expect(created).toMatchObject({
      title: validTask.title,
      description: validTask.description,
      dueDate: createInput.dueDate,
      dueTime: validTask.dueTime,
      priority: "high",
      status: "pending",
      category: "Work",
      completedAt: null,
      isOverdue: false,
    });
    expect(created).not.toHaveProperty("userId");
    const { rows: ownerRows } = await database.query(
      "SELECT user_id FROM tasks WHERE id = $1",
      [created.id],
    );
    expect(ownerRows[0]).toEqual({ user_id: owner.id });

    const listResponse = await listTasksHandler(
      request("/api/tasks", "GET", undefined, owner.token),
      database,
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()).data;
    expect(listed.tasks.map((task: { id: string }) => task.id)).toContain(
      created.id,
    );
    expect(listed.summary).toMatchObject({
      total: 1,
      pending: 1,
      completed: 0,
    });

    const detailResponse = await readTaskHandler(
      request(`/api/tasks/${created.id}`, "GET", undefined, owner.token),
      database,
      routeContext(created.id),
    );
    expect((await detailResponse.json()).data.task.id).toBe(created.id);
    const { rows: afterReadRows } = await database.query(
      "SELECT status, created_at, updated_at FROM tasks WHERE id = $1",
      [created.id],
    );
    const afterRead = afterReadRows[0];
    expect(afterRead).toEqual({
      status: "pending",
      created_at: created.createdAt,
      updated_at: created.updatedAt,
    });

    const updatedResponse = await updateTaskHandler(
      request(
        `/api/tasks/${created.id}`,
        "PATCH",
        {
          ...validTask,
          title: "Prepare the monthly review",
          status: "completed",
          expectedUpdatedAt: created.updatedAt,
        },
        owner.token,
      ),
      database,
      routeContext(created.id),
    );
    expect(updatedResponse.status).toBe(200);
    const completed = (await updatedResponse.json()).data.task;
    expect(completed.title).toBe("Prepare the monthly review");
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeTruthy();
    expect(completed.createdAt).toBe(created.createdAt);

    const completedReadResponse = await readTaskHandler(
      request(`/api/tasks/${created.id}`, "GET", undefined, owner.token),
      database,
      routeContext(created.id),
    );
    const completedRead = (await completedReadResponse.json()).data.task;
    expect(completedRead).toMatchObject({
      status: "completed",
      createdAt: created.createdAt,
      updatedAt: completed.updatedAt,
      completedAt: completed.completedAt,
    });
    const { rows: completedRows } = await database.query(
      "SELECT status, created_at, updated_at, completed_at FROM tasks WHERE id = $1",
      [created.id],
    );
    expect(completedRows[0]).toEqual({
      status: "completed",
      created_at: created.createdAt,
      updated_at: completed.updatedAt,
      completed_at: completed.completedAt,
    });

    const reopenedResponse = await updateTaskHandler(
      request(
        `/api/tasks/${created.id}`,
        "PATCH",
        {
          status: "pending",
          expectedUpdatedAt: completed.updatedAt,
        },
        owner.token,
      ),
      database,
      routeContext(created.id),
    );
    const reopened = (await reopenedResponse.json()).data.task;
    expect(reopened.status).toBe("pending");
    expect(reopened.completedAt).toBeNull();

    const inProgressResponse = await updateTaskHandler(
      request(
        `/api/tasks/${created.id}`,
        "PATCH",
        {
          status: "in_progress",
          expectedUpdatedAt: reopened.updatedAt,
        },
        owner.token,
      ),
      database,
      routeContext(created.id),
    );
    expect(inProgressResponse.status).toBe(200);
    expect((await inProgressResponse.json()).data.task.status).toBe("in_progress");
    const inProgressList = await listTasksHandler(
      request("/api/tasks", "GET", undefined, owner.token),
      database,
    );
    expect((await inProgressList.json()).data.summary.pending).toBe(0);

    const deletedResponse = await deleteTaskHandler(
      request(`/api/tasks/${created.id}`, "DELETE", undefined, owner.token),
      database,
      routeContext(created.id),
    );
    expect(deletedResponse.status).toBe(200);
    expect((await deletedResponse.json()).data.deleted).toBe(true);
    const afterDelete = await readTaskHandler(
      request(`/api/tasks/${created.id}`, "GET", undefined, owner.token),
      database,
      routeContext(created.id),
    );
    expect(afterDelete.status).toBe(404);
  });

  it("defaults new tasks to pending and preserves timestamps for no-op updates", async () => {
    const owner = await addUser("task-defaults@example.com", "Defaults");
    const createdAt = new Date("2026-10-15T13:00:00.000Z");
    const created = await createTask(
      database,
      owner.id,
      createTaskSchema.parse({
        title: "Default pending task",
        dueDate: "2099-10-16",
        dueTime: "10:30",
      }),
      createdAt,
    );

    expect(created.status).toBe("pending");
    expect(created.createdAt).toBe(createdAt.toISOString());
    expect(created.updatedAt).toBe(createdAt.toISOString());

    const unchanged = await updateTask(
      database,
      owner.id,
      created.id,
      {
        title: created.title,
        description: created.description,
        dueDate: created.dueDate,
        dueTime: created.dueTime,
        priority: created.priority,
        status: created.status,
        category: created.category,
        expectedUpdatedAt: created.updatedAt,
      },
      new Date("2026-10-15T14:00:00.000Z"),
    );
    expect(unchanged.status).toBe("pending");
    expect(unchanged.createdAt).toBe(created.createdAt);
    expect(unchanged.updatedAt).toBe(created.updatedAt);

    const changed = await updateTask(
      database,
      owner.id,
      created.id,
      {
        description: "A genuinely changed description",
        expectedUpdatedAt: unchanged.updatedAt,
      },
      new Date("2026-10-15T15:00:00.000Z"),
    );
    expect(changed.status).toBe("pending");
    expect(changed.createdAt).toBe(created.createdAt);
    expect(changed.updatedAt).toBe("2026-10-15T15:00:00.000Z");
  });

  it("denies every task operation to unauthenticated callers", async () => {
    const list = await listTasksHandler(
      request("/api/tasks", "GET"),
      database,
    );
    const create = await createTaskHandler(
      request("/api/tasks", "POST", validTask),
      database,
    );
    const detail = await readTaskHandler(
      request("/api/tasks/not-owned", "GET"),
      database,
      routeContext("not-owned"),
    );
    const update = await updateTaskHandler(
      request("/api/tasks/not-owned", "PATCH", { title: "No access" }),
      database,
      routeContext("not-owned"),
    );
    const remove = await deleteTaskHandler(
      request("/api/tasks/not-owned", "DELETE"),
      database,
      routeContext("not-owned"),
    );
    const bulkRemove = await bulkDeleteTasksHandler(
      request("/api/tasks/bulk", "DELETE", { ids: ["00000000-0000-4000-8000-000000000001"] }),
      database,
    );
    expect([
      list.status,
      create.status,
      detail.status,
      update.status,
      remove.status,
      bulkRemove.status,
    ]).toEqual([401, 401, 401, 401, 401, 401]);
    expect(list.headers.getSetCookie().join(";")).toMatch(/Max-Age=0/i);
    expect(
      Number((await database.query("SELECT COUNT(*) AS count FROM tasks")).rows[0].count),
    ).toBe(0);
  });

  it("bulk deletes selected or all tasks only for the authenticated owner", async () => {
    const owner = await addUser("bulk-owner@example.com", "Bulk Owner");
    const otherUser = await addUser("bulk-other@example.com", "Other Owner");
    const first = await addTask(owner.id, { title: "Selected one" });
    const second = await addTask(owner.id, { title: "Selected two" });
    const remaining = await addTask(owner.id, { title: "Keep until delete all" });
    const otherTask = await addTask(otherUser.id, { title: "Other user's task" });

    const partialFailure = await bulkDeleteTasksHandler(
      request(
        "/api/tasks/bulk",
        "DELETE",
        { ids: [first.id, otherTask.id] },
        owner.token,
      ),
      database,
    );
    expect(partialFailure.status).toBe(404);
    expect((await getTask(database, owner.id, first.id)).id).toBe(first.id);
    expect((await getTask(database, otherUser.id, otherTask.id)).id).toBe(otherTask.id);

    const selectedResponse = await bulkDeleteTasksHandler(
      request(
        "/api/tasks/bulk",
        "DELETE",
        { ids: [first.id, second.id] },
        owner.token,
      ),
      database,
    );
    expect(selectedResponse.status).toBe(200);
    expect((await selectedResponse.json()).data.deleted).toBe(2);
    await expect(getTask(database, owner.id, first.id)).rejects.toThrow(TaskNotFoundError);
    await expect(getTask(database, owner.id, second.id)).rejects.toThrow(TaskNotFoundError);
    expect((await getTask(database, owner.id, remaining.id)).id).toBe(remaining.id);
    expect((await getTask(database, otherUser.id, otherTask.id)).id).toBe(otherTask.id);

    const allResponse = await bulkDeleteTasksHandler(
      request("/api/tasks/bulk", "DELETE", { all: true }, owner.token),
      database,
    );
    expect(allResponse.status).toBe(200);
    expect((await allResponse.json()).data.deleted).toBe(1);
    await expect(getTask(database, owner.id, remaining.id)).rejects.toThrow(TaskNotFoundError);
    expect((await getTask(database, otherUser.id, otherTask.id)).id).toBe(otherTask.id);
  });

  it("rejects malformed and duplicate bulk task IDs without deleting tasks", async () => {
    const owner = await addUser("bulk-validation@example.com", "Bulk Validation");
    const task = await addTask(owner.id, { title: "Must remain" });

    for (const ids of [[task.id, task.id], ["not-a-uuid"]]) {
      const response = await bulkDeleteTasksHandler(
        request("/api/tasks/bulk", "DELETE", { ids }, owner.token),
        database,
      );
      expect(response.status).toBe(400);
    }
    expect((await getTask(database, owner.id, task.id)).id).toBe(task.id);
  });

  it("does not reveal or mutate another user's task through an altered ID", async () => {
    const owner = await addUser("first@example.com", "First");
    const otherUser = await addUser("second@example.com", "Second");
    const created = await createTaskHandler(
      request("/api/tasks", "POST", validTask, owner.token),
      database,
    );
    const taskId = (await created.json()).data.task.id;

    const read = await readTaskHandler(
      request(`/api/tasks/${taskId}`, "GET", undefined, otherUser.token),
      database,
      routeContext(taskId),
    );
    const update = await updateTaskHandler(
      request(
        `/api/tasks/${taskId}`,
        "PATCH",
        { title: "Attempted takeover" },
        otherUser.token,
      ),
      database,
      routeContext(taskId),
    );
    const remove = await deleteTaskHandler(
      request(`/api/tasks/${taskId}`, "DELETE", undefined, otherUser.token),
      database,
      routeContext(taskId),
    );
    const otherUsersList = await listTasksHandler(
      request("/api/tasks", "GET", undefined, otherUser.token),
      database,
    );
    const otherUsersSearch = await listTasksHandler(
      request("/api/tasks?q=weekly", "GET", undefined, otherUser.token),
      database,
    );
    const completionAttempt = await updateTaskHandler(
      request(
        `/api/tasks/${taskId}`,
        "PATCH",
        { status: "completed" },
        otherUser.token,
      ),
      database,
      routeContext(taskId),
    );
    expect([read.status, update.status, remove.status, completionAttempt.status])
      .toEqual([404, 404, 404, 404]);
    expect((await otherUsersList.json()).data.tasks).toEqual([]);
    expect((await otherUsersSearch.json()).data.tasks).toEqual([]);
    expect((await read.json()).error.code).toBe("TASK_NOT_FOUND");
    const { rows: taskRows } = await database.query(
      "SELECT title, user_id FROM tasks WHERE id = $1",
      [taskId],
    );
    expect(taskRows[0]).toEqual({ title: validTask.title, user_id: owner.id });
  });

  it("validates task fields and rejects malformed dates and untrusted owner fields", async () => {
    const owner = await addUser("validation@example.com", "Validation");
    for (const input of [
      { ...validTask, title: " \t " },
      { ...validTask, dueDate: "2026-02-30" },
      { ...validTask, dueDate: null, dueTime: "10:00" },
      { ...validTask, dueDate: null, dueTime: null },
      { ...validTask, dueTime: null },
      { ...validTask, userId: owner.id },
    ]) {
      const response = await createTaskHandler(
        request("/api/tasks", "POST", input, owner.token),
        database,
      );
      expect(response.status).toBe(400);
    }
    expect(
      Number((await database.query("SELECT COUNT(*) AS count FROM tasks")).rows[0].count),
    ).toBe(0);
    expect(
      createTaskSchema.safeParse({
        ...validTask,
        title: "x".repeat(201),
      }).success,
    ).toBe(false);

    const missingDate = createTaskSchema.safeParse({
      ...validTask,
      dueDate: null,
    });
    expect(missingDate.success).toBe(false);
    if (!missingDate.success) {
      expect(missingDate.error.issues[0].message).toBe(
        "Please select a due date.",
      );
    }

    const missingTime = createTaskSchema.safeParse({
      ...validTask,
      dueTime: null,
    });
    expect(missingTime.success).toBe(false);
    if (!missingTime.success) {
      expect(missingTime.error.issues[0].message).toBe(
        "Please select a due time.",
      );
    }

    const missingBoth = createTaskSchema.safeParse({
      ...validTask,
      dueDate: null,
      dueTime: null,
    });
    expect(missingBoth.success).toBe(false);
    if (!missingBoth.success) {
      expect(
        new Set(missingBoth.error.issues.map((issue) => issue.message)),
      ).toEqual(new Set(["Due date and due time are required."]));
    }
  });

  it("uses optimistic concurrency and keeps completion timestamps consistent", async () => {
    const owner = await addUser("concurrency@example.com", "Concurrency");
    const parsed = createTaskSchema.parse(validTask);
    const created = await createTask(database, owner.id, parsed, TEST_NOW);
    const completed = await updateTask(
      database,
      owner.id,
      created.id,
      { status: "completed", expectedUpdatedAt: created.updatedAt },
      new Date(TEST_NOW.getTime() + 1000),
    );
    expect(completed.completedAt).toBe("2026-10-15T13:00:01.000Z");
    expect(completed.createdAt).toBe(created.createdAt);
    expect(completed.updatedAt).toBe("2026-10-15T13:00:01.000Z");
    const completedRead = await getTask(database, owner.id, created.id, TEST_NOW);
    expect(completedRead.status).toBe("completed");
    expect(completedRead.createdAt).toBe(created.createdAt);
    expect(completedRead.updatedAt).toBe(completed.updatedAt);
    await expect(
      updateTask(
        database,
        owner.id,
        created.id,
        { title: "Stale update", expectedUpdatedAt: created.updatedAt },
        new Date(TEST_NOW.getTime() + 2000),
      ),
    ).rejects.toThrow(TaskConflictError);

    const reopened = await updateTask(
      database,
      owner.id,
      created.id,
      { status: "in_progress", expectedUpdatedAt: completed.updatedAt },
      new Date(TEST_NOW.getTime() + 3000),
    );
    expect(reopened.completedAt).toBeNull();
    expect(reopened.status).toBe("in_progress");
    expect(reopened.createdAt).toBe(created.createdAt);
    expect(reopened.updatedAt).toBe("2026-10-15T13:00:03.000Z");
    await expect(
      updateTask(database, "different-user", created.id, { title: "Nope" }),
    ).rejects.toThrow(TaskNotFoundError);
  });

  it("combines title, date, status, priority, and category filters and sorts undated tasks last", async () => {
    const owner = await addUser("filters@example.com", "Filters");
    const add = (task: Record<string, unknown>) =>
      addTask(owner.id, task);
    await add({
      ...validTask,
      title: "Alpha late today",
      dueDate: "2026-10-15",
      dueTime: "10:00",
    });
    await add({
      ...validTask,
      title: "Alpha later today",
      dueDate: "2026-10-15",
      dueTime: "16:00",
      priority: "medium",
    });
    await add({
      ...validTask,
      title: "Alpha yesterday",
      dueDate: "2026-10-14",
      dueTime: null,
      category: "Home",
    });
    await add({
      ...validTask,
      title: "Alpha completed yesterday",
      dueDate: "2026-10-14",
      dueTime: null,
      status: "completed",
      category: "Home",
    });
    await add({
      ...validTask,
      title: "Alpha tomorrow",
      dueDate: "2026-10-16",
      dueTime: null,
    });
    await add({
      ...validTask,
      title: "Alpha no date",
      dueDate: null,
      dueTime: null,
    });
    await add({
      ...validTask,
      title: "Éclair weekly plan",
      dueDate: "2026-10-15",
      dueTime: null,
    });

    const query = (values: Record<string, string>) =>
      taskQuerySchema.parse(values);
    const overdue = await getTaskList(
      database,
      owner.id,
      query({ date: "overdue", sort: "due_asc" }),
      TEST_NOW,
    );
    expect(overdue.tasks.map((task) => task.title)).toEqual([
      "Alpha yesterday",
      "Alpha late today",
    ]);
    expect(overdue.summary.overdue).toBe(2);
    const dueThisMinute = await add({
      ...validTask,
      title: "Due this minute",
      dueDate: "2026-10-15",
      dueTime: "13:00",
    });
    expect(
      (await getTaskList(
        database,
        owner.id,
        query({ date: "overdue" }),
        new Date("2026-10-15T13:00:30.000Z"),
      )).tasks.map((task) => task.id),
    ).toContain(dueThisMinute.id);

    const combined = await getTaskList(
      database,
      owner.id,
      query({
        q: " alpha ",
        date: "custom",
        from: "2026-10-14",
        to: "2026-10-15",
        status: "pending",
        priority: "high",
        category: "Work",
        sort: "title_asc",
      }),
      TEST_NOW,
    );
    expect(combined.tasks.map((task) => task.title)).toEqual([
      "Alpha late today",
    ]);
    expect(
      (await getTaskList(
        database,
        owner.id,
        query({ q: " éCLAIR " }),
        TEST_NOW,
      )).tasks.map((task) => task.title),
    ).toEqual(["Éclair weekly plan"]);
    expect(
      (await getTaskList(
        database,
        owner.id,
        query({ date: "today", sort: "title_asc" }),
        TEST_NOW,
      )).tasks.map((task) => task.title),
    ).toEqual([
      "Alpha late today",
      "Alpha later today",
      "Due this minute",
      "Éclair weekly plan",
    ]);
    expect(
      (await getTaskList(
        database,
        owner.id,
        query({ date: "tomorrow" }),
        TEST_NOW,
      )).tasks.map((task) => task.title),
    ).toEqual(["Alpha tomorrow"]);
    expect(
      (await getTaskList(
        database,
        owner.id,
        query({ date: "this_week" }),
        TEST_NOW,
      )).tasks,
    ).toHaveLength(7);
    expect(
      (await getTaskList(
        database,
        owner.id,
        query({ date: "upcoming" }),
        TEST_NOW,
      )).tasks.map((task) => task.title),
    ).toEqual(["Alpha tomorrow"]);
    expect(
      (await getTaskList(
        database,
        owner.id,
        query({ q: "no task with this title" }),
        TEST_NOW,
      )).tasks,
    ).toEqual([]);
    expect(
      (await getTaskList(
        database,
        owner.id,
        query({ date: "completed", sort: "due_desc" }),
        TEST_NOW,
      )).tasks.every((task) => task.status === "completed" && !task.isOverdue),
    ).toBe(true);
    for (const sort of ["due_asc", "due_desc"] as const) {
      const tasks = (await getTaskList(
        database,
        owner.id,
        query({ sort }),
        TEST_NOW,
      )).tasks;
      expect(tasks.at(-1)?.title).toBe("Alpha no date");
    }
    expect(
      taskQuerySchema.safeParse({
        date: "custom",
        from: "2026-10-16",
        to: "2026-10-15",
      }).success,
    ).toBe(false);
  });

  it("sorts due dates, creation timestamps, and priority in both directions", async () => {
    const owner = await addUser("sorts@example.com", "Sorts");
    const add = (
      title: string,
      fields: Record<string, unknown>,
      createdAt: Date,
    ) =>
      addTask(owner.id, { ...validTask, title, ...fields }, createdAt);
    await add(
      "Zebra low",
      { dueDate: "2026-10-18", dueTime: null, priority: "low" },
      new Date(TEST_NOW.getTime() + 3000),
    );
    await add(
      "Bravo high",
      { dueDate: "2026-10-16", dueTime: null, priority: "high" },
      new Date(TEST_NOW.getTime() + 1000),
    );
    await add(
      "Charlie medium",
      { dueDate: "2026-10-17", dueTime: null, priority: "medium" },
      new Date(TEST_NOW.getTime() + 2000),
    );

    const order = async (
      sort: "due_asc" | "due_desc" | "created_asc" | "created_desc" | "priority_asc" | "priority_desc",
    ) =>
      (await getTaskList(
        database,
        owner.id,
        taskQuerySchema.parse({ sort }),
        TEST_NOW,
      )).tasks.map((task) => task.title);
    expect(await order("due_asc")).toEqual(["Bravo high", "Charlie medium", "Zebra low"]);
    expect(await order("due_desc")).toEqual(["Zebra low", "Charlie medium", "Bravo high"]);
    expect(await order("created_asc")).toEqual(["Bravo high", "Charlie medium", "Zebra low"]);
    expect(await order("created_desc")).toEqual(["Zebra low", "Charlie medium", "Bravo high"]);
    expect(await order("priority_desc")).toEqual(["Bravo high", "Charlie medium", "Zebra low"]);
    expect(await order("priority_asc")).toEqual(["Zebra low", "Charlie medium", "Bravo high"]);
  });

  it("searches task titles and nullable descriptions case-insensitively", async () => {
    const owner = await addUser("description-search@example.com", "Search");
    const add = (title: string, description: string | null) =>
      createTask(
        database,
        owner.id,
        createTaskSchema.parse({ ...validTask, title, description }),
        TEST_NOW,
      );
    const titleMatch = await add("Needle in title", null);
    const descriptionMatch = await add(
      "A separate task",
      "Remember the Hidden Phrase for later.",
    );
    const bothMatch = await add(
      "Hidden phrase in title",
      "The hidden phrase appears here too.",
    );
    await add("No relevant text", "");

    const search = async (q: string) =>
      (await getTaskList(
        database,
        owner.id,
        taskQuerySchema.parse({ q }),
        TEST_NOW,
      )).tasks;

    expect((await search(" NEEDLE ")).map((task) => task.id)).toEqual([
      titleMatch.id,
    ]);
    expect((await search("hIdDeN pHrAsE")).map((task) => task.id)).toEqual([
      descriptionMatch.id,
      bothMatch.id,
    ]);
    expect(await search("no matching phrase")).toEqual([]);
    expect(await search("")).toHaveLength(4);
  });

  it("calculates due dates and overdue status in the configured application timezone", async () => {
    vi.stubEnv("APP_TIME_ZONE", "America/Los_Angeles");
    const owner = await addUser("timezone@example.com", "Timezone");
    await addTask(owner.id, {
      ...validTask,
      title: "Yesterday without a time",
      dueDate: "2026-10-13",
      dueTime: null,
    });
    await addTask(owner.id, {
      ...validTask,
      title: "Past due tonight",
      dueDate: "2026-10-14",
      dueTime: "23:00",
    });
    await addTask(owner.id, {
      ...validTask,
      title: "Tomorrow by local date",
      dueDate: "2026-10-15",
      dueTime: null,
    });
    await addTask(owner.id, {
      ...validTask,
      title: "Completed yesterday",
      dueDate: "2026-10-13",
      dueTime: null,
      status: "completed",
    });

    const justBeforeLocalMidnight = new Date("2026-10-15T06:30:00.000Z");
    const all = await getTaskList(
      database,
      owner.id,
      taskQuerySchema.parse({}),
      justBeforeLocalMidnight,
    );
    expect(all.timeZone).toBe("America/Los_Angeles");
    expect(all.today).toBe("2026-10-14");
    expect(
      all.tasks.filter((task) => task.isOverdue).map((task) => task.title).sort(),
    ).toEqual(["Past due tonight", "Yesterday without a time"]);
    expect(all.summary.overdue).toBe(2);
    expect(
      (await getTaskList(
        database,
        owner.id,
        taskQuerySchema.parse({ date: "tomorrow" }),
        justBeforeLocalMidnight,
      )).tasks.map((task) => task.title),
    ).toEqual(["Tomorrow by local date"]);
  });

  it("persists a task in PostgreSQL", async () => {
    const owner = await addUser("persist@example.com", "Persist");
    const task = await createTask(
      database,
      owner.id,
      createTaskSchema.parse(validTask),
      TEST_NOW,
    );
    const persisted = await getTaskList(
      database,
      owner.id,
      taskQuerySchema.parse({}),
      TEST_NOW,
    );
    expect(persisted.tasks).toHaveLength(1);
    expect(persisted.tasks[0]).toMatchObject({ id: task.id, title: task.title });
  });
});
