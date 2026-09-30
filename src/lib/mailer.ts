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

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Branded, plain e-mail for the reset link (works in every mail app). */
export function resetPasswordEmail(name: string, link: string, minutes: number) {
  const subject = "Reset your NASOI password";
  const text = [
    `Hello ${name},`,
    "",
    "We received a request to reset the password of your NASOI account.",
    `Open this link to set a new password (valid for ${minutes} minutes, can be used once):`,
    link,
    "",
    "If you did not request this, you can ignore this e-mail – your password will not change.",
    "",
    "National Academic Services of India",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#10265e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td style="height:4px;background:linear-gradient(90deg,#f28a1e 33%,#ffffff 33% 66%,#138a3d 66%)"></td></tr>
<tr><td style="padding:24px 28px">
<p style="margin:0 0 4px;font-size:12px;font-weight:bold;letter-spacing:1px;color:#f28a1e;text-transform:uppercase">National Academic Services of India</p>
<h1 style="margin:0 0 16px;font-size:22px;color:#10265e">Reset your password</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5">Hello ${esc(name)},</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">We received a request to reset the password of your NASOI account. Click the button below to set a new password.</p>
<p style="margin:0 0 20px"><a href="${esc(link)}" style="display:inline-block;background:#1c3f94;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;font-size:15px">Set new password</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#5d6b7a">This link is valid for ${minutes} minutes and can be used only once.</p>
<p style="margin:0 0 20px;font-size:13px;color:#5d6b7a;word-break:break-all">If the button does not work, copy this link into your browser:<br>${esc(link)}</p>
<p style="margin:0;font-size:13px;color:#5d6b7a">If you did not request this, you can ignore this e-mail – your password will not change.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}
