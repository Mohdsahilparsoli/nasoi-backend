import { z } from "zod";
import { STATE_DISTRICTS } from "../../lib/india-locations.js";

/* Lists shared with the frontend form (src/lib/constants.ts). */
export const GENDERS = ["Male", "Female", "Other"] as const;
export const CATEGORIES = ["GEN", "OBC", "SC", "ST"] as const;
export const RELIGIONS = ["Hindu", "Muslim", "Christian", "Sikh", "Buddhist", "Jain", "Parsi", "Other"] as const;
export const QUALIFICATIONS = ["Class 5", "Class 8", "Class 10", "Class 12", "Graduation", "Post Graduation"] as const;
export const BANK_PROOF_TYPES = ["Bank Passbook", "Cancelled Cheque"] as const;
export const REGISTER_ROLES = ["deo", "verifier"] as const;

/* Verhoeff checksum – every valid Aadhaar number passes it. */
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export function isValidAadhaar(n: string) {
  if (!/^[2-9]\d{11}$/.test(n)) return false;
  let c = 0;
  n.split("").reverse().forEach((ch, i) => (c = D[c]![P[i % 8]![Number(ch)]!]!));
  return c === 0;
}

export const RX = {
  mobile: /^[6-9]\d{9}$/,
  pincode: /^[1-9]\d{5}$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  account: /^\d{9,18}$/,
  pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  personName: /^[A-Za-z][A-Za-z .'-]*$/,
};

export const passwordRule = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters")
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/\d/, "Password must contain a number");

const text = (label: string, min: number, max: number) =>
  z.string().trim().min(min, `${label} is required`).max(max, `${label} is too long`);
const personName = (label: string) =>
  text(label, 3, 60).regex(RX.personName, `${label} can contain only letters and spaces`).transform((v) => v.replace(/\s+/g, " ").toUpperCase());
const oneOf = <T extends readonly [string, ...string[]]>(label: string, list: T) =>
  z.enum(list, { error: `Select a valid ${label}` });

const docRef = z.object({ id: z.string().uuid(), token: z.string().min(20).max(100) });

function ageOn(dob: string) {
  const d = new Date(`${dob}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export const registrationSchema = z
  .object({
    role: z.enum(REGISTER_ROLES, { error: "Choose Data Entry Operator or Verifier" }),
    // Personal
    name: personName("Candidate full name"),
    fatherName: personName("Father's name"),
    motherName: personName("Mother's name"),
    dob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date of birth")
      .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date of birth")
      .refine((v) => {
        const a = ageOn(v);
        return a >= 18 && a <= 65;
      }, "You must be between 18 and 65 years old"),
    email: z.string().trim().toLowerCase().max(80).email("Enter a valid email ID"),
    mobile: z.string().trim().regex(RX.mobile, "Enter a valid 10-digit mobile number"),
    gender: oneOf("gender", GENDERS),
    category: oneOf("category", CATEGORIES),
    religion: oneOf("religion", RELIGIONS),
    // Address
    country: z.literal("India", { error: "Select country" }),
    state: z.string().refine((s) => s in STATE_DISTRICTS, "Select a valid state / union territory"),
    district: z.string().min(1, "Select district"),
    subDistrict: text("Sub district", 2, 60),
    postOffice: text("Post office name", 2, 60),
    pincode: z.string().trim().regex(RX.pincode, "Enter a valid 6-digit PIN code"),
    policeStation: text("Police station name", 2, 60),
    address: text("Full address", 10, 200),
    // Bank
    bankName: text("Bank name", 3, 60),
    accountHolder: personName("Account holder name"),
    accountNumber: z.string().regex(RX.account, "Account number should be 9–18 digits"),
    ifsc: z.string().trim().toUpperCase().regex(RX.ifsc, "Enter a valid 11-character IFSC code"),
    // Documents & qualification
    qualification: oneOf("qualification", QUALIFICATIONS),
    aadhaar: z.string().refine(isValidAadhaar, "Enter a valid 12-digit Aadhaar number"),
    pan: z
      .string()
      .trim()
      .toUpperCase()
      .optional()
      .transform((v) => v || undefined)
      .refine((v) => v === undefined || RX.pan.test(v), "Enter a valid PAN (e.g. ABCDE1234F)"),
    bankProofType: oneOf("bank document type", BANK_PROOF_TYPES),
    documents: z.object({
      aadhaar: docRef,
      pan: docRef.optional(),
      bank_proof: docRef,
      photo: docRef,
      signature: docRef,
    }),
    // Account
    password: passwordRule,
    declaration: z.literal(true, { error: "Please accept the declaration" }),
    terms: z.literal(true, { error: "Please accept the Terms & Conditions" }),
  })
  .superRefine((v, ctx) => {
    if (!STATE_DISTRICTS[v.state]?.includes(v.district)) {
      ctx.addIssue({ code: "custom", path: ["district"], message: "Select a valid district for the chosen state" });
    }
    if (v.pan && !v.documents.pan) ctx.addIssue({ code: "custom", path: ["documents", "pan"], message: "Please upload your PAN card" });
    if (!v.pan && v.documents.pan) ctx.addIssue({ code: "custom", path: ["pan"], message: "Enter the PAN number for the uploaded card" });
  });

export type RegistrationInput = z.infer<typeof registrationSchema>;
