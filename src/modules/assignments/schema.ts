import { z } from "zod";
import { STATE_DISTRICTS } from "../../lib/india-locations.js";

/** NASOI services – the type of work in an assignment. */
export const TASK_TYPES = [
  "Student UHID Card Service",
  "National Scholarship Eligibility Examination Test (NSEET)",
  "Data Entry Services",
  "Students Education Support Services",
  "Academic Management Services",
] as const;

/** Services that can be assigned now – the others are "Coming Soon". */
export const ACTIVE_TASK_TYPES = ["Data Entry Services"] as const;

/** Today's date in India (YYYY-MM-DD). */
export function todayIST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

const text = (label: string, min: number, max: number) =>
  z.string().trim().min(min, `${label} is required`).max(max, `${label} is too long`);

export const createAssignmentSchema = z
  .object({
    deoId: z.string().trim().min(1, "Select a Data Entry Operator").max(20).transform((v) => v.toUpperCase()),
    taskType: z.enum(TASK_TYPES, { error: "Select the service" }).refine((t) => (ACTIVE_TASK_TYPES as readonly string[]).includes(t), "This service is coming soon"),
    recordType: z.enum(["school", "college"], { error: "Choose School or College" }),
    verifierId: z.string().trim().min(1, "Select a Verifier for this area").max(20).transform((v) => v.toUpperCase()),
    verifierRate: z.coerce.number({ error: "Enter the verifier amount" }).int("Enter a whole number").min(0, "Amount cannot be negative").max(1000, "Amount is too high"),
    target: z.coerce.number({ error: "Enter the number of entries" }).int("Enter a whole number").min(1, "Target must be at least 1").max(100000, "Target is too large"),
    ratePerEntry: z.coerce.number({ error: "Enter the DEO amount" }).int("Enter a whole number").min(1, "Amount must be at least ₹1").max(1000, "Amount is too high"),
    state: z.string().refine((s) => s in STATE_DISTRICTS, "Select a valid state / union territory"),
    district: z.string().min(1, "Select district"),
    // Block and village are no longer asked when assigning (PIN code is the area); kept for older work.
    block: z.string().trim().max(60, "Block / Tehsil is too long").optional().default(""),
    village: z.string().trim().max(60, "Village / Ward is too long").optional().default(""),
    pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit PIN code"),
    deadline: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a deadline")
      .refine((d) => !Number.isNaN(Date.parse(d)), "Choose a valid deadline")
      .refine((d) => d >= todayIST(), "Deadline cannot be in the past"),
    instructions: z.string().trim().max(1000, "Instructions are too long").optional().transform((v) => v || undefined),
  })
  .superRefine((v, ctx) => {
    if (!STATE_DISTRICTS[v.state]?.includes(v.district)) {
      ctx.addIssue({ code: "custom", path: ["district"], message: "Select a valid district for the chosen state" });
    }
  });

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

export const changeVerifierSchema = z.object({
  verifierId: z.string().trim().min(1, "Select a Verifier").max(20).transform((v) => v.toUpperCase()),
});

export const changeDeoSchema = z.object({
  deoId: z.string().trim().min(1, "Select a Data Entry Operator").max(20).transform((v) => v.toUpperCase()),
});

export const updateAssignmentSchema = z.object({
  status: z.enum(["completed", "cancelled"], { error: "Choose completed or cancelled" }),
});
