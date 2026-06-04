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
  notes: z.string().optional(),
});

const CreatePleSchema = z.object({
  specialty: z.string().optional(),
  chief_complaint: z.string().min(1).max(500),
});

const AssignSchema = z.object({
  auditor_id: z.string().uuid(),
});

module.exports = { MessageSchema, ScoreSchema, CreatePleSchema, AssignSchema };
