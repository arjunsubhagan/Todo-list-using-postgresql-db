import { describe, expect, it } from "vitest";
import {
  isOnlyTaskSelected,
  isTaskSelected,
  taskBulbAppearance,
  toggleTaskSelection,
} from "@/components/tasks/task-selection";

describe("task bulb selection", () => {
  it("selects and deselects each task independently by ID", () => {
    const initial = new Set<string>();
    const firstSelected = toggleTaskSelection(initial, "task-1");
    const secondSelected = toggleTaskSelection(firstSelected, "task-2");
    const thirdSelected = toggleTaskSelection(secondSelected, "task-3");

    expect([...initial]).toEqual([]);
    expect([...thirdSelected]).toEqual(["task-1", "task-2", "task-3"]);

    const secondDeselected = toggleTaskSelection(thirdSelected, "task-2");
    expect([...secondDeselected]).toEqual(["task-1", "task-3"]);
    expect([...thirdSelected]).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("enables actions only for individually selected task IDs", () => {
    expect(isOnlyTaskSelected(new Set(), "task-1")).toBe(false);
    const selected = toggleTaskSelection(
      toggleTaskSelection(new Set<string>(), "task-1"),
      "task-2",
    );
    expect(isTaskSelected(selected, "task-1")).toBe(true);
    expect(isTaskSelected(selected, "task-2")).toBe(true);
    expect(isTaskSelected(selected, "task-3")).toBe(false);
    expect(isOnlyTaskSelected(selected, "task-1")).toBe(false);

    const afterDeselect = toggleTaskSelection(selected, "task-1");
    expect(isTaskSelected(afterDeselect, "task-1")).toBe(false);
    expect(isTaskSelected(afterDeselect, "task-2")).toBe(true);
    expect(isOnlyTaskSelected(afterDeselect, "task-2")).toBe(true);
  });

  it("shows a distinct selected appearance without changing task status styles", () => {
    expect(taskBulbAppearance(true, "pending")).toContain("bg-sky-600");
    expect(taskBulbAppearance(false, "pending")).toContain("bg-white");
    expect(taskBulbAppearance(false, "completed")).toContain("bg-emerald-800");
    expect(taskBulbAppearance(true, "completed")).toContain("bg-sky-600");
  });
});
