import { config } from "../config.js";

/**
 * Transactional e-mail templates (table layout + inline styles, so they look
 * right in Gmail, Outlook and phone mail apps). Every e-mail has a plain-text
 * version too.
 */

const C = {
  navy: "#10265e",
  primary: "#1c3f94",
  saffron: "#f28a1e",
  green: "#138a3d",
  muted: "#5d6b7a",
  line: "#e2e8f0",
  canvas: "#f4f6fb",
  soft: "#eef3fc",
};

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const appUrl = () => config().APP_URL.replace(/\/$/, "");

function button(label: string, href: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr><td style="border-radius:8px;background:${C.primary}">
<a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">${esc(label)}</a>
</td></tr></table>`;
}

function detailsTable(rows: [string, string][]) {
  const tr = rows
    .map(
      ([k, v], i) => `<tr>
<td style="padding:10px 14px;font-size:13px;color:${C.muted};width:42%;${i ? `border-top:1px solid ${C.line};` : ""}">${esc(k)}</td>
<td style="padding:10px 14px;font-size:14px;color:${C.navy};font-weight:bold;${i ? `border-top:1px solid ${C.line};` : ""}">${esc(v)}</td>
</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:10px;background:${C.soft};margin:6px 0 18px">${tr}</table>`;
}

/** Shared frame: tricolour bar, logo + name, content, footer. */
function layout(opts: { preheader: string; title: string; body: string }) {
  const logo = `${appUrl()}/brand/logo.png`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background:${C.canvas};font-family:Arial,Helvetica,sans-serif;color:${C.navy}">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas};padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${C.line}">
<tr><td>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="height:5px;background:${C.saffron};width:33%"></td><td style="height:5px;background:#ffffff;width:34%"></td><td style="height:5px;background:${C.green};width:33%"></td>
</tr></table>
</td></tr>
<tr><td style="padding:22px 28px 6px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px"><img src="${esc(logo)}" width="52" height="52" alt="NASOI" style="display:block;border-radius:50%"></td>
<td><div style="font-size:16px;font-weight:bold;color:${C.primary}">National Academic Services of India</div>
<div style="font-size:12px;color:${C.muted}">School Data Entry Portal</div></td>
</tr></table>
</td></tr>
<tr><td style="padding:14px 28px 26px;font-size:15px;line-height:1.55">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${C.navy}">${esc(opts.title)}</h1>
${opts.body}
</td></tr>
<tr><td style="padding:16px 28px;background:${C.canvas};border-top:1px solid ${C.line};font-size:12px;line-height:1.5;color:${C.muted}">
This is an automated e-mail from NASOI – please do not reply to it.<br>
NASOI will never ask for your password, OTP or bank PIN by phone, e-mail or message. No fee is charged for registration.<br>
<a href="${esc(appUrl())}" style="color:${C.primary}">${esc(appUrl().replace(/^https?:\/\//, ""))}</a>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const p = (html: string) => `<p style="margin:0 0 14px">${html}</p>`;
const small = (html: string) => `<p style="margin:0 0 10px;font-size:13px;color:${C.muted}">${html}</p>`;

/* ------------------------------------------------------------------ */

export const ROLE_LABEL = { deo: "Data Entry Operator (DEO)", verifier: "Verifier (VR)", admin: "Super Admin" } as const;

export function maskMobile(m?: string | null) {
  return m && m.length >= 4 ? `XXXXXX${m.slice(-4)}` : "—";
}

function istDate(d: Date) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(d) + " IST";
}

/** Sent after a successful registration. Never contains the password or Aadhaar number. */
export function registrationEmail(u: { id: string; name: string; role: "deo" | "verifier"; email: string; mobile: string; createdAt: Date }) {
  const login = `${appUrl()}/login?id=${encodeURIComponent(u.id)}`;
  const role = ROLE_LABEL[u.role];
  const next =
    u.role === "deo"
      ? "The NASOI admin will review your details and assign your school / area work. You will see it on your dashboard under “My Work”."
      : "The NASOI admin will review your details and assign records for verification. You will see them on your dashboard.";
  const subject = `Registration successful – your NASOI ID is ${u.id}`;
  const html = layout({
    preheader: `Welcome to NASOI. Your Registration ID is ${u.id}.`,
    title: "Registration successful",
    body: [
      p(`Dear <b>${esc(u.name)}</b>,`),
      p(`Thank you for registering with National Academic Services of India. Your account as a <b>${esc(role)}</b> has been created.`),
      detailsTable([
        ["Registration ID", u.id],
        ["Name", u.name],
        ["Registered as", role],
        ["Email ID", u.email],
        ["Mobile Number", maskMobile(u.mobile)],
        ["Registered on", istDate(u.createdAt)],
      ]),
      p(`<b>How to log in:</b> use your Registration ID, registered mobile number or email ID with the password you created during registration.`),
      button("Login to your account", login),
      `<p style="margin:18px 0 6px;font-weight:bold">What happens next</p>`,
      p(next),
      small(`Forgot your password? Use “Forgot password?” on the login page to get a reset link on this e-mail.`),
      small(`If you did not register on NASOI, please ignore this e-mail.`),
    ].join("\n"),
  });
  const text = [
    `Dear ${u.name},`,
    "",
    "Thank you for registering with National Academic Services of India (NASOI).",
    `Your account as a ${role} has been created.`,
    "",
    `Registration ID : ${u.id}`,
    `Name            : ${u.name}`,
    `Registered as   : ${role}`,
    `Email ID        : ${u.email}`,
    `Mobile Number   : ${maskMobile(u.mobile)}`,
    `Registered on   : ${istDate(u.createdAt)}`,
    "",
    "How to log in: use your Registration ID, registered mobile number or email ID with the password you created during registration.",
    `Login: ${login}`,
    "",
    `What happens next: ${next}`,
    "",
    "NASOI will never ask for your password, OTP or bank PIN. No fee is charged for registration.",
    "This is an automated e-mail – please do not reply.",
  ].join("\n");
  return { subject, html, text };
}

/** Password reset link. */
export function resetPasswordEmail(name: string, link: string, minutes: number) {
  const subject = "Reset your NASOI password";
  const html = layout({
    preheader: `Use this link within ${minutes} minutes to set a new password.`,
    title: "Reset your password",
    body: [
      p(`Dear <b>${esc(name)}</b>,`),
      p("We received a request to reset the password of your NASOI account. Click the button below to set a new password."),
      button("Set new password", link),
      small(`This link is valid for <b>${minutes} minutes</b> and can be used only once.`),
      small(`If the button does not work, copy this link into your browser:<br><span style="word-break:break-all">${esc(link)}</span>`),
      small("If you did not request this, you can ignore this e-mail – your password will not change."),
    ].join("\n"),
  });
  const text = [
    `Dear ${name},`,
    "",
    "We received a request to reset the password of your NASOI account.",
    `Open this link to set a new password (valid for ${minutes} minutes, can be used once):`,
    link,
    "",
    "If you did not request this, you can ignore this e-mail – your password will not change.",
    "",
    "National Academic Services of India",
  ].join("\n");
  return { subject, html, text };
}

/** Sent to a DEO when work is assigned. */
export function assignmentEmail(a: {
  id: string; deoName: string; taskType: string; target: number; ratePerEntry: number;
  village: string; block: string; district: string; state: string; pincode: string; deadline: Date; instructions?: string | null;
}) {
  const link = `${appUrl()}/deo/work`;
  const deadline = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(a.deadline);
  const area = `${a.village}, ${a.block}, ${a.district}, ${a.state} – ${a.pincode}`;
  const subject = `New work assigned – ${a.id} (PIN ${a.pincode})`;
  const html = layout({
    preheader: `${a.taskType} for PIN ${a.pincode}, target ${a.target} entries, deadline ${deadline}.`,
    title: "New work assigned to you",
    body: [
      p(`Dear <b>${esc(a.deoName)}</b>,`),
      p("The NASOI admin has assigned new data-entry work to you. Please review the details and start after logging in."),
      detailsTable([
        ["Assignment ID", a.id],
        ["Service", a.taskType],
        ["PIN code", a.pincode],
        ["Area", area],
        ["Target", `${a.target} entries`],
        ["Rate", `₹${a.ratePerEntry} per approved entry`],
        ["Deadline", deadline],
      ]),
      a.instructions ? `<p style="margin:0 0 6px;font-weight:bold">Instructions</p>${p(esc(a.instructions).replace(/\n/g, "<br>"))}` : "",
      button("Open My Work", link),
      small("You will be eligible for your next assignment after this one is completed."),
    ].join("\n"),
  });
  const text = [
    `Dear ${a.deoName},`,
    "",
    "The NASOI admin has assigned new data-entry work to you.",
    "",
    `Assignment ID : ${a.id}`,
    `Service       : ${a.taskType}`,
    `PIN code      : ${a.pincode}`,
    `Area          : ${area}`,
    `Target        : ${a.target} entries`,
    `Rate          : Rs ${a.ratePerEntry} per approved entry`,
    `Deadline      : ${deadline}`,
    ...(a.instructions ? ["", "Instructions:", a.instructions] : []),
    "",
    `Open My Work: ${link}`,
    "",
    "This is an automated e-mail – please do not reply.",
  ].join("\n");
  return { subject, html, text };
}
