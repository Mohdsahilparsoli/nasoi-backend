import { z } from "zod";
import { prisma } from "../db.js";

/** Portal settings (one row). Created with defaults if the row is missing. */
export async function getSettings() {
  const s = await prisma().appSetting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return { verifierRate: s.verifierRate, defaultDeoRate: s.defaultDeoRate, payoutWindow: s.payoutWindow, updatedAt: s.updatedAt };
}

export const settingsSchema = z.object({
  verifierRate: z.coerce.number({ error: "Enter the verifier rate" }).int("Enter a whole number").min(0, "Rate cannot be negative").max(1000, "Rate is too high"),
  defaultDeoRate: z.coerce.number({ error: "Enter the DEO rate" }).int("Enter a whole number").min(1, "Rate must be at least ₹1").max(1000, "Rate is too high"),
  payoutWindow: z.string().trim().min(3, "Enter the payout window").max(80, "Too long"),
});

export async function updateSettings(v: z.infer<typeof settingsSchema>) {
  await prisma().appSetting.upsert({ where: { id: 1 }, create: { id: 1, ...v }, update: v });
  return getSettings();
}
