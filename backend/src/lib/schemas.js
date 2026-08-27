const { z } = require('zod');

const MessageSchema = z.object({
  message: z.string().min(1).max(5000),
  language: z.enum(['th', 'en']).default('th'),
});

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
  CreateFolderSchema, UpdateFolderSchema, UpdateCleSchema,
};
