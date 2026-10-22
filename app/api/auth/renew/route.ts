import { getDatabase } from "@/lib/db";
import { renewHandler } from "@/lib/auth/http";

export async function POST(request: Request) {
  return renewHandler(request, await getDatabase());
}
