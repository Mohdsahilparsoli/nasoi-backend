import { prisma } from "../../db.js";

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

type Count = { status: string; n: bigint };
const byStatus = (rows: Count[]) => Object.fromEntries(rows.map((r) => [r.status, n(r.n)])) as Record<string, number>;

/**
 * GET /admin/overview – everything on the Super Admin dashboard, straight from
 * the database: employees, entries, work, money (earned only on final
 * approval), month-wise trend, top performers, verification queue, latest
 * registrations / payments, meetings and requests.
 */
export async function adminOverview(adminId: string) {
  const db = prisma();
  const today = todayIST();

  const [
    users,
    eligibleDeos,
    entries,
    entryToday,
    verifiedToday,
    entryTypes,
    work,
    overdue,
    deoEarned,
    vrEarned,
    paid,
    monthly,
    topDeos,
    topVrs,
    queue,
    recentUsers,
    recentPayments,
    upcomingMeetings,
    openRequests,
    topDistricts,
  ] = await Promise.all([
    db.$queryRaw<{ role: string; status: string; n: bigint }[]>`select role::text, status::text, count(*) as n from users where role <> 'admin' group by 1, 2`,
    db.user.count({ where: { role: "deo", status: "active", assignments: { none: { status: "active" } } } }),
    db.$queryRaw<Count[]>`select status::text, count(*) as n from entries group by 1`,
    db.$queryRaw<{ n: bigint }[]>`select count(*) as n from entries where (submitted_at at time zone 'Asia/Kolkata')::date = ${today}::date`,
    db.$queryRaw<{ approved: bigint; rejected: bigint }[]>`
      select count(*) filter (where decision = 'approved') as approved, count(*) filter (where decision = 'rejected') as rejected
      from verifications where (created_at at time zone 'Asia/Kolkata')::date = ${today}::date`,
    db.$queryRaw<{ type: string; n: bigint }[]>`select record_type as type, count(*) as n from entries group by 1`,
    db.$queryRaw<Count[]>`select status::text, count(*) as n from assignments group by 1`,
    db.$queryRaw<{ n: bigint }[]>`select count(*) as n from assignments where status = 'active' and deadline < ${today}::date`,
    db.entry.aggregate({ where: { status: "approved" }, _sum: { ratePerEntry: true } }),
    db.verification.aggregate({ where: { decision: "approved" }, _sum: { rate: true } }),
    db.$queryRaw<{ role: string; amount: bigint; n: bigint }[]>`select role::text, coalesce(sum(amount), 0) as amount, count(*) as n from payments group by 1`,
    db.$queryRaw<{ month: string; submitted: bigint; approved: bigint; rejected: bigint; pending: bigint; earned: bigint }[]>`
      select to_char(submitted_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month,
             count(*) as submitted,
             count(*) filter (where status = 'approved') as approved,
             count(*) filter (where status = 'rejected') as rejected,
             count(*) filter (where status = 'pending') as pending,
             coalesce(sum(rate_per_entry) filter (where status = 'approved'), 0) as earned
      from entries
      where submitted_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '11 months') at time zone 'Asia/Kolkata'
      group by 1 order by 1`,
    db.$queryRaw<{ id: string; name: string; approved: bigint; pending: bigint; rejected: bigint; earned: bigint }[]>`
      select u.id, u.name,
             count(*) filter (where e.status = 'approved') as approved,
             count(*) filter (where e.status = 'pending') as pending,
             count(*) filter (where e.status = 'rejected') as rejected,
             coalesce(sum(e.rate_per_entry) filter (where e.status = 'approved'), 0) as earned
      from entries e join users u on u.id = e.deo_id
      group by u.id, u.name order by approved desc, earned desc limit 5`,
    db.$queryRaw<{ id: string; name: string; approved: bigint; rejected: bigint; earned: bigint }[]>`
      select u.id, u.name,
             count(*) filter (where v.decision = 'approved') as approved,
             count(*) filter (where v.decision = 'rejected') as rejected,
             coalesce(sum(v.rate) filter (where v.decision = 'approved'), 0) as earned
      from verifications v join users u on u.id = v.verifier_id
      group by u.id, u.name order by approved desc limit 5`,
    db.$queryRaw<{ id: string | null; name: string | null; pending: bigint; oldest: Date }[]>`
      select e.verifier_id as id, u.name, count(*) as pending, min(e.submitted_at) as oldest
      from entries e left join users u on u.id = e.verifier_id
      where e.status = 'pending' group by 1, 2 order by pending desc limit 8`,
    db.user.findMany({
      where: { role: { in: ["deo", "verifier"] } },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, name: true, role: true, status: true, createdAt: true, profile: { select: { district: true, state: true } } },
    }),
    db.payment.findMany({ orderBy: { createdAt: "desc" }, take: 5, include: { user: { select: { name: true } } } }),
    db.meeting.findMany({
      where: { status: "scheduled", startsAt: { gte: new Date(Date.now() - 60 * 60_000) } },
      orderBy: { startsAt: "asc" },
      take: 5,
      select: { id: true, title: true, platform: true, link: true, startsAt: true, durationMin: true, _count: { select: { participants: true } } },
    }),
    db.connectRequest.count({ where: { toId: adminId, status: "open" } }),
    db.$queryRaw<{ state: string; district: string; n: bigint; approved: bigint }[]>`
      select state, district, count(*) as n, count(*) filter (where status = 'approved') as approved
      from entries group by 1, 2 order by n desc limit 5`,
  ]);

  const emp = (role: "deo" | "verifier") => {
    const rows = users.filter((u) => u.role === role);
    const s = Object.fromEntries(rows.map((r) => [r.status, n(r.n)])) as Record<string, number>;
    return {
      total: rows.reduce((t, r) => t + n(r.n), 0),
      active: s.active ?? 0,
      pending: s.pending ?? 0,
      inactive: s.inactive ?? 0,
      rejected: (s.rejected ?? 0) + (s.blocked ?? 0),
    };
  };
  const e = byStatus(entries);
  const w = byStatus(work);
  const deoE = deoEarned._sum.ratePerEntry ?? 0;
  const vrE = vrEarned._sum.rate ?? 0;
  const paidBy = (r: string) => n(paid.find((p) => p.role === r)?.amount);
  const totalPaid = paidBy("deo") + paidBy("verifier");

  return {
    employees: { deo: { ...emp("deo"), eligible: eligibleDeos }, verifier: emp("verifier") },
    entries: {
      total: (e.pending ?? 0) + (e.approved ?? 0) + (e.rejected ?? 0),
      pending: e.pending ?? 0,
      approved: e.approved ?? 0,
      rejected: e.rejected ?? 0,
      submittedToday: n(entryToday[0]?.n),
      approvedToday: n(verifiedToday[0]?.approved),
      rejectedToday: n(verifiedToday[0]?.rejected),
      schools: n(entryTypes.find((t) => t.type === "school")?.n),
      colleges: n(entryTypes.find((t) => t.type === "college")?.n),
    },
    work: { active: w.active ?? 0, completed: w.completed ?? 0, cancelled: w.cancelled ?? 0, overdue: n(overdue[0]?.n) },
    money: {
      deoEarned: deoE,
      verifierEarned: vrE,
      earned: deoE + vrE,
      deoPaid: paidBy("deo"),
      verifierPaid: paidBy("verifier"),
      paid: totalPaid,
      balance: deoE + vrE - totalPaid,
      payments: paid.reduce((t, p) => t + n(p.n), 0),
    },
    monthly: monthly.map((m) => ({
      month: m.month,
      submitted: n(m.submitted),
      approved: n(m.approved),
      rejected: n(m.rejected),
      pending: n(m.pending),
      earned: n(m.earned),
    })),
    topDeos: topDeos.map((r) => ({ id: r.id, name: r.name, approved: n(r.approved), pending: n(r.pending), rejected: n(r.rejected), earned: n(r.earned) })),
    topVerifiers: topVrs.map((r) => ({ id: r.id, name: r.name, approved: n(r.approved), rejected: n(r.rejected), earned: n(r.earned) })),
    queue: queue.map((q) => ({ id: q.id, name: q.name, pending: n(q.pending), oldest: q.oldest })),
    topDistricts: topDistricts.map((d) => ({ state: d.state, district: d.district, entries: n(d.n), approved: n(d.approved) })),
    recentEmployees: recentUsers.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      status: u.status,
      joinedAt: u.createdAt,
      district: u.profile ? `${u.profile.district}, ${u.profile.state}` : null,
    })),
    recentPayments: recentPayments.map((p) => ({ id: p.id, userId: p.userId, name: p.user.name, role: p.role, amount: p.amount, paidOn: p.paidOn, mode: p.mode })),
    upcomingMeetings: upcomingMeetings.map((m) => ({ id: m.id, title: m.title, platform: m.platform, link: m.link, startsAt: m.startsAt, durationMin: m.durationMin, people: m._count.participants })),
    openRequests,
    generatedAt: new Date(),
  };
}
