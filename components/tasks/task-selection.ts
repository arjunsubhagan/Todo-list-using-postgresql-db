import type { TaskStatus } from "@/lib/tasks/types";

export function isTaskSelected(
  selectedTaskIds: ReadonlySet<string>,
  taskId: string,
): boolean {
  return selectedTaskIds.has(taskId);
}

export function isOnlyTaskSelected(
  selectedTaskIds: ReadonlySet<string>,
  taskId: string,
): boolean {
  return (
    selectedTaskIds.size === 1 &&
    selectedTaskIds.has(taskId)
  );
}

export function toggleTaskSelection(
  selectedTaskIds: ReadonlySet<string>,
  taskId: string,
): Set<string> {
  const next = new Set(selectedTaskIds);
  if (next.has(taskId)) {
    next.delete(taskId);
  } else {
    next.add(taskId);
  }
  return next;
}

export function taskBulbAppearance(
  isSelected: boolean,
  status: TaskStatus,
): string {
  if (isSelected) {
    return "border-sky-700 bg-sky-600 text-white shadow-md";
  }
  return status === "completed"
    ? "border-emerald-800 bg-emerald-800 text-white"
    : "border-stone-400 bg-white";
}
