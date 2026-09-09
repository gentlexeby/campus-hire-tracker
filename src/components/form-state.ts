export type DuplicateApplicationSummary = {
  companyName: string;
  positionTitle: string;
  cycleLabel: string | null;
};

export type EventConflictSummary = {
  title: string;
  type: string;
  timezone: string | null;
  schedule:
    | { kind: "TIMED"; startsAtMs: number; endsAtMs: number | null }
    | { kind: "ALL_DAY"; startDate: string; endDateExclusive: string };
};

export type SafeFormDetails =
  | { kind: "DUPLICATE_APPLICATIONS"; matches: DuplicateApplicationSummary[] }
  | { kind: "EVENT_CONFLICTS"; conflicts: EventConflictSummary[] };

export type FormState = {
  ok?: boolean;
  /** Advances when a form needs a fresh client-side control state after submission. */
  formRevision?: number;
  code?: string;
  message?: string;
  details?: SafeFormDetails;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
  /** Returned only after a notes mutation so the browser draft can be reconciled safely. */
  savedVersion?: number;
  savedAtMs?: number;
  savedNotesMarkdown?: string | null;
};

export const initialFormState: FormState = {};
