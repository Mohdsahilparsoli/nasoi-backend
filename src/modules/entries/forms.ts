import { z } from "zod";

/*
 * Entry forms. One definition drives everything: server validation, the form
 * the DEO fills (served to the frontend by GET /entry-forms), the detail views
 * and the Excel / CSV export columns.
 *
 * kind:
 *  - code / text      typed value (code has a fixed pattern)
 *  - choice           dropdown that also allows typing; `strict` = value must be one of the options
 *  - year / number    numbers (years are shown as a dropdown that also allows typing)
 *  - phone / email / url
 */

export type RecordType = "school" | "college";
export const RECORD_TYPES = ["school", "college"] as const;

export interface FieldDef {
  key: string;
  label: string;
  kind: "code" | "text" | "choice" | "year" | "number" | "phone" | "email" | "url";
  section: string;
  required?: boolean;
  options?: readonly string[];
  strict?: boolean;
  pattern?: string;
  patternMessage?: string;
  max?: number;
  min?: number;
  /** Shown (and validated) only when another field has one of these values. */
  showIf?: { field: string; in: readonly string[] };
  /** Number/year must be ≥ (min) or ≤ (max) another field. */
  notBefore?: string;
  notAbove?: string;
  hint?: string;
  placeholder?: string;
  wide?: boolean;
}

export interface FormDef {
  type: RecordType;
  label: string;
  codeField: string;
  nameField: string;
  sections: string[];
  fields: FieldDef[];
}

const YES_NO = ["Yes", "No"] as const;
const CLASSES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;
const LANGUAGES = [
  "Hindi", "English", "Urdu", "Sanskrit", "Assamese", "Bengali", "Bodo", "Dogri", "Gujarati", "Kannada", "Kashmiri", "Konkani",
  "Maithili", "Malayalam", "Manipuri", "Marathi", "Nepali", "Odia", "Punjabi", "Santali", "Sindhi", "Tamil", "Telugu", "Others",
] as const;
const BOARDS = ["CBSE", "State Board", "CISCE (ICSE / ISC)", "NIOS", "International Board", "Others", "NA"] as const;

const SCHOOL_CATEGORIES = [
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
  "Pre-Primary only",
] as const;

const SCHOOL_MANAGEMENTS = [
  "Department of Education",
  "Tribal Welfare Department",
  "Local Body",
  "Government Aided",
  "Private Unaided (Recognized)",
  "Other Govt. Managed Schools",
  "Partially Govt. Aided",
  "Unrecognized",
  "Social Welfare Department",
  "Ministry of Labour",
  "Kendriya Vidyalaya / Central School",
  "Jawahar Navodaya Vidyalaya",
  "Sainik School",
  "Railway School",
  "Central Tibetan School",
  "Madarsa Recognized (by Wakf Board / Madarsa Board)",
  "Madarsa Unrecognized",
  "Other Central Govt. Schools",
] as const;

const S1 = "School Profile";
const S2 = "Medium of Instruction";
const S3 = "Visit to School for / by";
const S4 = "Establishment, Recognition & Affiliation";
const S5 = "Building & Facilities";
const RURAL = { field: "ruralUrban", in: ["Rural"] } as const;
const URBAN = { field: "ruralUrban", in: ["Urban"] } as const;

