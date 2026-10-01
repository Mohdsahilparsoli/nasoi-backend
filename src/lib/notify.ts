import { prisma } from "../db.js";
import { mailEnabled, sendMail } from "./mailer.js";

/**
 * Creates an in-app notification and, when SMTP is configured, also e-mails it.
 * Never throws: a notification problem must not undo the action that caused it.
 */
export async function notify(
  user: { id: string; email: string | null },
  n: { title: string; body: string; link?: string },
  email?: { subject: string; html: string; text: string },
) {
  let emailed = false;
  try {
    await prisma().notification.create({ data: { userId: user.id, title: n.title, body: n.body, link: n.link } });
  } catch (err) {
    console.error("[notify] could not save notification", user.id, (err as Error).message);
  }
  if (email && user.email && mailEnabled()) {
    try {
      await sendMail({ to: user.email, ...email });
      emailed = true;
    } catch (err) {
      console.error("[notify] e-mail failed", user.id, (err as Error).message);
    }
  }
  return { emailed };
}
