"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicUser } from "@/lib/auth/service";
import type {
  Task,
  TaskDateFilter,
  TaskFields,
  TaskFilters,
  TaskListResult,
  TaskPriority,
  TaskSort,
  TaskStatus,
  TaskSummary,
} from "@/lib/tasks/types";
import { LogoutButton } from "@/components/auth/logout-button";
import { SessionRenewal } from "@/components/auth/session-renewal";
import { TaskEditor } from "./task-editor";
import {
  isOnlyTaskSelected,
  isTaskSelected,
  taskBulbAppearance,
  toggleTaskSelection,
} from "./task-selection";

type TaskDashboardProps = {
  user: PublicUser;
};

type ApiResult<T> = {
  data: T | null;
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  } | null;
};

type DeleteRequest =
  | { kind: "task"; task: Task }
  | { kind: "selected"; taskIds: string[] }
  | { kind: "all" };

const INITIAL_FILTERS: TaskFilters = {
  q: "",
  date: "all",
  from: "",
  to: "",
  status: "",
  priority: "",
  category: "",
  sort: "due_asc",
};

const fieldClass =
  "min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/20";

function filtersUrl(filters: TaskFilters): string {
  const params = new URLSearchParams();
  params.set("q", filters.q);
  params.set("date", filters.date);
  params.set("sort", filters.sort);
  if (filters.date === "custom") {
    params.set("from", filters.from);
    params.set("to", filters.to);
  }
  if (filters.status) params.set("status", filters.status);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.category) params.set("category", filters.category);
  return `/api/tasks?${params.toString()}`;
}

function formatDueDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    dateStyle: "medium",
  }).format(date);
}

function formatTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(status: TaskStatus): string {
  return status === "in_progress"
    ? "In progress"
    : status === "completed"
      ? "Completed"
      : "Pending";
}

function priorityClass(priority: TaskPriority): string {
  if (priority === "high") return "bg-rose-100 text-rose-800";
  if (priority === "medium") return "bg-amber-100 text-amber-900";
  return "bg-stone-100 text-stone-700";
}

async function readFailure(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiResult<unknown>;
    return payload.error?.message ?? "The operation could not be completed.";
  } catch {
    return "The operation could not be completed.";
  }
}

type DeleteConfirmationProps = {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
};

