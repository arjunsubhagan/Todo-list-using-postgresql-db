import { TaskDashboard } from "@/components/tasks/task-dashboard";
import { requireCurrentUser } from "@/lib/auth/current-user";

export const instant = false;

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  return <TaskDashboard user={user} />;
}
