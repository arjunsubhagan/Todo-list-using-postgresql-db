import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getDatabase } from "@/lib/db";
import { getValidSession, type PublicUser } from "@/lib/auth/service";
import { SESSION_COOKIE } from "@/lib/auth/http";

export async function getCurrentUser(): Promise<PublicUser | null> {
  await connection();
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) {
    return null;
  }

  const session = await getValidSession(await getDatabase(), token);
  return session?.user ?? null;
}

export async function requireCurrentUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    redirect(token ? "/login?reason=expired" : "/login");
  }
  return user;
}
