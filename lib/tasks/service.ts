import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "@/lib/db";
import type {
  Task,
  TaskDateFilter,
  TaskFields,
  TaskListResult,
  TaskPriority,
  TaskSort,
  TaskStatus,
} from "./types";
import {
  createTaskSchema,
  taskEditorSchema,
  type CreateTaskInput,
  type TaskQueryInput,
  type UpdateTaskInput,
} from "./validation";

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  due_time: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  category: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export class TaskNotFoundError extends Error {
  constructor() {
    super("Task not found.");
    this.name = "TaskNotFoundError";
  }
}

export class TaskConflictError extends Error {
  constructor() {
    super("The task was changed by another request.");
    this.name = "TaskConflictError";
  }
}

function getTimeZone(): string {
  const configured = process.env.APP_TIME_ZONE?.trim();
  const timeZone =
    configured || Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.DateTimeFormat("en-US", { timeZone });
  return timeZone;
}

function dateParts(
  date: Date,
  timeZone: string,
): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function mondayOfWeek(date: string): string {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addCalendarDays(date, -((weekday + 6) % 7));
}

function isOverdue(
  row: Pick<TaskRow, "due_date" | "due_time" | "status">,
  today: string,
  currentTime: string,
): boolean {
  if (row.status === "completed" || !row.due_date) {
    return false;
  }
  return (
    row.due_date < today ||
    (row.due_date === today &&
      Boolean(row.due_time && `${row.due_time}:00` < currentTime))
  );
}

function taskFromRow(
  row: TaskRow,
  today: string,
  currentTime: string,
): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    dueDate: row.due_date,
    dueTime: row.due_time,
    priority: row.priority,
    status: row.status,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    isOverdue: isOverdue(row, today, currentTime),
  };
}

function taskFields(task: Task): TaskFields {
  return {
    title: task.title,
    description: task.description,
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    priority: task.priority,
    status: task.status,
    category: task.category,
  };
}

