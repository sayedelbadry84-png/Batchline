"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession } from "@/lib/session";
import { redirect } from "next/navigation";

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) redirect("/login?error=1");

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) redirect("/login?error=1");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) redirect("/login?error=1");

  // Logging in again without signing out first shouldn't leave the previous
  // session orphaned in the database.
  await destroySession();
  await createSession(user.id);
  redirect(user.role === "DRIVER" ? "/driver" : "/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
