import { connection } from "next/server";
import { getDatabase } from "@/lib/db";
import { createTaskHandler, listTasksHandler } from "@/lib/tasks/http";

export async function GET(request: Request) {
  await connection();
  return listTasksHandler(request, await getDatabase());
}

export async function POST(request: Request) {
  return createTaskHandler(request, await getDatabase());
}