/** School – the "School Profile Details" of UDISE+. */
const SCHOOL: FormDef = {
  type: "school",
  label: "School",
  codeField: "udiseCode",
  nameField: "schoolName",
  sections: [S1, S2, S3, S4, S5],
  fields: [
    { key: "udiseCode", label: "UDISE Code", kind: "code", section: S1, required: true, pattern: "^\\d{11}$", patternMessage: "UDISE code must be exactly 11 digits", max: 11, placeholder: "e.g. 09171602108", hint: "11-digit UDISE+ code" },
    { key: "schoolName", label: "School Name", kind: "text", section: S1, required: true, max: 150, min: 3 },
    { key: "educationalBlock", label: "Educational Block", kind: "text", section: S1, required: true },
    { key: "ruralUrban", label: "Rural / Urban", kind: "choice", options: ["Rural", "Urban"], strict: true, section: S1, required: true },
    { key: "cluster", label: "Cluster", kind: "text", section: S1, required: true },
    { key: "lgdBlock", label: "LGD Block", kind: "text", section: S1, required: true, showIf: RURAL },
    { key: "lgdPanchayat", label: "LGD Panchayat", kind: "text", section: S1, required: true, showIf: RURAL },
    { key: "lgdVillage", label: "LGD Village", kind: "text", section: S1, required: true, showIf: RURAL },
    { key: "urbanLocalBody", label: "Urban Local Body", kind: "text", section: S1, required: true, showIf: URBAN, placeholder: "e.g. Etah-Municipality" },
    { key: "lgdWard", label: "LGD Ward", kind: "text", section: S1, required: true, showIf: URBAN, placeholder: "e.g. Etah (MB) - Ward No.13" },
    { key: "schoolCategory", label: "School Category", kind: "choice", options: SCHOOL_CATEGORIES, section: S1, required: true, wide: true },
    { key: "schoolManagement", label: "School Management", kind: "choice", options: SCHOOL_MANAGEMENTS, section: S1, required: true, wide: true },
    { key: "schoolType", label: "School Type", kind: "choice", options: ["Co-educational", "Boys", "Girls"], strict: true, section: S1, required: true },
    { key: "lowestClass", label: "Lowest Class", kind: "choice", options: CLASSES, strict: true, section: S1, required: true },
    { key: "highestClass", label: "Highest Class", kind: "choice", options: CLASSES, strict: true, section: S1, required: true, notBefore: "lowestClass" },
    { key: "prePrimary", label: "Pre Primary", kind: "choice", options: YES_NO, strict: true, section: S1, required: true },

    { key: "medium1", label: "Medium 1", kind: "choice", options: LANGUAGES, section: S2, required: true },
    { key: "medium2", label: "Medium 2", kind: "choice", options: LANGUAGES, section: S2 },
    { key: "medium3", label: "Medium 3", kind: "choice", options: LANGUAGES, section: S2 },
    { key: "medium4", label: "Medium 4", kind: "choice", options: LANGUAGES, section: S2 },

    { key: "acadInspections", label: "Acad. Inspections", kind: "number", section: S3, max: 999 },
    { key: "crcCoordinatorVisits", label: "CRC Coordinator", kind: "number", section: S3, max: 999 },
    { key: "blockOfficerVisits", label: "Block Level Officers", kind: "number", section: S3, max: 999 },
    { key: "stateDistrictOfficerVisits", label: "State / District Officers", kind: "number", section: S3, max: 999 },

    { key: "yearEstablished", label: "Year of Establishment", kind: "year", section: S4, required: true },
    { key: "yearRecognitionPri", label: "Year of Recognition – Pri.", kind: "year", section: S4, notBefore: "yearEstablished", hint: "Leave blank if not recognised" },
    { key: "yearRecognitionUpr", label: "Year of Recognition – Upr. Pr.", kind: "year", section: S4, notBefore: "yearEstablished" },
    { key: "yearRecognitionSec", label: "Year of Recognition – Sec.", kind: "year", section: S4, notBefore: "yearEstablished" },
    { key: "yearRecognitionHsec", label: "Year of Recognition – Higher Sec.", kind: "year", section: S4, notBefore: "yearEstablished" },
    { key: "affiliationBoardSec", label: "Affiliation Board – Sec", kind: "choice", options: BOARDS, section: S4 },
    { key: "affiliationBoardHsec", label: "Affiliation Board – HSec", kind: "choice", options: BOARDS, section: S4 },

    { key: "shiftSchool", label: "Is this a Shift School?", kind: "choice", options: YES_NO, strict: true, section: S5, required: true },
    { key: "buildingStatus", label: "Building Status", kind: "choice", options: ["Private", "Rented", "Government", "Government school in a rent-free building", "No Building", "Dilapidated", "Under Construction"], section: S5, required: true },
    { key: "boundaryWall", label: "Boundary Wall", kind: "choice", options: ["Pucca", "Pucca but broken", "Barbed wire fencing", "Hedges", "No boundary wall", "Partial", "Under Construction", "Others"], section: S5, required: true },
    { key: "buildingBlocks", label: "No. of Building Blocks", kind: "number", section: S5, required: true, max: 999 },
    { key: "puccaBuildingBlocks", label: "Pucca Building Blocks", kind: "number", section: S5, required: true, max: 999, notAbove: "buildingBlocks" },
    { key: "specialSchoolCwsn", label: "Is Special School for CWSN?", kind: "choice", options: YES_NO, strict: true, section: S5, required: true },
    { key: "ramps", label: "Availability of Ramps", kind: "choice", options: YES_NO, strict: true, section: S5, required: true },
    { key: "handrails", label: "Availability of Handrails", kind: "choice", options: YES_NO, strict: true, section: S5, required: true },
    { key: "anganwadi", label: "Anganwadi at Premises", kind: "choice", options: ["Yes", "No", "NA"], strict: true, section: S5, required: true },
    { key: "residentialSchool", label: "Residential School", kind: "choice", options: ["Residential", "Partially Residential", "Non Residential"], section: S5, required: true },
    { key: "residentialType", label: "Residential Type", kind: "choice", options: ["Ashram (Govt.)", "Non-Ashram type (Govt.)", "Private", "KGBV", "Model School", "Others", "NA"], section: S5 },
    { key: "minoritySchool", label: "Minority School", kind: "choice", options: YES_NO, strict: true, section: S5, required: true },
    { key: "allWeatherRoad", label: "Approachable by All Weather Road", kind: "choice", options: YES_NO, strict: true, section: S5, required: true },
  ],
};

