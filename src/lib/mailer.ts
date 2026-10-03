import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

let transport: Transporter | undefined;

export function mailEnabled() {
  const c = config();
  return Boolean(c.SMTP_HOST && c.SMTP_FROM);
}

/** Nodemailer SMTP transport (port 465 = implicit TLS, otherwise STARTTLS is required). */
function mailer(): Transporter {
  if (transport) return transport;
  const c = config();
  transport = nodemailer.createTransport({
    host: c.SMTP_HOST,
    port: c.SMTP_PORT,
    secure: c.SMTP_PORT === 465,
    requireTLS: c.SMTP_PORT !== 465 && c.isProd,
    auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASS } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transport;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export async function sendMail(msg: { to: string | string[]; cc?: string[]; subject: string; text: string; html: string; attachments?: MailAttachment[] }) {
  await mailer().sendMail({ from: config().SMTP_FROM, ...msg });
}

export { accountStatusEmail, assignmentEmail, meetingEmail, paymentEmail, registrationEmail, requestEmail, resetPasswordEmail, verifierAreaEmail } from "./email-templates.js";
