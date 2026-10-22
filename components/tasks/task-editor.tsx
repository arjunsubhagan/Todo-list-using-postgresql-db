"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Task, TaskFields } from "@/lib/tasks/types";
import { createTaskSchema, taskEditorSchema } from "@/lib/tasks/validation";

type TaskEditorProps = {
  task: Task | null;
  onCancel: () => void;
  onSave: (fields: TaskFields, expectedUpdatedAt?: string) => Promise<void>;
};

type ApiFailure = {
  error?: {
    message?: string;
    fields?: Record<string, string>;
  };
};

function initialFields(task: Task | null): TaskFields {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    dueDate: task?.dueDate ?? null,
    dueTime: task?.dueTime ?? null,
    priority: task?.priority ?? "medium",
    status: task?.status ?? "pending",
    category: task?.category ?? null,
  };
}

export function TaskEditor({ task, onCancel, onSave }: TaskEditorProps) {
  const titleInput = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState<TaskFields>(() => initialFields(task));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState(false);
  const initial = initialFields(task);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    titleInput.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  function change<K extends keyof TaskFields>(
    key: K,
    value: TaskFields[K],
  ) {
    const updated = { ...fields, [key]: value };
    setFields(updated);
    if (!task && (key === "dueDate" || key === "dueTime")) {
      const missingDate = !updated.dueDate;
      const missingTime = !updated.dueTime;
      const message =
        missingDate && missingTime
          ? "Due date and due time are required."
          : missingDate
            ? "Please select a due date."
            : missingTime
              ? "Please select a due time."
              : "";
      setErrors((current) => ({
        ...current,
        dueDate: missingDate ? message : "",
        dueTime: missingTime ? message : "",
      }));
    } else {
      setErrors((current) => ({ ...current, [key]: "" }));
    }
    setFormError("");
  }

  function cancel() {
    const dirty = Object.keys(initial).some((key) => {
      const field = key as keyof TaskFields;
      return (fields[field] ?? "") !== (initial[field] ?? "");
    });
    if (dirty && !window.confirm("Discard your unsaved task changes?")) {
      return;
    }
    onCancel();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    const submitted = {
      ...fields,
      description: fields.description?.trim() || null,
      category: fields.category?.trim() || null,
      dueDate: fields.dueDate || null,
      dueTime: fields.dueTime || null,
    };
    if (!task && (!submitted.dueDate || !submitted.dueTime)) {
      const missingDate = !submitted.dueDate;
      const missingTime = !submitted.dueTime;
      const message =
        missingDate && missingTime
          ? "Due date and due time are required."
          : missingDate
            ? "Please select a due date."
            : "Please select a due time.";
      setFormError(message);
      setErrors({
        ...(missingDate ? { dueDate: message } : {}),
        ...(missingTime ? { dueTime: message } : {}),
      });
      return;
    }

    const parsed = (task ? taskEditorSchema : createTaskSchema).safeParse(
      submitted,
    );
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !nextErrors[key]) {
          nextErrors[key] = issue.message;
        }
      }
      setErrors(nextErrors);
      return;
    }

    setPending(true);
    setErrors({});
    try {
      await onSave(parsed.data, task?.updatedAt);
    } catch (error) {
      if (error instanceof Response) {
        const failure = (await error.json()) as ApiFailure;
        setFormError(
          failure.error?.message ?? "Could not save the task. Please try again.",
        );
        setErrors(failure.error?.fields ?? {});
      } else {
        setFormError("Unable to reach the app. Check your connection and retry.");
      }
    } finally {
      setPending(false);
    }
  }

  const fieldClass =
    "mt-1 min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-stone-900 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/20";

  return (
    <div
      aria-labelledby="task-editor-title"
      aria-describedby="task-editor-description"
      aria-modal="true"
      className="fixed inset-0 z-20 flex items-end justify-center bg-stone-950/50 p-0 sm:items-center sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
          return;
        }
        if (event.key !== "Tab") return;

        const focusable = event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        );
        const first = focusable.item(0);
        const last = focusable.item(focusable.length - 1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      role="dialog"
    >
      <section className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:max-h-[90vh] sm:rounded-3xl sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-emerald-800">
              {task ? "Update your list" : "Make a little progress"}
            </p>
            <h2
              className="mt-1 text-2xl font-semibold tracking-tight"
              id="task-editor-title"
            >
              {task ? "Edit task" : "Add a task"}
            </h2>
            <p className="sr-only" id="task-editor-description">
              {task
                ? "Update the task details. Required fields are marked."
                : "Enter the details for your new task. Required fields are marked."}
            </p>
          </div>
          <button
            aria-label="Close task form"
            className="min-h-11 min-w-11 rounded-lg px-3 py-2 text-xl text-stone-600 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
            onClick={cancel}
            type="button"
          >
            ×
          </button>
        </div>

        <form
          aria-busy={pending}
          className="mt-6 space-y-4"
          noValidate
          onSubmit={submit}
        >
          {formError && (
            <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
              {formError}
            </p>
          )}

          <div>
            <label className="text-sm font-medium" htmlFor="task-title">
              Title <span aria-hidden="true">*</span>
            </label>
            <input
              aria-describedby={errors.title ? "task-title-error" : undefined}
              aria-invalid={Boolean(errors.title)}
              className={fieldClass}
              id="task-title"
              maxLength={200}
              onChange={(event) => change("title", event.target.value)}
              ref={titleInput}
              required
              value={fields.title}
            />
            {errors.title && (
              <p className="mt-1 text-sm text-red-700" id="task-title-error">
                {errors.title}
              </p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium" htmlFor="task-description">
              Description
            </label>
            <textarea
              aria-describedby={
                errors.description ? "task-description-error" : undefined
              }
              aria-invalid={Boolean(errors.description)}
              className={fieldClass}
              id="task-description"
              maxLength={5000}
              onChange={(event) => change("description", event.target.value)}
              rows={3}
              value={fields.description ?? ""}
            />
            {errors.description && (
              <p
                className="mt-1 text-sm text-red-700"
                id="task-description-error"
              >
                {errors.description}
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium" htmlFor="task-due-date">
                Due date {!task && <span aria-hidden="true">*</span>}
              </label>
              <input
                aria-describedby={errors.dueDate ? "task-date-error" : undefined}
                aria-invalid={Boolean(errors.dueDate)}
                aria-required={!task}
                className={`${fieldClass} aria-invalid:border-red-600 aria-invalid:focus:border-red-600 aria-invalid:focus:ring-red-600/20`}
                id="task-due-date"
                onChange={(event) =>
                  change("dueDate", event.target.value || null)
                }
                type="date"
                value={fields.dueDate ?? ""}
              />
              {errors.dueDate && (
                <p className="mt-1 text-sm text-red-700" id="task-date-error">
                  {errors.dueDate}
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="task-due-time">
                Due time {!task && <span aria-hidden="true">*</span>}
              </label>
              <input
                aria-describedby={errors.dueTime ? "task-time-error" : undefined}
                aria-invalid={Boolean(errors.dueTime)}
                aria-required={!task}
                className={`${fieldClass} aria-invalid:border-red-600 aria-invalid:focus:border-red-600 aria-invalid:focus:ring-red-600/20`}
                id="task-due-time"
                onChange={(event) =>
                  change("dueTime", event.target.value || null)
                }
                type="time"
                value={fields.dueTime ?? ""}
              />
              {errors.dueTime && (
                <p className="mt-1 text-sm text-red-700" id="task-time-error">
                  {errors.dueTime}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="text-sm font-medium" htmlFor="task-priority">
                Priority
              </label>
              <select
                className={fieldClass}
                id="task-priority"
                onChange={(event) =>
                  change(
                    "priority",
                    event.target.value as TaskFields["priority"],
                  )
                }
                value={fields.priority}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="task-status">
                Status
              </label>
              <select
                className={fieldClass}
                id="task-status"
                onChange={(event) =>
                  change("status", event.target.value as TaskFields["status"])
                }
                value={fields.status}
              >
                <option value="pending">Pending</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="task-category">
                Category
              </label>
              <input
                aria-describedby={
                  errors.category ? "task-category-error" : undefined
                }
                aria-invalid={Boolean(errors.category)}
                className={fieldClass}
                id="task-category"
                maxLength={80}
                onChange={(event) =>
                  change("category", event.target.value || null)
                }
                value={fields.category ?? ""}
              />
              {errors.category && (
                <p
                  className="mt-1 text-sm text-red-700"
                  id="task-category-error"
                >
                  {errors.category}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
            <button
              className="min-h-11 rounded-xl border border-stone-300 px-5 py-2.5 font-medium hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
              disabled={pending}
              onClick={cancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="min-h-11 rounded-xl bg-emerald-800 px-5 py-2.5 font-medium text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 disabled:opacity-60"
              disabled={pending}
              type="submit"
            >
              {pending ? "Saving…" : task ? "Save changes" : "Add task"}
              {pending && <span className="sr-only">Please wait.</span>}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
