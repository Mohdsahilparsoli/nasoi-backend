import { z } from "zod";
import { prisma } from "../db.js";

/**
 * Built-in e-mail template for files sent from the admin panel. Placeholders
 * are filled in when the e-mail is sent.
 */
export const DEFAULT_MAIL_TEMPLATE = {
  subject: "NASOI – {report} ({date})",
  message: [
    "Dear Sir / Madam,",
    "",
    "Please find attached the {report} from the National Academic Services of India (NASOI) portal.",
    "",
    "{details}",
    "",
    "Attached file: {file}",
    "",
    "Regards,",
    "NASOI Admin",
    "National Academic Services of India",
  ].join("\n"),
};
export const MAIL_PLACEHOLDERS = ["{report}", "{details}", "{file}", "{date}"] as const;

/** Portal settings (one row). Created with defaults if the row is missing. */
export async function getSettings() {
  const s = await prisma().appSetting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return {
    verifierRate: s.verifierRate,
    defaultDeoRate: s.defaultDeoRate,
    payoutWindow: s.payoutWindow,
    mailTemplate: {
      subject: s.mailSubject ?? DEFAULT_MAIL_TEMPLATE.subject,
      message: s.mailMessage ?? DEFAULT_MAIL_TEMPLATE.message,
      isDefault: s.mailSubject === null && s.mailMessage === null,
    },
    updatedAt: s.updatedAt,
  };
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

const subjectField = z.string().trim().min(3, "Enter the subject").max(200, "Subject is too long (max 200)").refine((v) => !/[\r\n]/.test(v), "Subject must be one line");
const messageField = z.string().trim().min(10, "Enter the message").max(3000, "Message is too long (max 3000)");

/** PATCH /admin/settings/mail-template: `{ subject, message }` or `{ reset: true }`. */
export const mailTemplateSchema = z.union([
  z.object({ reset: z.literal(true) }),
  z.object({ subject: subjectField, message: messageField }),
]);

export async function updateMailTemplate(v: z.infer<typeof mailTemplateSchema>) {
  const data = "reset" in v ? { mailSubject: null, mailMessage: null } : { mailSubject: v.subject, mailMessage: v.message };
  await prisma().appSetting.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  return getSettings();
}

/** Optional per-send subject / message (blank = use the saved template). */
export const mailTextSchema = z.object({
  subject: z.union([subjectField, z.literal("")]).optional(),
  message: z.union([messageField, z.literal("")]).optional(),
});
