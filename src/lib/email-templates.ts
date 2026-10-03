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

function button(label: string, href: string, color: string = C.primary) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr><td style="border-radius:8px;background:${color}">
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
export function layoutEmail(opts: { preheader: string; title: string; body: string }) {
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
      ? "Your account is waiting for approval. The NASOI admin will review your details, activate your account and then assign your area work. You can log in any time to see the status."
      : "Your account is waiting for approval. The NASOI admin will review your details, activate your account and then assign areas for verification. You can log in any time to see the status.";
  const subject = `Registration successful – your NASOI ID is ${u.id}`;
  const html = layoutEmail({
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
  const html = layoutEmail({
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
  id: string; deoName: string; taskType: string; target: number; recordType?: string; verifierName?: string; verifierId?: string;
  village: string; block: string; district: string; state: string; pincode: string; deadline: Date; instructions?: string | null;
}) {
  const link = `${appUrl()}/deo/work`;
  const deadline = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(a.deadline);
  const area = `${[a.village, a.block, a.district, a.state].filter((x) => x && x.trim()).join(", ")} – ${a.pincode}`;
  const subject = `New work assigned – ${a.id} (PIN ${a.pincode})`;
  const html = layoutEmail({
    preheader: `${a.taskType} for PIN ${a.pincode}, target ${a.target} entries, deadline ${deadline}.`,
    title: "New work assigned to you",
    body: [
      p(`Dear <b>${esc(a.deoName)}</b>,`),
      p("The NASOI admin has assigned new data-entry work to you. Please review the details and start after logging in."),
      detailsTable([
        ["Assignment ID", a.id],
        ["Service", a.taskType],
        ["Entries of", a.recordType === "college" ? "College" : "School"],
        ["PIN code", a.pincode],
        ["Area", area],
        ["Target", `${a.target} entries`],
        ["Deadline", deadline],
        ...(a.verifierName ? ([["Verifier", `${a.verifierName} (${a.verifierId})`]] as [string, string][]) : []),
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
    `Deadline      : ${deadline}`,
    ...(a.instructions ? ["", "Instructions:", a.instructions] : []),
    "",
    `Open My Work: ${link}`,
    "",
    "This is an automated e-mail – please do not reply.",
  ].join("\n");
  return { subject, html, text };
}

/** Sent to a verifier when an area (work) is assigned to them for verification. */
export function verifierAreaEmail(a: {
  id: string; verifierName: string; deoName: string; deoId: string; taskType: string; recordType: string; target: number;
  village: string; block: string; district: string; state: string; pincode: string; deadline: Date;
}) {
  const link = `${appUrl()}/verifier`;
  const deadline = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(a.deadline);
  const area = `${[a.village, a.block, a.district, a.state].filter((x) => x && x.trim()).join(", ")} – ${a.pincode}`;
  const what = a.recordType === "college" ? "College" : "School";
  const subject = `New area to verify – ${a.id} (PIN ${a.pincode})`;
  const html = layoutEmail({
    preheader: `${what} entries for PIN ${a.pincode} by ${a.deoName} will come to you for verification.`,
    title: "New area assigned for verification",
    body: [
      p(`Dear <b>${esc(a.verifierName)}</b>,`),
      p("The NASOI admin has assigned a work area to you. Entries made by the Data Entry Operator of this area will come to you for verification."),
      detailsTable([
        ["Assignment ID", a.id],
        ["Service", a.taskType],
        ["Entries of", what],
        ["PIN code", a.pincode],
        ["Area", area],
        ["Data Entry Operator", `${a.deoName} (${a.deoId})`],
        ["Target", `${a.target} entries`],
        ["Deadline", deadline],
      ]),
      button("Open Verifier Panel", link),
    ].join("\n"),
  });
  const text = [
    `Dear ${a.verifierName},`,
    "",
    "The NASOI admin has assigned a work area to you for verification.",
    "",
    `Assignment ID : ${a.id}`,
    `Service       : ${a.taskType}`,
    `Entries of    : ${what}`,
    `PIN code      : ${a.pincode}`,
    `Area          : ${area}`,
    `DEO           : ${a.deoName} (${a.deoId})`,
    `Target        : ${a.target} entries`,
    `Deadline      : ${deadline}`,
    "",
    `Open Verifier Panel: ${link}`,
    "",
    "This is an automated e-mail – please do not reply.",
  ].join("\n");
  return { subject, html, text };
}

/** Account activated or registration rejected by the admin. */
export function accountStatusEmail(u: { name: string; id: string; role: "deo" | "verifier"; status: "active" | "rejected"; reason?: string }) {
  const active = u.status === "active";
  const login = `${appUrl()}/login?id=${encodeURIComponent(u.id)}`;
  const subject = active ? `Your NASOI account ${u.id} is active` : `NASOI registration ${u.id} – not approved`;
  const html = layoutEmail({
    preheader: active ? "Your account has been activated. You can now be assigned work." : "Your registration was not approved.",
    title: active ? "Your account is active" : "Registration not approved",
    body: [
      p(`Dear <b>${esc(u.name)}</b>,`),
      active
        ? p(`Your account as a <b>${esc(ROLE_LABEL[u.role])}</b> (ID <b>${esc(u.id)}</b>) has been activated by the NASOI admin. You will be notified when work is assigned to you.`)
        : p(`We are sorry – your registration (ID <b>${esc(u.id)}</b>) was not approved by the NASOI admin.`),
      !active && u.reason ? detailsTable([["Reason", u.reason]]) : "",
      active ? button("Login to your account", login) : small("If you think this is a mistake, please contact the NASOI office."),
    ].join("\n"),
  });
  const text = [
    `Dear ${u.name},`,
    "",
    active
      ? `Your account as a ${ROLE_LABEL[u.role]} (ID ${u.id}) has been activated by the NASOI admin. You will be notified when work is assigned to you.`
      : `Your registration (ID ${u.id}) was not approved by the NASOI admin.${u.reason ? ` Reason: ${u.reason}` : ""}`,
    "",
    active ? `Login: ${login}` : "If you think this is a mistake, please contact the NASOI office.",
    "",
    "This is an automated e-mail – please do not reply.",
  ].join("\n");
  return { subject, html, text };
}

/** Payment receipt sent to a DEO / verifier when the admin records a payout. */
export function paymentEmail(pay: {
  name: string; id: string; amount: number; paidOn: string; mode: string; transactionId: string; payeeName: string;
  entriesCount: number | null; periodFrom: string | null; periodTo: string | null; notes: string | null; role: "deo" | "verifier";
}) {
  const amount = `₹${pay.amount.toLocaleString("en-IN")}`;
  const link = `${appUrl()}/${pay.role === "verifier" ? "verifier" : "deo"}/payments`;
  const rows: [string, string][] = [
    ["Payment ID", pay.id],
    ["Amount", amount],
    ["Paid on", pay.paidOn],
    ["Mode", pay.mode],
    ["Transaction ID", pay.transactionId],
    ["Paid to", pay.payeeName],
  ];
  if (pay.entriesCount !== null) rows.push(["Entries covered", String(pay.entriesCount)]);
  if (pay.periodFrom || pay.periodTo) rows.push(["Period", `${pay.periodFrom ?? "…"} to ${pay.periodTo ?? "…"}`]);
  if (pay.notes) rows.push(["Notes", pay.notes]);
  const subject = `Payment received – ${amount} (${pay.id})`;
  const html = layoutEmail({
    preheader: `${amount} paid on ${pay.paidOn}, transaction ${pay.transactionId}.`,
    title: "Payment received",
    body: [p(`Dear <b>${esc(pay.name)}</b>,`), p("NASOI has made the following payment to you."), detailsTable(rows), button("View my payments", link)].join("\n"),
  });
  const text = [`Dear ${pay.name},`, "", "NASOI has made the following payment to you.", "", ...rows.map(([k, v]) => `${k.padEnd(16)}: ${v}`), "", `View my payments: ${link}`].join("\n");
  return { subject, html, text };
}

/* ---------- Meetings and requests ---------- */

export const PLATFORM_LABEL: Record<string, string> = { zoom: "Zoom", google_meet: "Google Meet", teams: "Microsoft Teams", other: "Online meeting" };
const PLATFORM_COLOR: Record<string, string> = { zoom: "#0b5cff", google_meet: "#00897b", teams: "#5b5fc7", other: C.primary };

/** "Sat, 04 Oct 2026, 11:30 am IST" */
export function istDateTime(d: Date) {
  return `${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(d)} IST`;
}

/** Meeting invitation (or cancellation) for one participant. */
export function meetingEmail(m: {
  name: string; id: string; title: string; platform: string; link: string; startsAt: Date; durationMin: number;
  organizer: string; notes: string | null; entryId: string | null; cancelled?: boolean; role: string;
}) {
  const label = PLATFORM_LABEL[m.platform] ?? PLATFORM_LABEL.other!;
  const when = istDateTime(m.startsAt);
  const rows: [string, string][] = [
    ["Meeting", m.title],
    ["Date & time", when],
    ["Duration", `${m.durationMin} minutes`],
    ["Platform", label],
    ["Organised by", m.organizer],
  ];
  if (m.entryId) rows.push(["About entry", m.entryId]);
  if (m.notes) rows.push(["Notes", m.notes]);
  rows.push(["Meeting ID", m.id]);
  const page = `${appUrl()}/${m.role === "admin" ? "admin" : m.role === "verifier" ? "verifier" : "deo"}/connect`;
  const subject = m.cancelled ? `Cancelled: ${m.title} – ${when}` : `${label} meeting: ${m.title} – ${when}`;
  const intro = m.cancelled ? "The following meeting has been cancelled." : `You are invited to a <b>${esc(label)}</b> meeting.`;
  const html = layoutEmail({
    preheader: `${m.cancelled ? "Cancelled" : label} · ${when}`,
    title: m.cancelled ? "Meeting cancelled" : "Meeting invitation",
    body: [
      p(`Dear <b>${esc(m.name)}</b>,`),
      p(intro),
      detailsTable(rows),
      m.cancelled ? "" : button(`Join ${label}`, m.link, PLATFORM_COLOR[m.platform] ?? C.primary),
      m.cancelled ? "" : p(`<span style="font-size:13px;color:${C.muted}">Link: <a href="${esc(m.link)}">${esc(m.link)}</a></span>`),
      p(`<a href="${esc(page)}">See all my meetings</a>`),
    ].join("\n"),
  });
  const text = [
    `Dear ${m.name},`,
    "",
    m.cancelled ? "The following meeting has been cancelled." : `You are invited to a ${label} meeting.`,
    "",
    ...rows.map(([k, v]) => `${k.padEnd(14)}: ${v}`),
    ...(m.cancelled ? [] : ["", `Join ${label}: ${m.link}`]),
    "",
    `My meetings: ${page}`,
  ].join("\n");
  return { subject, html, text };
}

const KIND_LABEL: Record<string, string> = { meeting: "Meeting request", entry: "Entry request", general: "Request" };

/** A new request, or the answer to one. */
export function requestEmail(r: {
  name: string; id: string; kind: string; from: string; subject: string; message: string; entryId: string | null;
  preferredAt: Date | null; role: string; reply?: { status: string; text: string | null };
}) {
  const page = `${appUrl()}/${r.role === "admin" ? "admin" : r.role === "verifier" ? "verifier" : "deo"}/connect?tab=requests`;
  const kind = KIND_LABEL[r.kind] ?? "Request";
  const rows: [string, string][] = [["Request", `${kind} (${r.id})`], [r.reply ? "Answered by" : "From", r.from], ["Subject", r.subject]];
  if (r.entryId) rows.push(["Entry", r.entryId]);
  if (r.preferredAt) rows.push(["Preferred time", istDateTime(r.preferredAt)]);
  if (r.reply) rows.push(["Status", r.reply.status.charAt(0).toUpperCase() + r.reply.status.slice(1)]);
  const subject = r.reply ? `Your request ${r.id} was ${r.reply.status} – ${r.subject}` : `${kind} from ${r.from}: ${r.subject}`;
  const quote = (t: string) => `<div style="border-left:3px solid ${C.saffron};background:${C.soft};padding:10px 14px;margin:0 0 16px;white-space:pre-wrap">${esc(t)}</div>`;
  const html = layoutEmail({
    preheader: r.reply ? `${r.from} ${r.reply.status} your request.` : `${r.from}: ${r.subject}`,
    title: r.reply ? "Request answered" : kind,
    body: [
      p(`Dear <b>${esc(r.name)}</b>,`),
      p(r.reply ? `${esc(r.from)} has <b>${esc(r.reply.status)}</b> your request.` : `${esc(r.from)} has sent you a request on the NASOI portal.`),
      detailsTable(rows),
      r.reply ? (r.reply.text ? quote(r.reply.text) : "") : quote(r.message),
      button(r.reply ? "Open my requests" : "Reply on the portal", page),
    ].join("\n"),
  });
  const text = [
    `Dear ${r.name},`,
    "",
    r.reply ? `${r.from} has ${r.reply.status} your request.` : `${r.from} has sent you a request on the NASOI portal.`,
    "",
    ...rows.map(([k, v]) => `${k.padEnd(14)}: ${v}`),
    "",
    r.reply ? (r.reply.text ?? "") : r.message,
    "",
    `Open: ${page}`,
  ].join("\n");
  return { subject, html, text };
}
