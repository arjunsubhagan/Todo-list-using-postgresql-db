import { getDatabase } from "@/lib/db";
import { registerHandler } from "@/lib/auth/http";

export async function POST(request: Request) {
  return registerHandler(request, await getDatabase());
}
