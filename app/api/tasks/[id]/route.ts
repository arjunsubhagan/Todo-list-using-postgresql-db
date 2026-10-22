import { getDatabase } from "@/lib/db";
import {
  deleteTaskHandler,
  readTaskHandler,
  updateTaskHandler,
} from "@/lib/tasks/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  return readTaskHandler(request, await getDatabase(), context);
}

export async function PATCH(request: Request, context: RouteContext) {
  return updateTaskHandler(request, await getDatabase(), context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return deleteTaskHandler(request, await getDatabase(), context);
}
