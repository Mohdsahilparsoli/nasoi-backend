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

export async function sendMail(msg: { to: string; subject: string; text: string; html: string }) {
  await mailer().sendMail({ from: config().SMTP_FROM, ...msg });
}

export { assignmentEmail, registrationEmail, resetPasswordEmail } from "./email-templates.js";
