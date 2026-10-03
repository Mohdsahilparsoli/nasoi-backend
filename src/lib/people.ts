import { prisma } from "../db.js";
import { contactIds, meetingPlatform } from "../modules/connect/service.js";

/** Basic contact card shown between a DEO and the verifier of the same area. */
export interface PersonCard {
  id: string;
  name: string;
  mobile: string | null;
  hasPhoto: boolean;
  /** Personal Zoom / Google Meet room, if they saved one in their profile. */
  meetingLink: string | null;
  platform: string | null;
}

export async function personCards(ids: (string | null | undefined)[]): Promise<Map<string, PersonCard>> {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  if (!unique.length) return new Map();
  const users = await prisma().user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, mobile: true, meetingLink: true, documents: { where: { kind: "photo", attachedAt: { not: null } }, select: { id: true }, take: 1 } },
  });
  return new Map(
    users.map((u) => [
      u.id,
      { id: u.id, name: u.name, mobile: u.mobile, hasPhoto: u.documents.length > 0, meetingLink: u.meetingLink, platform: u.meetingLink ? meetingPlatform(u.meetingLink) : null },
    ]),
  );
}

/**
 * May `viewer` see `target`'s profile photo? Yes for self and admins, and for
 * the people they work with (a DEO and the verifiers of their work / entries,
 * either direction, and the admin).
 */
export async function canSeePhoto(viewer: { sub: string; role: string }, target: string) {
  if (viewer.sub === target || viewer.role === "admin") return true;
  return (await contactIds(viewer)).has(target);
}
