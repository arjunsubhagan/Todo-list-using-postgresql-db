import { getDatabase } from "@/lib/db";
import { logoutHandler } from "@/lib/auth/http";

export async function POST(request: Request) {
  return logoutHandler(request, await getDatabase());
}
