import { z } from "zod";

/** Shared between the register/login forms (apps/web, 01-02) and better-auth's own validation. */
export const registerSchema = z.object({
  name: z.string().trim().min(1, "Имя обязательно").max(120),
  email: z.string().trim().min(1, "Email обязателен").email("Введите корректный email"),
  password: z.string().min(8, "Пароль должен быть не короче 8 символов").max(128),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().min(1, "Email обязателен").email("Введите корректный email"),
  password: z.string().min(1, "Пароль обязателен"),
});
export type LoginInput = z.infer<typeof loginSchema>;
