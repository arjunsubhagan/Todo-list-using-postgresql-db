import { z } from "zod";
import {
  TASK_DATE_FILTERS,
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES,
} from "./types";

const nullableDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const leapYear =
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [
      31,
      leapYear ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
  }, "Enter a valid calendar date.")
  .nullable();

const nullableTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Enter a valid time.")
  .nullable();

const titleSchema = z
  .string()
  .trim()
  .min(1, "Enter a task title.")
  .max(200, "Title must be 200 characters or fewer.");
const descriptionSchema = z
  .string()
  .max(5000, "Description must be 5,000 characters or fewer.")
  .nullable()
  .transform((value) => (value?.trim() ? value.trim() : null));
const categorySchema = z
  .string()
  .trim()
  .max(80, "Category must be 80 characters or fewer.")
  .nullable()
  .transform((value) => (value?.trim() ? value.trim() : null));

const taskFieldsSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema.default(null),
    dueDate: nullableDateSchema.optional().default(null),
    dueTime: nullableTimeSchema.optional().default(null),
    priority: z.enum(TASK_PRIORITIES).default("medium"),
    status: z.enum(TASK_STATUSES).default("pending"),
    category: categorySchema.default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dueTime && !value.dueDate) {
      context.addIssue({
        code: "custom",
        path: ["dueTime"],
        message: "Please select a due date.",
      });
    }
  });

export const createTaskSchema = taskFieldsSchema.superRefine(
  (value, context) => {
    if (!value.dueDate && !value.dueTime) {
      context.addIssue({
        code: "custom",
        path: ["dueDate"],
        message: "Due date and due time are required.",
      });
      context.addIssue({
        code: "custom",
        path: ["dueTime"],
        message: "Due date and due time are required.",
      });
    } else if (!value.dueDate) {
      context.addIssue({
        code: "custom",
        path: ["dueDate"],
        message: "Please select a due date.",
      });
    } else if (!value.dueTime) {
      context.addIssue({
        code: "custom",
        path: ["dueTime"],
        message: "Please select a due time.",
      });
    }
  },
);

export const taskEditorSchema = taskFieldsSchema;

export const updateTaskSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    dueDate: nullableDateSchema.optional(),
    dueTime: nullableTimeSchema.optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    category: categorySchema.optional(),
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Include at least one task field to update.",
  });

export const bulkDeleteTasksSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(10000),
  })
  .strict()
  .refine(({ ids }) => new Set(ids).size === ids.length, {
    message: "Task IDs must be unique.",
    path: ["ids"],
  });

export const deleteAllTasksSchema = z
  .object({ all: z.literal(true) })
  .strict();

export const taskQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    date: z.enum(TASK_DATE_FILTERS).default("all"),
    from: z.string().optional().default(""),
    to: z.string().optional().default(""),
    status: z.union([z.enum(TASK_STATUSES), z.literal("")]).default(""),
    priority: z.union([z.enum(TASK_PRIORITIES), z.literal("")]).default(""),
    category: z.string().trim().max(80).default(""),
    sort: z.enum(TASK_SORTS).default("due_asc"),
  })
  .strict()
  .superRefine((value, context) => {
    const validDate = (date: string) =>
      date === "" ||
      (nullableDateSchema.safeParse(date).success);
    if (!validDate(value.from)) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: "Enter a valid start date.",
      });
    }
    if (!validDate(value.to)) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "Enter a valid end date.",
      });
    }
    if (value.date === "custom") {
      if (!value.from || !value.to) {
        context.addIssue({
          code: "custom",
          path: ["from"],
          message: "Choose both a start and end date.",
        });
      } else if (value.from > value.to) {
        context.addIssue({
          code: "custom",
          path: ["to"],
          message: "The end date must be on or after the start date.",
        });
      }
    } else if (value.from || value.to) {
      context.addIssue({
        code: "custom",
        path: ["date"],
        message: "Date ranges can only be used with the custom filter.",
      });
    }
  });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type BulkDeleteTasksInput = z.infer<typeof bulkDeleteTasksSchema>;
export type TaskQueryInput = z.infer<typeof taskQuerySchema>;
