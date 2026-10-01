import { z } from "zod";

/*
 * School record ("New Add Entry"). Option lists follow UDISE+ wording and are
 * shared with the frontend (src/lib/school-options.ts) – keep both in sync.
 */

export const RURAL_URBAN = ["Rural", "Urban"] as const;

export const SCHOOL_CATEGORIES = [
  "Pre-Primary only",
  "Primary only (1-5)",
  "Primary with Upper Primary (1-8)",
  "Primary with Upper Primary, Secondary and Higher Secondary (1-12)",
  "Upper Primary only (6-8)",
  "Upper Primary with Secondary and Higher Secondary (6-12)",
  "Primary with Upper Primary and Secondary (1-10)",
  "Upper Primary with Secondary (6-10)",
  "Secondary only (9-10)",
  "Secondary with Higher Secondary (9-12)",
  "Higher Secondary only / Jr. College (11-12)",
] as const;

export const SCHOOL_MANAGEMENTS = [
  "Department of Education",
  "Tribal Welfare Department",
  "Social Welfare Department",
  "Local Body",
  "Government Aided",
  "Partially Government Aided",
  "Private Unaided (Recognized)",
  "Other State Govt. Managed",
  "Kendriya Vidyalaya / Central School",
  "Jawahar Navodaya Vidyalaya",
  "Sainik School",
  "Railway School",
  "Central Tibetan School",
  "Ministry of Labour",
  "Other Central Govt. Schools",
  "Madarsa Recognized (by Wakf Board / Madarsa Board)",
  "Madarsa Unrecognized",
  "Unrecognized",
] as const;

export const SCHOOL_TYPES = ["Co-educational", "Boys", "Girls"] as const;

const currentYearIST = () => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" }).format(new Date()));

/** Trim and collapse inner spaces. */
const text = (label: string, min = 2, max = 80) =>
  z
    .string({ error: `${label} is required` })
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(min, `${label} is required`).max(max, `${label} is too long`));

const choice = <T extends readonly [string, ...string[]]>(list: T, label: string) => z.enum(list, { error: `Select ${label}` });

const year = (label: string) =>
  z.coerce
    .number({ error: `Enter ${label}` })
    .int(`Enter ${label} as a 4-digit year`)
    .min(1800, `${label} looks wrong`)
    .refine((y) => y <= currentYearIST(), `${label} cannot be in the future`);

export const entrySchema = z
  .object({
    udiseCode: z.string({ error: "UDISE code is required" }).trim().regex(/^\d{11}$/, "UDISE code must be exactly 11 digits"),
    schoolName: text("School name", 3, 150),
    educationalBlock: text("Educational block"),
    ruralUrban: choice(RURAL_URBAN, "Rural / Urban"),
    cluster: text("Cluster"),
    lgdBlock: text("LGD block"),
    lgdPanchayat: text("LGD panchayat"),
    lgdVillage: text("LGD village"),
    schoolCategory: choice(SCHOOL_CATEGORIES, "school category"),
    schoolManagement: choice(SCHOOL_MANAGEMENTS, "school management"),
    yearEstablished: year("Year of establishment"),
    // Unrecognised schools have no recognition year, so it is optional.
    yearRecognitionPri: z.preprocess((v) => (v === "" || v === null ? undefined : v), year("Year of recognition").optional()),
    schoolType: choice(SCHOOL_TYPES, "school type"),
  })
  .superRefine((v, ctx) => {
    if (v.yearRecognitionPri !== undefined && v.yearRecognitionPri < v.yearEstablished) {
      ctx.addIssue({ code: "custom", path: ["yearRecognitionPri"], message: "Year of recognition cannot be before the year of establishment" });
    }
  });

export type EntryInput = z.infer<typeof entrySchema>;
