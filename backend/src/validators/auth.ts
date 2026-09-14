import { z } from "zod";

export const passwordPolicy = z
  .string({ error: "Password is required." })
  .min(10, "Password must be at least 10 characters.")
  .max(128, "Password must be at most 128 characters.")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Password must contain both letters and numbers.");

export const loginSchema = z.object({
  username: z.string({ error: "Username is required." }).trim().toLowerCase().min(1, "Username is required.").max(60),
  password: z.string({ error: "Password is required." }).min(1, "Password is required.").max(128),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string({ error: "Current password is required." }).min(1, "Current password is required.").max(128),
    newPassword: passwordPolicy,
  })
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: "New password must be different from the current password.",
    path: ["newPassword"],
  });

export const resetTokenSchema = z.object({ token: z.string().min(20).max(100) });

export const resetConfirmSchema = z.object({
  token: z.string().min(20, "The reset link is invalid.").max(100, "The reset link is invalid."),
  newPassword: passwordPolicy,
});
