export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export const TASK_DATE_FILTERS = [
  "all",
  "today",
  "tomorrow",
  "this_week",
  "upcoming",
  "overdue",
  "completed",
  "custom",
] as const;
export const TASK_SORTS = [
  "due_asc",
  "due_desc",
  "created_desc",
  "created_asc",
  "priority_desc",
  "priority_asc",
  "title_asc",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskDateFilter = (typeof TASK_DATE_FILTERS)[number];
export type TaskSort = (typeof TASK_SORTS)[number];

export type TaskFields = {
  title: string;
  description: string | null;
  dueDate: string | null;
  dueTime: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  category: string | null;
};

export type Task = TaskFields & {
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  isOverdue: boolean;
};

export type TaskFilters = {
  q: string;
  date: TaskDateFilter;
  from: string;
  to: string;
  status: "" | TaskStatus;
  priority: "" | TaskPriority;
  category: string;
  sort: TaskSort;
};

export type TaskSummary = {
  total: number;
  pending: number;
  completed: number;
  overdue: number;
};

export type TaskListResult = {
  tasks: Task[];
  summary: TaskSummary;
  today: string;
  timeZone: string;
};