function DeleteConfirmation({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
  pending,
}: DeleteConfirmationProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      aria-describedby="delete-task-description"
      aria-labelledby="delete-task-title"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border border-stone-200 bg-white p-0 text-stone-900 shadow-xl backdrop:bg-stone-950/50"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      ref={dialog}
    >
      <div className="p-6 sm:p-7">
        <p className="text-sm font-semibold text-rose-800">Confirm deletion</p>
        <h2 className="mt-2 text-xl font-semibold" id="delete-task-title">
          {title}
        </h2>
        <p
          className="mt-2 text-sm leading-6 text-stone-600"
          id="delete-task-description"
        >
          {description}
        </p>
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            autoFocus
            className="min-h-11 rounded-xl border border-stone-300 px-4 font-medium hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="min-h-11 rounded-xl bg-rose-700 px-4 font-medium text-white hover:bg-rose-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-800 disabled:cursor-wait disabled:opacity-60"
            disabled={pending}
            onClick={onConfirm}
            type="button"
          >
            {pending ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function TaskDashboard({ user }: TaskDashboardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [today, setToday] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  const [filters, setFilters] = useState<TaskFilters>(INITIAL_FILTERS);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [editorTask, setEditorTask] = useState<Task | null | undefined>();
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState("");
  const [bulkDeletePending, setBulkDeletePending] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
    () => new Set(),
  );

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(filtersUrl(filters), {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (response.status === 401) {
      window.location.replace("/login?reason=expired");
      return;
    }
    const payload = (await response.json()) as ApiResult<TaskListResult>;
    if (!response.ok || !payload.data) {
      throw new Error(
        payload.error?.message ?? "Could not load your tasks. Please retry.",
      );
    }
    setTasks(payload.data.tasks);
    const visibleTaskIds = new Set(payload.data.tasks.map((task) => task.id));
    setSelectedTaskIds((current) => {
      const next = new Set(
        [...current].filter((taskId) => visibleTaskIds.has(taskId)),
      );
      return next.size === current.size ? current : next;
    });
    setSummary(payload.data.summary);
    setToday(payload.data.today);
    setTimeZone(payload.data.timeZone);
    setPageError("");
  }, [filters]);

  useEffect(() => {
    if (
      filters.date === "custom" &&
      (!filters.from || !filters.to || filters.from > filters.to)
    ) {
      return;
    }

    const controller = new AbortController();
    const delay = window.setTimeout(() => {
      setLoading(true);
      void refresh(controller.signal)
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          setPageError(
            error instanceof Error
              ? error.message
              : "Could not load your tasks. Please retry.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, filters.q ? 250 : 0);
    return () => {
      window.clearTimeout(delay);
      controller.abort();
    };
  }, [filters, refresh]);

  async function saveTask(
    fields: TaskFields,
    expectedUpdatedAt?: string,
  ): Promise<void> {
    const editingTask = editorTask ?? null;
    const editing = editingTask !== null;
    const response = await fetch(
      editing
        ? `/api/tasks/${encodeURIComponent(editingTask.id)}`
        : "/api/tasks",
      {
        method: editing ? "PATCH" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editing ? { ...fields, expectedUpdatedAt } : fields,
        ),
      },
    );
    if (response.status === 401) {
      window.location.replace("/login?reason=expired");
      throw new Error("Your session has expired. Please sign in again.");
    }
    if (!response.ok) {
      throw response;
    }
    setEditorTask(undefined);
    setStatusMessage(editing ? "Task updated." : "Task added.");
    setPageError("");
    await refreshAfterMutation();
  }

  async function refreshAfterMutation() {
    try {
      await refresh();
    } catch (error) {
      setPageError(
        error instanceof Error
          ? error.message
          : "The change was saved, but the task list could not be refreshed.",
      );
    }
  }

  function removeTask(task: Task) {
    setDeleteRequest({ kind: "task", task });
  }

  async function confirmDelete() {
    const deletion = deleteRequest;
    if (!deletion) {
      return;
    }
    const singleTaskId =
      deletion.kind === "task"
        ? deletion.task.id
        : deletion.kind === "selected" && deletion.taskIds.length === 1
          ? deletion.taskIds[0]
          : null;
    if (singleTaskId) {
      setPendingTaskId(singleTaskId);
    } else {
      setBulkDeletePending(true);
    }
    setPageError("");
    try {
      const response =
        singleTaskId
          ? await fetch(
              `/api/tasks/${encodeURIComponent(singleTaskId)}`,
              {
                method: "DELETE",
                credentials: "same-origin",
                cache: "no-store",
              },
            )
          : await fetch("/api/tasks/bulk", {
              method: "DELETE",
              credentials: "same-origin",
              cache: "no-store",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                deletion.kind === "all"
                  ? { all: true }
                  : {
                      ids:
                        deletion.kind === "selected"
                          ? deletion.taskIds
                          : [deletion.task.id],
                    },
              ),
            });
      if (response.status === 401) {
        window.location.replace("/login?reason=expired");
        return;
      }
      if (!response.ok) {
        throw new Error(await readFailure(response));
      }
      setDeleteRequest(null);
      if (deletion.kind === "all") {
        setSelectedTaskIds(new Set());
        setStatusMessage("All tasks deleted.");
      } else if (deletion.kind === "selected") {
        setSelectedTaskIds((current) => {
          const next = new Set(current);
          deletion.taskIds.forEach((taskId) => next.delete(taskId));
          return next;
        });
        setStatusMessage(
          `${deletion.taskIds.length} ${
            deletion.taskIds.length === 1 ? "task" : "tasks"
          } deleted.`,
        );
      } else if (deletion.kind === "task") {
        setSelectedTaskIds((current) => {
          const next = new Set(current);
          next.delete(deletion.task.id);
          return next;
        });
        setStatusMessage("Task deleted.");
      }
      await refreshAfterMutation();
    } catch (error) {
      setDeleteRequest(null);
      setPageError(
        error instanceof Error
          ? error.message
          : "Could not delete the tasks. Please try again.",
      );
    } finally {
      setPendingTaskId("");
      setBulkDeletePending(false);
    }
  }

  function cancelDelete() {
    if (bulkDeletePending || pendingTaskId) {
      return;
    }
    setDeleteRequest(null);
  }

  function updateFilter<K extends keyof TaskFilters>(
    key: K,
    value: TaskFilters[K],
  ) {
    setStatusMessage("");
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function retryLoad() {
    setLoading(true);
    setPageError("");
    try {
      await refresh();
    } catch (error) {
      setPageError(
        error instanceof Error
          ? error.message
          : "Could not load your tasks. Please retry.",
      );
    } finally {
      setLoading(false);
    }
  }

  const completionPercent =
    summary && summary.total > 0
      ? Math.round((summary.completed / summary.total) * 100)
      : 0;
  const incompleteDateRange =
    filters.date === "custom" &&
    (!filters.from || !filters.to || filters.from > filters.to);
  const hasActiveFilters =
    Boolean(filters.q.trim()) ||
    filters.date !== "all" ||
    Boolean(filters.status) ||
    Boolean(filters.priority) ||
    Boolean(filters.category.trim());
  const selectedTaskCount = selectedTaskIds.size;

  const deleteConfirmation = deleteRequest
    ? deleteRequest.kind === "task"
      ? {
          title: `Delete “${deleteRequest.task.title}”?`,
          description:
            "This task will be permanently removed. This action cannot be undone.",
          confirmLabel: "Delete task",
        }
      : deleteRequest.kind === "selected"
        ? {
            title: `Delete ${deleteRequest.taskIds.length} selected ${
              deleteRequest.taskIds.length === 1 ? "task" : "tasks"
            }?`,
            description:
              "The selected tasks will be permanently removed. This action cannot be undone.",
            confirmLabel: "Delete selected",
          }
        : {
            title: "Delete all your tasks?",
            description:
              "Every task in your account will be permanently removed, including tasks hidden by the current filters. This action cannot be undone.",
            confirmLabel: "Delete all",
          }
    : null;

  const todayLabel = today
    ? new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(new Date(`${today}T12:00:00.000Z`))
    : "Loading date…";

  return (
    <main className="min-h-screen bg-[#f7f7f3] px-4 py-5 text-stone-900 sm:px-6 sm:py-8 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200/80 pb-4 sm:gap-4 sm:border-0 sm:pb-0">
          <Link
            aria-label="Daymark dashboard"
            className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-800"
            href="/dashboard"
          >
            <p className="text-sm font-semibold tracking-[0.2em] text-emerald-800">
              DAYMARK
            </p>
          </Link>
          <p className="order-3 w-full text-sm text-stone-500 sm:order-none sm:w-auto">
            {todayLabel}
          </p>
          <nav
            aria-label="Account"
            className="flex max-w-full flex-wrap items-center justify-end gap-2 sm:flex-nowrap sm:gap-3"
          >
            <SessionRenewal />
            <p
              className="max-w-[8rem] truncate text-sm text-stone-600 sm:max-w-48"
              title={user.name}
            >
              {user.name}
            </p>
            <LogoutButton />
          </nav>
        </header>

        <section className="mt-5 flex flex-col justify-between gap-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:mt-8 sm:rounded-3xl sm:p-8 lg:flex-row lg:items-end lg:p-9">
          <div className="min-w-0">
            <p className="text-sm font-medium text-emerald-800">
              Your personal workspace
            </p>
            <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight sm:text-4xl">
              Welcome, {user.name}.
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-stone-600 sm:text-base">
              Keep the important things moving, one task at a time.
            </p>
          </div>
          <button
            className="min-h-12 w-full shrink-0 cursor-pointer rounded-xl bg-emerald-800 px-5 py-3 font-medium text-white transition-[background-color] duration-300 ease-in-out hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 sm:w-auto"
            onClick={() => setEditorTask(null)}
            type="button"
          >
            Add task
          </button>
        </section>

        <section
          aria-label="Task summary"
          className="mt-4 grid grid-cols-2 gap-3 sm:mt-5 sm:gap-4 lg:grid-cols-4"
        >
          {[
            { label: "Total tasks", value: summary?.total ?? "—" },
            { label: "Pending", value: summary?.pending ?? "—" },
            { label: "Completed", value: summary?.completed ?? "—" },
            { label: "Overdue", value: summary?.overdue ?? "—" },
          ].map((item) => (
            <article
              className="min-w-0 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5"
              key={item.label}
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 sm:text-sm sm:normal-case sm:tracking-normal">
                {item.label}
              </p>
              <p className="mt-2 text-2xl font-semibold tabular-nums sm:text-3xl">
                {item.value}
              </p>
            </article>
          ))}
          <div className="col-span-2 rounded-2xl border border-stone-200 bg-white px-4 py-4 sm:px-5 lg:col-span-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-sm font-medium text-stone-700">
                Completion progress
              </p>
              <p className="text-sm tabular-nums text-stone-500">
                {summary
                  ? `${completionPercent}% complete`
                  : "Loading progress…"}
              </p>
            </div>
            <div
              aria-label="Task completion"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={summary ? completionPercent : undefined}
              aria-busy={!summary}
              className="mt-3 h-2 overflow-hidden rounded-full bg-stone-100"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-emerald-700 transition-[width] motion-reduce:transition-none"
                style={{ width: `${completionPercent}%` }}
              />
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-4 sm:mt-8 sm:rounded-3xl sm:p-6 lg:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3 sm:items-end">
            <div>
              <h2 className="text-lg font-semibold sm:text-xl">Your tasks</h2>
              <p aria-live="polite" className="mt-1 text-sm text-stone-500">
                {loading
                  ? "Updating your list…"
                  : `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} shown`}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                className="min-h-11 cursor-pointer rounded-lg px-2 text-sm font-medium text-emerald-800 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 sm:px-3"
                onClick={() => {
                  setFilters(INITIAL_FILTERS);
                  setStatusMessage("");
                }}
                type="button"
              >
                Reset filters
              </button>
              <button
                className="min-h-11 cursor-pointer rounded-xl border border-rose-300 px-3 py-2 text-sm font-medium text-rose-800 hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  selectedTaskCount === 0 ||
                  bulkDeletePending ||
                  Boolean(pendingTaskId)
                }
                onClick={() =>
                  setDeleteRequest({
                    kind: "selected",
                    taskIds: [...selectedTaskIds],
                  })
                }
                type="button"
              >
                Delete Selected ({selectedTaskCount})
              </button>
              <button
                className="min-h-11 cursor-pointer rounded-xl bg-rose-700 px-3 py-2 text-sm font-medium text-white hover:bg-rose-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  !summary ||
                  summary.total === 0 ||
                  bulkDeletePending ||
                  Boolean(pendingTaskId)
                }
                onClick={() => setDeleteRequest({ kind: "all" })}
                type="button"
              >
                Delete All
              </button>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <div className="sm:col-span-2 xl:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-stone-600" htmlFor="task-search">
                Search tasks
              </label>
              <div className="relative">
                <input
                  className={`${fieldClass} pr-10`}
                  id="task-search"
                  onChange={(event) => updateFilter("q", event.target.value)}
                  placeholder="Search by title or description..."
                  type="search"
                  value={filters.q}
                />
                {filters.q && (
                  <button
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-stone-500 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-emerald-800"
                    onClick={() => updateFilter("q", "")}
                    type="button"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-stone-600" htmlFor="task-date-filter">
                Due date
              </label>
              <select
                className={`${fieldClass} cursor-pointer`}
                id="task-date-filter"
                onChange={(event) =>
                  updateFilter("date", event.target.value as TaskDateFilter)
                }
                value={filters.date}
              >
                <option value="all">All dates</option>
                <option value="today">Today</option>
                <option value="tomorrow">Tomorrow</option>
                <option value="this_week">This week</option>
                <option value="upcoming">Upcoming</option>
                <option value="overdue">Overdue</option>
                <option value="completed">Completed</option>
                <option value="custom">Custom range</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-stone-600" htmlFor="task-sort">
                Sort by
              </label>
              <select
                className={`${fieldClass} cursor-pointer`}
                id="task-sort"
                onChange={(event) =>
                  updateFilter("sort", event.target.value as TaskSort)
                }
                value={filters.sort}
              >
                <option value="due_asc">Due date: earliest</option>
                <option value="due_desc">Due date: latest</option>
                <option value="created_desc">Created: newest</option>
                <option value="created_asc">Created: oldest</option>
                <option value="priority_desc">Priority: high to low</option>
                <option value="priority_asc">Priority: low to high</option>
                <option value="title_asc">Title: A to Z</option>
              </select>
            </div>
            {filters.date === "custom" && (
              <>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-stone-600" htmlFor="task-date-from">
                    From
                  </label>
                  <input
                    className={fieldClass}
                    id="task-date-from"
                    max={filters.to || undefined}
                    onChange={(event) =>
                      updateFilter("from", event.target.value)
                    }
                    type="date"
                    value={filters.from}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-stone-600" htmlFor="task-date-to">
                    To
                  </label>
                  <input
                    className={fieldClass}
                    id="task-date-to"
                    min={filters.from || undefined}
                    onChange={(event) => updateFilter("to", event.target.value)}
                    type="date"
                    value={filters.to}
                  />
                </div>
              </>
            )}
            <div>
              <label className="mb-1 block text-xs font-semibold text-stone-600" htmlFor="task-status-filter">
                Status
              </label>
              <select
                className={`${fieldClass} cursor-pointer`}
                id="task-status-filter"
                onChange={(event) =>
                  updateFilter("status", event.target.value as "" | TaskStatus)
                }
                value={filters.status}
              >
                <option value="">Any status</option>
                <option value="pending">Pending</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-stone-600" htmlFor="task-priority-filter">
                Priority
              </label>
              <select
                className={`${fieldClass} cursor-pointer`}
                id="task-priority-filter"
                onChange={(event) =>
                  updateFilter(
                    "priority",
                    event.target.value as "" | TaskPriority,
                  )
                }
                value={filters.priority}
              >
                <option value="">Any priority</option>
                <option value="high">High priority</option>
                <option value="medium">Medium priority</option>
                <option value="low">Low priority</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-stone-600" htmlFor="task-category-filter">
                Category
              </label>
              <input
                className={fieldClass}
                id="task-category-filter"
                maxLength={80}
                onChange={(event) =>
                  updateFilter("category", event.target.value)
                }
                placeholder="Any category"
                value={filters.category}
              />
            </div>
          </div>

          {pageError && summary !== null && !incompleteDateRange && (
            <div
              className="mt-5 flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between"
              role="alert"
            >
              <p>{pageError}</p>
              <button
                className="min-h-10 self-start rounded-lg px-2 font-semibold underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-800 sm:self-auto"
                onClick={() => void retryLoad()}
                type="button"
              >
                Try again
              </button>
            </div>
          )}
          {statusMessage && (
            <p
              className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
              role="status"
            >
              {statusMessage}
            </p>
          )}

          {incompleteDateRange ? (
            <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-stone-50/70 px-5 py-10 text-center sm:px-6 sm:py-12">
              <p className="font-medium">
                Choose a date range to see matching tasks.
              </p>
              <p className="mt-2 text-sm text-stone-600">
                Select a start and end date. The range includes both dates.
              </p>
            </div>
          ) : loading ? (
            <div
              aria-label="Loading tasks"
              aria-live="polite"
              className="mt-6 space-y-3"
              role="status"
            >
              <div className="h-28 animate-pulse rounded-2xl bg-stone-100 motion-reduce:animate-none" />
              <div className="h-28 animate-pulse rounded-2xl bg-stone-100 motion-reduce:animate-none" />
              <span className="sr-only">Loading tasks…</span>
            </div>
          ) : pageError && summary === null ? (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-8 text-center sm:px-6">
              <p className="font-medium text-red-900">
                Your tasks could not be loaded.
              </p>
              <p className="mt-2 text-sm text-red-800">{pageError}</p>
              <button
                className="mt-3 min-h-11 rounded-xl border border-red-300 px-4 font-medium text-red-900 hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-800"
                onClick={() => void retryLoad()}
                type="button"
              >Try again</button>
            </div>
          ) : tasks.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-stone-50/70 px-5 py-10 text-center sm:px-6 sm:py-12">
              <div
                aria-hidden="true"
                className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-lg font-semibold text-emerald-900"
              >
                {hasActiveFilters ? "⌕" : "+"}
              </div>
              <p className="font-medium">
                {hasActiveFilters
                  ? "No tasks match these filters."
                  : "Your list is ready when you are."}
              </p>
              <p className="mt-2 text-sm text-stone-600">
                {hasActiveFilters
                  ? "Try changing your search or resetting the filters."
                  : "Add your first task to get started."}
              </p>
              {hasActiveFilters ? (
                <button
                  className="mt-4 min-h-11 rounded-lg px-3 py-2 font-medium text-emerald-800 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
                  onClick={() => setFilters(INITIAL_FILTERS)}
                  type="button"
                >
                  Clear filters
                </button>
              ) : (
                <button
                  className="mt-4 min-h-11 rounded-xl bg-emerald-800 px-4 py-2.5 font-medium text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
                  onClick={() => setEditorTask(null)}
                  type="button"
                >
                  Add your first task
                </button>
              )}
            </div>
          ) : (
            <ul aria-busy={loading} className="mt-6 space-y-3" aria-label="Task list">
              {tasks.map((task) => (
                <li
                  className={`rounded-2xl border p-4 transition-colors sm:p-5 ${
                    task.status === "completed"
                      ? "border-stone-200 bg-stone-50"
                      : task.isOverdue
                        ? "border-rose-200 bg-rose-50/60"
                        : "border-stone-200 bg-white"
                  }`}
                  key={task.id}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
                    <div className="flex min-w-0 items-start gap-3 sm:flex-1">
                    <button
                      aria-label={
                        isTaskSelected(selectedTaskIds, task.id)
                          ? `Deselect ${task.title}`
                          : `Select ${task.title}`
                      }
                      aria-pressed={isTaskSelected(selectedTaskIds, task.id)}
                      className={`mt-0.5 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border text-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 ${taskBulbAppearance(isTaskSelected(selectedTaskIds, task.id), task.status)}`}
                      onClick={() =>
                        setSelectedTaskIds((current) =>
                          toggleTaskSelection(current, task.id),
                        )
                      }
                      type="button"
                    >
                      {isTaskSelected(selectedTaskIds, task.id) ||
                      task.status === "completed"
                        ? "✓"
                        : ""}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3
                          className={`break-words text-base font-semibold ${
                            task.status === "completed"
                              ? "text-stone-500 line-through"
                              : ""
                          }`}
                        >
                          {task.title}
                        </h3>
                        {task.isOverdue && (
                          <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-800">
                            Overdue
                          </span>
                        )}
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${priorityClass(task.priority)}`}
                        >
                          {task.priority[0].toUpperCase() +
                            task.priority.slice(1)}
                        </span>
                        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">
                          {statusLabel(task.status)}
                        </span>
                        {task.category && (
                          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-900">
                            {task.category}
                          </span>
                        )}
                      </div>
                      {task.description && (
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-stone-600">
                          {task.description}
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                        <span>
                          <span className="font-medium text-stone-600">Due:</span>{" "}
                          {task.dueDate ? (
                            <time dateTime={task.dueDate}>
                              {formatDueDate(task.dueDate)}
                              {task.dueTime ? ` at ${task.dueTime}` : ""}
                            </time>
                          ) : (
                            "No due date"
                          )}
                        </span>
                        <span>
                          Created{" "}
                          <time dateTime={task.createdAt}>
                            {formatTimestamp(task.createdAt, timeZone)}
                          </time>
                        </span>
                        {task.updatedAt !== task.createdAt && (
                          <span>
                            Updated{" "}
                            <time dateTime={task.updatedAt}>
                              {formatTimestamp(task.updatedAt, timeZone)}
                            </time>
                          </span>
                        )}
                      </div>
                    </div>
                    </div>
                    <div className="flex justify-end gap-2 border-t border-stone-200 pt-2 sm:shrink-0 sm:justify-start sm:border-0 sm:pt-0">
                      <button
                        className="min-h-11 cursor-pointer rounded-lg px-4 text-sm font-medium text-emerald-800 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={
                          !isOnlyTaskSelected(selectedTaskIds, task.id) ||
                          pendingTaskId === task.id
                        }
                        onClick={() => setEditorTask(task)}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className="min-h-11 cursor-pointer rounded-lg px-4 text-sm font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={
                          !isOnlyTaskSelected(selectedTaskIds, task.id) ||
                          pendingTaskId === task.id
                        }
                        onClick={() => void removeTask(task)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {editorTask !== undefined && (
        <TaskEditor
          key={editorTask?.id ?? "new"}
          onCancel={() => setEditorTask(undefined)}
          onSave={saveTask}
          task={editorTask}
        />
      )}
      {deleteRequest && deleteConfirmation && (
        <DeleteConfirmation
          confirmLabel={deleteConfirmation.confirmLabel}
          description={deleteConfirmation.description}
          onCancel={cancelDelete}
          onConfirm={() => void confirmDelete()}
          pending={bulkDeletePending || Boolean(pendingTaskId)}
          title={deleteConfirmation.title}
        />
      )}
    </main>
  );
}
