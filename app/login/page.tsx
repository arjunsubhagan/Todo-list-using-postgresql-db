import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { getCurrentUser } from "@/lib/auth/current-user";

export const instant = false;

type LoginPageProps = {
  searchParams: Promise<{ registered?: string; reason?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  return (
    <AuthForm
      mode="login"
      registered={params.registered === "1"}
      sessionExpired={params.reason === "expired"}
    />
  );
}