function buildFilter(
  query: TaskQueryInput,
  userId: string,
  today: string,
  currentTime: string,
): { clause: string; values: unknown[] } {
  const clauses = ["user_id = $1"];
  const values: unknown[] = [userId];
  const addClause = (expression: string, ...parameters: unknown[]) => {
    let parameterIndex = 0;
    const sql = expression.replace(/\?/g, () => {
      values.push(parameters[parameterIndex]);
      parameterIndex += 1;
      return `$${values.length}`;
    });
    clauses.push(sql);
  };

  const dateFilters: Record<TaskDateFilter, () => void> = {
    all: () => undefined,
    today: () => {
      addClause("due_date = ?", today);
    },
    tomorrow: () => {
      addClause("due_date = ?", addCalendarDays(today, 1));
    },
    this_week: () => {
      addClause(
        "due_date BETWEEN ? AND ?",
        mondayOfWeek(today),
        addCalendarDays(mondayOfWeek(today), 6),
      );
    },
    upcoming: () => {
      addClause("due_date > ? AND status <> 'completed'", today);
    },
    overdue: () => {
      addClause(
        "status <> 'completed' AND (due_date < ? OR (due_date = ? AND due_time IS NOT NULL AND due_time || ':00' < ?))",
        today,
        today,
        currentTime,
      );
    },
    completed: () => {
      clauses.push("status = 'completed'");
    },
    custom: () => {
      addClause("due_date BETWEEN ? AND ?", query.from, query.to);
    },
  };
  dateFilters[query.date]();

  if (query.status) {
    addClause("status = ?", query.status);
  }
  if (query.priority) {
    addClause("priority = ?", query.priority);
  }

  return { clause: clauses.join(" AND "), values };
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

const TASK_COLLATOR = new Intl.Collator("en-US", {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
});

function compareText(left: string, right: string): number {
  return TASK_COLLATOR.compare(left, right);
}

function compareTasks(left: TaskRow, right: TaskRow, sort: TaskSort): number {
  const titleOrder = () =>
    compareText(left.title, right.title) || left.id.localeCompare(right.id);
  switch (sort) {
    case "due_asc":
    case "due_desc": {
      if (left.due_date === null || right.due_date === null) {
        if (left.due_date === null && right.due_date !== null) return 1;
        if (left.due_date !== null && right.due_date === null) return -1;
      } else {
        const direction = sort === "due_asc" ? 1 : -1;
        const dateOrder = left.due_date.localeCompare(right.due_date);
        if (dateOrder) return dateOrder * direction;
        const timeOrder = (left.due_time ?? "").localeCompare(
          right.due_time ?? "",
        );
        if (timeOrder) return timeOrder * direction;
      }
      return titleOrder();
    }
    case "created_desc":
    case "created_asc": {
      const direction = sort === "created_desc" ? -1 : 1;
      return (
        left.created_at.localeCompare(right.created_at) * direction ||
        left.id.localeCompare(right.id)
      );
    }
    case "priority_desc":
    case "priority_asc": {
      const rank: Record<TaskPriority, number> =
        sort === "priority_desc"
          ? { high: 0, medium: 1, low: 2 }
          : { low: 0, medium: 1, high: 2 };
      return rank[left.priority] - rank[right.priority] || titleOrder();
    }
    case "title_asc":
      return titleOrder();
  }
}

export async function getTaskList(
  database: Pool,
  userId: string,
  query: TaskQueryInput,
  now = new Date(),
): Promise<TaskListResult> {
  const timeZone = getTimeZone();
  const { date: today, time: currentTime } = dateParts(now, timeZone);
  const filter = buildFilter(query, userId, today, currentTime);
  const { rows } = await database.query<TaskRow>(
    `SELECT id, title, description, due_date, due_time, priority, status,
            category, created_at, updated_at, completed_at
     FROM tasks
     WHERE ${filter.clause}`,
    filter.values,
  );
  const search = normalizedText(query.q);
  const category = normalizedText(query.category);
  const filteredRows = rows
    .filter(
      (row) =>
        (!search ||
          normalizedText(row.title).includes(search) ||
          normalizedText(row.description ?? "").includes(search)) &&
        (!category ||
          (row.category !== null && normalizedText(row.category) === category)),
    )
    .sort((left, right) => compareTasks(left, right, query.sort));
  const { rows: summaryRows } = await database.query<
    Pick<TaskRow, "id" | "due_date" | "due_time" | "status">
  >(
    `SELECT id, due_date, due_time, status
     FROM tasks
     WHERE user_id = $1`,
    [userId],
  );

  return {
    tasks: filteredRows.map((row) => taskFromRow(row, today, currentTime)),
    summary: {
      total: summaryRows.length,
      pending: summaryRows.filter((row) => row.status === "pending").length,
      completed: summaryRows.filter((row) => row.status === "completed").length,
      overdue: summaryRows.filter((row) =>
        isOverdue(row, today, currentTime),
      ).length,
    },
    today,
    timeZone,
  };
}

export async function getTask(
  database: Pool,
  userId: string,
  taskId: string,
  now = new Date(),
): Promise<Task> {
  const { rows } = await database.query<TaskRow>(
    `SELECT id, title, description, due_date, due_time, priority, status,
            category, created_at, updated_at, completed_at
     FROM tasks
     WHERE id = $1 AND user_id = $2`,
    [taskId, userId],
  );
  const row = rows[0];
  if (!row) {
    throw new TaskNotFoundError();
  }

  const timeZone = getTimeZone();
  const { date: today, time: currentTime } = dateParts(now, timeZone);
  return taskFromRow(row, today, currentTime);
}

export async function createTask(
  database: Pool,
  userId: string,
  input: CreateTaskInput,
  now = new Date(),
): Promise<Task> {
  const fields = createTaskSchema.parse(input);
  const id = randomUUID();
  const timestamp = now.toISOString();
  const completedAt = fields.status === "completed" ? timestamp : null;
  await database.query(
    `INSERT INTO tasks (
       id, user_id, title, description, due_date, due_time, priority, status,
       category, created_at, updated_at, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      userId,
      fields.title,
      fields.description,
      fields.dueDate,
      fields.dueTime,
      fields.priority,
      fields.status,
      fields.category,
      timestamp,
      timestamp,
      completedAt,
    ],
  );
  return getTask(database, userId, id, now);
}

export async function updateTask(
  database: Pool,
  userId: string,
  taskId: string,
  input: UpdateTaskInput,
  now = new Date(),
): Promise<Task> {
  await withTransaction(database, async (client) => {
    const { rows } = await client.query<TaskRow>(
      `SELECT id, title, description, due_date, due_time, priority, status,
              category, created_at, updated_at, completed_at
       FROM tasks WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [taskId, userId],
    );
    const row = rows[0];
    if (!row) {
      throw new TaskNotFoundError();
    }
    if (
      input.expectedUpdatedAt &&
      input.expectedUpdatedAt !== row.updated_at
    ) {
      throw new TaskConflictError();
    }

    const current = taskFields(taskFromRow(row, "", ""));
    const fields = taskEditorSchema.parse({
      ...current,
      ...Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== "expectedUpdatedAt"),
      ),
    });
    const sameOptionalText = (
      value: string | null,
      original: string | null,
    ) => (value?.trim() || null) === (original?.trim() || null);
    const unchanged =
      fields.title === row.title &&
      sameOptionalText(fields.description, row.description) &&
      fields.dueDate === row.due_date &&
      fields.dueTime === row.due_time &&
      fields.priority === row.priority &&
      fields.status === row.status &&
      sameOptionalText(fields.category, row.category);
    if (unchanged) {
      return;
    }

    const timestamp = now.toISOString();
    const completedAt =
      fields.status === "completed"
        ? row.status === "completed" && row.completed_at
          ? row.completed_at
          : timestamp
        : null;
    const result = await client.query(
      `UPDATE tasks
       SET title = $1, description = $2, due_date = $3, due_time = $4,
           priority = $5, status = $6, category = $7, updated_at = $8, completed_at = $9
       WHERE id = $10 AND user_id = $11 AND updated_at = $12`,
      [
        fields.title,
        fields.description,
        fields.dueDate,
        fields.dueTime,
        fields.priority,
        fields.status,
        fields.category,
        timestamp,
        completedAt,
        taskId,
        userId,
        row.updated_at,
      ],
    );
    if (result.rowCount !== 1) {
      throw new TaskConflictError();
    }
  });
  return getTask(database, userId, taskId, now);
}

export async function deleteTask(
  database: Pool,
  userId: string,
  taskId: string,
): Promise<void> {
  const result = await database.query(
    "DELETE FROM tasks WHERE id = $1 AND user_id = $2",
    [taskId, userId],
  );
  if (result.rowCount !== 1) {
    throw new TaskNotFoundError();
  }
}

export async function deleteTasks(
  database: Pool,
  userId: string,
  taskIds: string[],
): Promise<number> {
  return withTransaction(database, async (client) => {
    const result = await client.query(
      "DELETE FROM tasks WHERE user_id = $1 AND id = ANY($2::text[])",
      [userId, taskIds],
    );
    if (result.rowCount !== taskIds.length) {
      throw new TaskNotFoundError();
    }
    return result.rowCount ?? 0;
  });
}

export async function deleteAllTasks(
  database: Pool,
  userId: string,
): Promise<number> {
  const result = await database.query(
    "DELETE FROM tasks WHERE user_id = $1",
    [userId],
  );
  return result.rowCount ?? 0;
}
