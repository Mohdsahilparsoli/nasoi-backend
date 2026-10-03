import { prisma } from "../db.js";

/** Basic contact card shown between a DEO and the verifier of the same area. */
export interface PersonCard {
  id: string;
  name: string;
  mobile: string | null;
  hasPhoto: boolean;
}

export async function personCards(ids: (string | null | undefined)[]): Promise<Map<string, PersonCard>> {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  if (!unique.length) return new Map();
  const users = await prisma().user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, mobile: true, documents: { where: { kind: "photo", attachedAt: { not: null } }, select: { id: true }, take: 1 } },
  });
  return new Map(users.map((u) => [u.id, { id: u.id, name: u.name, mobile: u.mobile, hasPhoto: u.documents.length > 0 }]));
}

/**
 * May `viewer` see `target`'s profile photo? Yes for self and admins, and for a
 * DEO and the verifier who share an assignment (either direction).
 */
export async function canSeePhoto(viewer: { sub: string; role: string }, target: string) {
  if (viewer.sub === target || viewer.role === "admin") return true;
  const db = prisma();
  if (viewer.role === "deo") {
    return (await db.assignment.count({ where: { deoId: viewer.sub, verifierId: target } })) > 0 ||
      (await db.entry.count({ where: { deoId: viewer.sub, OR: [{ verifierId: target }, { verifiedById: target }] } })) > 0;
  }
  if (viewer.role === "verifier") {
    return (await db.assignment.count({ where: { verifierId: viewer.sub, deoId: target } })) > 0 ||
      (await db.entry.count({ where: { deoId: target, OR: [{ verifierId: viewer.sub }, { verifiedById: viewer.sub }] } })) > 0;
  }
  return false;
}