const C1 = "College Profile";
const C2 = "Courses & Accreditation";
const C3 = "Contact";

/** College – basic profile (AISHE). */
const COLLEGE: FormDef = {
  type: "college",
  label: "College",
  codeField: "aisheCode",
  nameField: "collegeName",
  sections: [C1, C2, C3],
  fields: [
    { key: "aisheCode", label: "AISHE Code", kind: "code", section: C1, required: true, pattern: "^[CSU]-\\d{3,7}$", patternMessage: "AISHE code looks like C-12345", max: 9, placeholder: "e.g. C-12345", hint: "Code from aishe.gov.in" },
    { key: "collegeName", label: "College Name", kind: "text", section: C1, required: true, max: 150, min: 3 },
    { key: "affiliatingUniversity", label: "Affiliating University", kind: "text", section: C1, required: true, max: 150 },
    { key: "collegeType", label: "College Type", kind: "choice", options: ["Affiliated College", "Constituent College", "Autonomous College", "Standalone Institution", "Off-Campus Centre", "Recognised Centre"], section: C1, required: true },
    { key: "management", label: "Management", kind: "choice", options: ["Government", "Private Aided", "Private Unaided", "Local Body", "Central Government"], section: C1, required: true },
    { key: "ruralUrban", label: "Rural / Urban", kind: "choice", options: ["Rural", "Urban"], strict: true, section: C1, required: true },
    { key: "block", label: "Block / Town", kind: "text", section: C1, required: true },
    { key: "address", label: "Address", kind: "text", section: C1, required: true, max: 200, wide: true },
    { key: "yearEstablished", label: "Year of Establishment", kind: "year", section: C1, required: true },
    { key: "collegeFor", label: "College for", kind: "choice", options: ["Co-education", "Boys", "Girls"], strict: true, section: C1, required: true },

    { key: "courseLevel", label: "Course Level", kind: "choice", options: ["UG", "PG", "UG & PG", "Diploma", "PhD", "Integrated"], section: C2, required: true },
    { key: "streams", label: "Streams / Courses Offered", kind: "text", section: C2, max: 200, wide: true, placeholder: "e.g. B.A., B.Sc., B.Com." },
    { key: "naacGrade", label: "NAAC Grade", kind: "choice", options: ["A++", "A+", "A", "B++", "B+", "B", "C", "Not Accredited"], section: C2 },
    { key: "totalStudents", label: "Total Students", kind: "number", section: C2, max: 200000 },
    { key: "totalTeachers", label: "Total Teachers", kind: "number", section: C2, max: 20000 },

    { key: "principalName", label: "Principal Name", kind: "text", section: C3, max: 80 },
    { key: "contactNumber", label: "Contact Number", kind: "phone", section: C3 },
    { key: "email", label: "Email", kind: "email", section: C3 },
    { key: "website", label: "Website", kind: "url", section: C3 },
  ],
};

