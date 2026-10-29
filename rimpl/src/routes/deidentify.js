const { Router } = require('express');
const { z } = require('zod');
const { stripPii, stripHistoryPii, primeRegistry, deriveHintTokens, makeRegistry } = require('../services/pii-filter');
const { MAX_TURN_CHARS } = require('../lib/turn-limits');

// POST /deidentify — the de-identified copy of a stored transcript, for a HUMAN reader who must not
// see identifiers (the auditor; docs/CONSENT-TEMPLATE.md: "Auditors see only the de-identified
// transcript"). The raw transcript stays the evidentiary record in the backend DB; this returns a
// masked copy and changes nothing.
//
// No AI call: nothing here leaves the on-prem boundary, and nothing is logged — not the content, not
// the patient_ref, not the hints. Behind the same internal-token gate as every other route (index.js).
//
// ONE registry for the whole request, in the order the chat route uses (routes/chat.js
// deidentifyTurn): chief complaint first, then the messages in the order given (the caller sends them
// oldest first). The numbering is then the one the chat model saw, so a token the model wrote into
// its own stored reply ("[NAME-2] should ...") names the same person the masked physician turn does.
const router = Router();

// Entry ceiling. Each turn is already capped at MAX_TURN_CHARS (the /chat and /audit-discuss cap) and
// the whole body by express.json's RIMPL_BODY_LIMIT (2mb, index.js) — the same bounds a transcript
// meets on /evaluate. This only stops a flood of tiny entries; a real PLE (a 64k-token transcript cap,
// plus a reflection and the caller's per-turn extras) sits far below it.
const MAX_DEIDENTIFY_MESSAGES = 5000;

const Turn = z.object({ role: z.string().max(64), content: z.string().max(MAX_TURN_CHARS) });
const DeidentifySchema = z.object({
  messages: z.array(Turn).max(MAX_DEIDENTIFY_MESSAGES),
  // The physician's structured patient identifier, as /chat accepts it: scrub hints only, never echoed.
  patient_ref: z.string().nullish(),
  chief_complaint: z.string().max(MAX_TURN_CHARS).nullish(),
});

router.post('/', (req, res) => {
  const parsed = DeidentifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { messages, patient_ref, chief_complaint } = parsed.data;
  try {
    const hints = deriveHintTokens(patient_ref);
    const registry = makeRegistry();
    primeRegistry([chief_complaint || '', ...messages.map((m) => m.content)], registry, hints); // #238
    // Chief complaint FIRST: see the header. Empty string stays empty (stripPii returns it as is).
    const cleanChiefComplaint = chief_complaint ? stripPii(chief_complaint, registry, hints) : chief_complaint;
    const cleanMessages = stripHistoryPii(messages, hints, registry)
      .map(m => ({ role: m.role, content: m.content }));
    res.json({
      messages: cleanMessages,
      ...(chief_complaint != null ? { chief_complaint: cleanChiefComplaint } : {}),
    });
  } catch (err) {
    // Fail closed: no partial result, nothing raw. The error CLASS only — a filter failure must not
    // write the transcript it was given into the logs.
    console.error(`[RIMPL deidentify] de-identification failed (${err?.name || 'Error'})`);
    res.status(500).json({ error: 'deidentify_failed' });
  }
});

module.exports = router;
module.exports.MAX_DEIDENTIFY_MESSAGES = MAX_DEIDENTIFY_MESSAGES;
