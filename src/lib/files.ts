import type { Request } from "express";
import ExcelJS from "exceljs";
import { PassThrough, type Writable } from "node:stream";
import { z } from "zod";
import { audit } from "./audit.js";
import { HttpError } from "./http.js";
import { esc, layoutEmail } from "./email-templates.js";
import { mailEnabled, sendMail } from "./mailer.js";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_TYPE = "text/csv; charset=utf-8";

/** Biggest attachment we send by e-mail (most providers accept 20–25 MB). */
const MAX_EMAIL_BYTES = 15 * 1024 * 1024;

export const emailToSchema = z.object({
  to: z.email("Enter a valid e-mail address").max(120).transform((v) => v.toLowerCase()),
});

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

/**
 * E-mails a file as an attachment. Needs SMTP to be configured (503 otherwise).
 * Every sent file is recorded in the audit log.
 */
export async function emailFile(
  req: Request,
  actorId: string,
  to: string,
  file: { filename: string; content: Buffer; contentType: string },
  text: { subject: string; title: string; intro: string },
) {
  if (!mailEnabled()) throw new HttpError(503, "E-mail is not set up on the server yet. Please download the file instead.", "MAIL_DISABLED");
  if (file.content.length > MAX_EMAIL_BYTES) throw new HttpError(413, "The file is too big to send by e-mail. Please download it instead, or use filters.", "FILE_TOO_LARGE");
  const html = layoutEmail({
    preheader: text.intro,
    title: text.title,
    body: `<p style="margin:0 0 14px">${esc(text.intro)}</p><p style="margin:0 0 14px">The file <b>${esc(file.filename)}</b> is attached to this e-mail.</p>`,
  });
  try {
    await sendMail({ to, subject: text.subject, html, text: `${text.intro}\n\nThe file ${file.filename} is attached to this e-mail.`, attachments: [file] });
  } catch (err) {
    console.error("[mail] attachment e-mail failed", (err as Error).message);
    throw new HttpError(502, "The e-mail could not be sent. Please try again or download the file.", "MAIL_FAILED");
  }
  await audit(req, "file.emailed", actorId, { file: file.filename, to, bytes: file.content.length });
  return { sent: true, to, filename: file.filename };
}
