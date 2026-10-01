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

/** Today's date in India (YYYY-MM-DD). */
export function todayIST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

const text = (label: string, min: number, max: number) =>
  z.string().trim().min(min, `${label} is required`).max(max, `${label} is too long`);

export const createAssignmentSchema = z
  .object({
    deoId: z.string().trim().min(1, "Select a Data Entry Operator").max(20).transform((v) => v.toUpperCase()),
    taskType: z.enum(TASK_TYPES, { error: "Select the service" }),
    target: z.coerce.number({ error: "Enter the number of entries" }).int("Enter a whole number").min(1, "Target must be at least 1").max(100000, "Target is too large"),
    ratePerEntry: z.coerce.number({ error: "Enter the rate" }).int("Enter a whole number").min(1, "Rate must be at least ₹1").max(1000, "Rate is too high"),
    state: z.string().refine((s) => s in STATE_DISTRICTS, "Select a valid state / union territory"),
    district: z.string().min(1, "Select district"),
    block: text("Block / Tehsil", 2, 60),
    village: text("Village / Ward", 2, 60),
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

export const updateAssignmentSchema = z.object({
  status: z.enum(["completed", "cancelled"], { error: "Choose completed or cancelled" }),
});
