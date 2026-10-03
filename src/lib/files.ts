import type { Request } from "express";
import ExcelJS from "exceljs";
import { PassThrough, type Writable } from "node:stream";
import { z } from "zod";
import { audit } from "./audit.js";
import { HttpError } from "./http.js";
import { esc, layoutEmail } from "./email-templates.js";
import { mailEnabled, sendMail } from "./mailer.js";
import { DEFAULT_MAIL_TEMPLATE, getSettings, mailTextSchema } from "./settings.js";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_TYPE = "text/csv; charset=utf-8";

/** Biggest attachment we send by e-mail (most providers accept 20–25 MB). */
const MAX_EMAIL_BYTES = 15 * 1024 * 1024;

const MAX_RECIPIENTS = 10;

/** "a@x.com, b@y.com" or ["a@x.com"] → unique lower-case addresses (each validated). */
const addressList = (field: string, min: number) =>
  z
    .union([z.string().max(1500), z.array(z.string().max(120)).max(MAX_RECIPIENTS * 2)])
    .optional()
    .transform((v, ctx) => {
      const list = (Array.isArray(v) ? v : (v ?? "").split(/[,;\s]+/)).map((x) => x.trim().toLowerCase()).filter(Boolean);
      const unique = [...new Set(list)];
      const bad = unique.find((x) => !z.email().safeParse(x).success || x.length > 120);
      if (bad) ctx.addIssue({ code: "custom", message: `“${bad.slice(0, 60)}” is not a valid e-mail address` });
      else if (unique.length < min) ctx.addIssue({ code: "custom", message: "Enter at least one e-mail address" });
      else if (unique.length > MAX_RECIPIENTS) ctx.addIssue({ code: "custom", message: `At most ${MAX_RECIPIENTS} addresses in ${field}` });
      return unique;
    });

/**
 * Recipients and text of an admin "Send on e-mail": any custom addresses
 * (To + CC, comma separated), optional subject / message (blank = the saved
 * default template).
 */
export const emailToSchema = z
  .object({ to: addressList("To", 1), cc: addressList("CC", 0) })
  .and(mailTextSchema)
  .transform((v) => ({ ...v, cc: v.cc.filter((x) => !v.to.includes(x)) }));
export type EmailRequest = z.infer<typeof emailToSchema>;

/** Runs a writer against an in-memory stream and returns the bytes (for e-mail attachments). */
export async function toBuffer(write: (out: Writable) => Promise<unknown>): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  let size = 0;
  out.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_EMAIL_BYTES) out.destroy(new HttpError(413, "The file is too big to send by e-mail. Please download it instead, or use filters.", "FILE_TOO_LARGE"));
    else chunks.push(c);
  });
  const done = new Promise<void>((resolve, reject) => {
    out.on("end", resolve);
    out.on("close", resolve);
    out.on("error", reject);
  });
  await write(out);
  if (!out.writableEnded) out.end();
  await done;
  return Buffer.concat(chunks);
}

/** A simple sheet description for small reports (payouts, payments). */
export interface SheetSpec {
  name: string;
  columns: { header: string; width?: number }[];
  rows: (string | number | null | undefined)[][];
}

/** Stops spreadsheet apps from treating a cell as a formula (CSV / Excel injection). */
export const safeCell = (v: string | number | null | undefined) =>
  v === null || v === undefined ? "" : typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;

/** Builds an .xlsx file with a styled header row on every sheet. */
export async function buildWorkbook(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NASOI";
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = s.columns.map((c, i) => ({ header: c.header, key: `c${i}`, width: c.width ?? Math.max(10, c.header.length + 2) }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C3F94" } };
    for (const r of s.rows) ws.addRow(r.map(safeCell));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const istDate = () => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(new Date());

/** Fills {report}, {details}, {file}, {date}; unknown braces are left as typed. */
export function fillTemplate(text: string, vars: Record<string, string>) {
  return text.replace(/\{(report|details|file|date)\}/g, (_m, k: string) => vars[k] ?? "");
}

/** Message text → safe HTML paragraphs (everything is escaped; blank lines split paragraphs). */
const toHtml = (message: string) =>
  message
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

/**
 * E-mails a file as an attachment. Needs SMTP to be configured (503 otherwise).
 * The subject / message come from the request, else from the saved default
 * template (Settings), else the built-in one. Every sent file is audited.
 */
export async function emailFile(
  req: Request,
  actorId: string,
  rcpt: { to: string[]; cc?: string[]; subject?: string; message?: string },
  file: { filename: string; content: Buffer; contentType: string },
  ctx: { report: string; details: string },
) {
  if (!mailEnabled()) throw new HttpError(503, "E-mail is not set up on the server yet. Please download the file instead.", "MAIL_DISABLED");
  if (file.content.length > MAX_EMAIL_BYTES) throw new HttpError(413, "The file is too big to send by e-mail. Please download it instead, or use filters.", "FILE_TOO_LARGE");
  const tpl = rcpt.subject && rcpt.message ? null : (await getSettings()).mailTemplate;
  const vars = { report: ctx.report, details: ctx.details, file: file.filename, date: istDate() };
  const subject = fillTemplate(rcpt.subject || tpl?.subject || DEFAULT_MAIL_TEMPLATE.subject, vars).replace(/\s+/g, " ").trim().slice(0, 250);
  const message = fillTemplate(rcpt.message || tpl?.message || DEFAULT_MAIL_TEMPLATE.message, vars).trim();
  const title = ctx.report.charAt(0).toUpperCase() + ctx.report.slice(1);
  const html = layoutEmail({
    preheader: subject,
    title,
    body: `${toHtml(message)}<p style="margin:0;font-size:13px;color:#5b6b8c">📎 ${esc(file.filename)}</p>`,
  });
  const cc = rcpt.cc?.length ? rcpt.cc : undefined;
  try {
    await sendMail({ to: rcpt.to, cc, subject, html, text: message, attachments: [file] });
  } catch (err) {
    console.error("[mail] attachment e-mail failed", (err as Error).message);
    throw new HttpError(502, "The e-mail could not be sent. Please try again or download the file.", "MAIL_FAILED");
  }
  await audit(req, "file.emailed", actorId, { file: file.filename, to: rcpt.to.join(", "), cc: cc?.join(", ") ?? "", bytes: file.content.length });
  return { sent: true, to: rcpt.to, cc: cc ?? [], filename: file.filename, subject };
}
