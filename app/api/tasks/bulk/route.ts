import { getDatabase } from "@/lib/db";
import { bulkDeleteTasksHandler } from "@/lib/tasks/http";

export async function DELETE(request: Request) {
  return bulkDeleteTasksHandler(request, await getDatabase());
}