export const FORMS: Record<RecordType, FormDef> = { school: SCHOOL, college: COLLEGE };
export const RECORD_LABEL: Record<RecordType, string> = { school: "School", college: "College" };

const currentYearIST = () => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" }).format(new Date()));
const visible = (f: FieldDef, v: Record<string, unknown>) => !f.showIf || f.showIf.in.includes(String(v[f.showIf.field] ?? ""));

/**
 * Validates a record against its form. Hidden fields (e.g. ward for a rural
 * school) are dropped; strict choices are normalised to the option's spelling.
 */
export function recordSchema(type: RecordType) {
  const form = FORMS[type];
  const raw = z.record(z.string(), z.unknown());
  return raw.transform((input, ctx) => {
    const out: Record<string, string | number> = {};
    const str = (v: unknown) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
    const fail = (key: string, message: string) => ctx.addIssue({ code: "custom", path: [key], message });

    // Strict choices first, so showIf can depend on them.
    const norm: Record<string, string> = {};
    for (const f of form.fields) {
      const s = str(input[f.key]);
      norm[f.key] = f.kind === "choice" && f.strict ? (f.options!.find((o) => o.toLowerCase() === s.toLowerCase()) ?? s) : s;
    }

    for (const f of form.fields) {
      if (!visible(f, norm)) continue;
      const s = norm[f.key];
      if (!s) {
        if (f.required) fail(f.key, `${f.label} is required`);
        continue;
      }
      switch (f.kind) {
        case "code":
          if (f.pattern && !new RegExp(f.pattern).test(s.toUpperCase())) fail(f.key, f.patternMessage ?? `${f.label} is not valid`);
          else out[f.key] = s.toUpperCase();
          break;
        case "year": {
          const y = Number(s);
          if (!/^\d{4}$/.test(s) || y < 1800 || y > currentYearIST()) fail(f.key, `${f.label}: choose a year between 1800 and ${currentYearIST()}`);
          else out[f.key] = y;
          break;
        }
        case "number": {
          const n = Number(s);
          if (!/^\d+$/.test(s) || n > (f.max ?? 1_000_000)) fail(f.key, `${f.label}: enter a whole number${f.max ? ` up to ${f.max}` : ""}`);
          else out[f.key] = n;
          break;
        }
        case "phone":
          if (!/^[6-9]\d{9}$/.test(s)) fail(f.key, `${f.label}: enter a valid 10-digit mobile number`);
          else out[f.key] = s;
          break;
        case "email":
          if (!z.email().safeParse(s).success || s.length > 120) fail(f.key, `${f.label}: enter a valid email`);
          else out[f.key] = s.toLowerCase();
          break;
        case "url":
          if (!/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s) || s.length > 150) fail(f.key, `${f.label}: enter a valid website`);
          else out[f.key] = s;
          break;
        case "choice":
          if (f.strict && !f.options!.includes(s)) fail(f.key, `Select ${f.label} from the list`);
          else if (s.length > (f.max ?? 120)) fail(f.key, `${f.label} is too long`);
          else out[f.key] = s;
          break;
        default:
          if (s.length < (f.min ?? 2)) fail(f.key, `Enter ${f.label}`);
          else if (s.length > (f.max ?? 80)) fail(f.key, `${f.label} is too long`);
          else out[f.key] = s;
      }
    }

    // Cross-field rules (years, class range, block counts).
    for (const f of form.fields) {
      const a = out[f.key];
      if (a === undefined) continue;
      if (f.notBefore && out[f.notBefore] !== undefined && Number(a) < Number(out[f.notBefore])) {
        fail(f.key, `${f.label} cannot be before ${form.fields.find((x) => x.key === f.notBefore)!.label}`);
      }
      if (f.notAbove && out[f.notAbove] !== undefined && Number(a) > Number(out[f.notAbove])) {
        fail(f.key, `${f.label} cannot be more than ${form.fields.find((x) => x.key === f.notAbove)!.label}`);
      }
    }
    return out;
  });
}

/** What the frontend needs to render the forms (no server-only details). */
export const publicForms = () => FORMS;
