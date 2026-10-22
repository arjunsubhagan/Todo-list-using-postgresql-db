import { connection } from "next/server";
import { getDatabase } from "@/lib/db";
import { sessionHandler } from "@/lib/auth/http";

export async function GET(request: Request) {
  await connection();
  return sessionHandler(request, await getDatabase());
}
