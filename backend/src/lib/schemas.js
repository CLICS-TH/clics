const { z } = require('zod');

const MessageSchema = z.object({
  message: z.string().min(1).max(5000),
  language: z.enum(['th', 'en']).default('th'),
});

// How clear a domain's behavioural anchor was for this transcript. The approved assessment form asks
// it per domain, and the calibration workshop's stated output is a map of exactly this.
const ANCHOR_CLARITY = ['clear', 'moderate', 'ambiguous'];

// The per-assessment confirmations the form ends with. Distinct from the one-time confidentiality /
// COI consent held at account level: these are claims about THIS assessment. Exported so the route,
// the tests and the client all read one list — a checklist that drifts between client and server is
// a checklist the server is not really enforcing.
const SCORE_ATTESTATIONS = [
  'all_domains_scored',      // D1-D7 complete
  'comments_recorded',       // comments written where the form expects them
  'scored_independently',    // scored alone, without seeing the AI score
  'no_identifiers_found',    // no suspected identifier, or one was reported
  'weights_provisional',     // understands the domain weights are provisional
];

const ScoreSchema = z.object({
  d1: z.number().int().min(0).max(5),
  d2: z.number().int().min(0).max(5),
  d3: z.number().int().min(0).max(5),
  d4: z.number().int().min(0).max(5),
  d5: z.number().int().min(0).max(5),
  d6: z.number().int().min(0).max(5),
  d7: z.number().int().min(0).max(5),
  // Bound the one free-text field (every other text field here is capped); otherwise an auditor
  // could persist up to the 1mb body limit into audit_scores.notes.
  notes: z.string().max(4000).optional(),
  // Optional so an assessment submitted without them is a MISSING judgement rather than a rejected
  // submission — the anchor field informs later rubric work and must never block a rater.
  d1_anchor: z.enum(ANCHOR_CLARITY).optional(),
  d2_anchor: z.enum(ANCHOR_CLARITY).optional(),
  d3_anchor: z.enum(ANCHOR_CLARITY).optional(),
  d4_anchor: z.enum(ANCHOR_CLARITY).optional(),
  d5_anchor: z.enum(ANCHOR_CLARITY).optional(),
  d6_anchor: z.enum(ANCHOR_CLARITY).optional(),
  d7_anchor: z.enum(ANCHOR_CLARITY).optional(),
  // NOT optional, and re-checked in the route. A disabled button is a courtesy, not a gate.
  attestations: z.record(z.string(), z.boolean()).optional(),
});

// An auditor reporting a suspected identifier instead of submitting a score.
const PrivacyConcernSchema = z.object({
  note: z.string().min(1).max(4000),
});

const CreateCleSchema = z.object({
  // (per-CLE specialty was collected but never persisted — cles has no such column; the select
  // was removed from cle-new. Unknown keys from older cached clients are stripped by zod.)
  chief_complaint: z.string().min(1).max(500),
  folder_id: z.string().uuid().optional(),
  // Structured patient identifier — stored in the isolated cle_patient_refs table ONLY, NEVER sent
  // to the cloud AI / auditors / export. Lets the case narrative stay name-free (real-PII de-id).
  patient_ref: z.string().max(200).optional(),
  // Pilot Test Mode only: directly choose the conversation mode so a tester can exercise Socratic
  // without completing the real CLE1→CLE2 sequence. Ignored unless pilot_test_mode is ON.
  socratic: z.boolean().optional(),
});

const AssignSchema = z.object({
  auditor_id: z.string().uuid(),
});

// Conversation folders (physician-owned)
const CreateFolderSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
const UpdateFolderSchema = CreateFolderSchema;

// Rename / move a conversation. folder_id null => move to "Uncategorized".
const UpdateCleSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  folder_id: z.string().uuid().nullable().optional(),
}).refine((b) => b.title !== undefined || b.folder_id !== undefined, {
  message: 'Provide at least one of: title, folder_id',
});

// Post-PLE reflection (CREC082 ICF §3 step 3). The three prompts are the protocol's own, from PLE
// Instruction Sheet §3. The ceiling is generous on purpose: this is scored evidence for D6, and
// truncating a physician's own words would corrupt what the rubric is reading.
const ReflectionSchema = z.object({
  learned: z.string().trim().max(5000).optional(),
  uncertainty: z.string().trim().max(5000).optional(),
  application: z.string().trim().max(5000).optional(),
  skipped: z.boolean().optional(),
});

module.exports = {
  MessageSchema, ScoreSchema, CreateCleSchema, AssignSchema, ReflectionSchema,
  PrivacyConcernSchema, SCORE_ATTESTATIONS, ANCHOR_CLARITY,
  CreateFolderSchema, UpdateFolderSchema, UpdateCleSchema,
};
