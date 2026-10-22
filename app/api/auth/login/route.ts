import { getDatabase } from "@/lib/db";
import { loginHandler } from "@/lib/auth/http";

export async function POST(request: Request) {
  return loginHandler(request, await getDatabase());
}
