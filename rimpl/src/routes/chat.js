const { Router } = require('express');
const { z } = require('zod');
const { stripPii, stripHistoryPii, primeRegistry, deriveHintTokens, makeRegistry } = require('../services/pii-filter');
const { ragLookup } = require('../services/rag');
const { callAI, providerSupportsThinking, supportsThinking } = require('../services/ai');
const { routeTurn } = require('../services/router');
const { hasCitation, extractSocraticQuestion, extractReferences, extractEvidenceLevel, spliceEvidenceLine, placeEvidenceLine, thaiShare, stripNonProse, isLanguageMismatch, isThaiMessage } = require('../services/post-filter');
const { chatSystemPrompt, EVIDENCE_RETRY_PROMPT } = require('../lib/prompts');
const { shouldAssess, rescueExhausted, assessQualifying, rescueDecision, checkRescueReply, RESCUE_RETRY_PROMPT } = require('../services/rescue');
const { formatDeidentified, stripArtifactDelimiters } = require('../lib/transcript');
const { requestSignal } = require('../lib/request-signal');
const { promptLabel } = require('../lib/versions');
const { sendAiError, logAiError, isAborted } = require('../lib/ai-errors');
const { sseStream } = require('../lib/sse');
const { boothReply } = require('../services/booth');

const router = Router();

// Per-reply output ceiling. Raised from the historical 1500/2500 so a substantial clinical artifact
// (DDx table / care plan) plus the prose + citation + closing ❓ fit without truncation. Cost is the
// ACTUAL tokens used, not the ceiling; the per-user $0.50 cap still bounds total spend.
const { CHAT_MAX_TOKENS, CHAT_DEEP_MAX_TOKENS, MAX_TURN_CHARS, EVIDENCE_LINE_MAX_TOKENS, CHAT_OPTIONAL_RETRY_CUTOFF_MS } = require('../lib/turn-limits'); // RIMPL_CHAT_MAX_TOKENS, default 4000; RIMPL_CHAT_DEEP_MAX_TOKENS, default 8000

const BoothId = z.string().regex(/^[a-z][a-z0-9_]{0,15}$/);
const BoothText = z.object({ th: z.string().min(1).max(300), en: z.string().min(1).max(300) }).strict();
const BoothBankSchema = z.object({
  variants: z.array(z.object({ id: BoothId, question: BoothText }).strict()).min(1).max(3),
  options: z.array(z.object({
    id: BoothId, tier: z.enum(['best', 'reasonable', 'weaker']), label: BoothText, line: BoothText,
  }).strict()).min(3).max(6),
}).strict();

const ChatSchema = z.object({
  ple_id: z.string(),
  // Per-turn cap: see lib/turn-limits.js (sized so no real physician or assistant turn can hit it).
  history: z.array(z.object({ role: z.string(), content: z.string().max(MAX_TURN_CHARS) })),
  message: z.string().min(1).max(MAX_TURN_CHARS),
  language: z.enum(['th', 'en']).default('th'),
  chief_complaint: z.string().optional(),
  // The physician's structured patient identifier (ple_patient_refs), passed on-prem SOLELY so RIMPL
  // can deterministically scrub it from the narrative before any cloud call — it is never forwarded.
  // nullish (not optional): the backend sends `?? null` when there is no patient_ref — null must pass.
  patient_ref: z.string().nullish(),
  // CLICS §6.4: true → Socratic clinical-examiner mode (CLE2 / Tier-1 remediation); false → natural.
  socratic: z.boolean().default(false),
  // Superadmin `clinical_artifacts` setting (the backend forwards it): true → allow the AI to emit
  // `:::artifact{...}` side-panel blocks. Default false; the transcript strip runs regardless.
  artifacts: z.boolean().default(false),
  // App setting `chat_evidence_marker` (the backend forwards it; CCME R5): true -> every non-rescue reply
  // must carry exactly one GRADE evidence-level line (lib/prompts.js EVIDENCE_GUIDANCE), checked below.
  // Default false. An older backend never sends it; an older RIMPL strips it (zod drops unknown keys).
  evidence_marker: z.boolean().default(false),
  // Socratic rescue state, forwarded by the backend from the `ples` row. RIMPL is stateless, so it
  // cannot know whether this session has already been rescued or has already qualified — and both
  // are latches (a session does not un-qualify). Without them the classifier would re-run on every
  // turn past the fourth, roughly doubling the AI cost of a long, good session.
  rescue_active: z.boolean().default(false),
  // Rounds this rescue has already run. RIMPL is stateless, so the spend cap cannot live here alone.
  rescue_rounds: z.number().int().min(0).default(0),
  already_qualified: z.boolean().default(false),
  // Stream the reply as server-sent events (lib/sse.js). Honoured on every turn EXCEPT a rescue turn,
  // which is answered whole as before: its post-check may rewrite the reply, and a physician who had
  // watched the first draft arrive would already have read the answer the rescue exists to withhold.
  stream: z.boolean().default(false),
  // App setting `chat_router_enabled` (the backend forwards it; CCME mapping §2.1): true -> run the
  // fast/deep router (services/router.js) on this turn. Default false, and an older backend never sends
  // it: the request each provider receives is then byte-identical to one sent before the router existed.
  router_enabled: z.boolean().default(false),
  // The router's sticky latch, forwarded by the backend from the `ples` row: true once
  // ples.deep_mode_at is set (a turn of this session has already been routed deep). RIMPL is stateless,
  // so it cannot remember that itself. Read only when router_enabled.
  deep_mode: z.boolean().default(false),
  // Booth Mode (#209/#211): the backend (#210) sends it for a conference-kiosk play. true -> the turn is
  // answered by services/booth.js, not the PLE pipeline below. An older RIMPL strips it (zod drops it).
  booth_mode: z.boolean().default(false),
  // Grill play (#246, ADR 0006): the next step's bank, the case author's reviewed fictional text, not user
  // input. Sent with booth_mode, absent for the reply to the last answer. Bounds mirror the backend's
  // tree-schema.js Bank with headroom on the strings.
  booth_bank: BoothBankSchema.optional(),
  // Typed answer (#247, ADR 0006): the last answer was typed, so this one call also sorts it into a tier. `current`
  // is the bank the step offered (the yardstick), `next` the following step's bank for each tier the answer might
  // land in (absent after the last answer). Takes the place of booth_bank.
  booth_typed: z.object({
    current: BoothBankSchema,
    next: z.object({ best: BoothBankSchema, reasonable: BoothBankSchema, weaker: BoothBankSchema }).strict().optional(),
  }).strict().optional(),
  // Booth play kept as research data (#375, ADR 0010): the visitor's typed answer alone, already inside `message`.
  // Returned de-identified as answer_deidentified so the backend never stores the raw text; never sent to the AI.
  // Headroom over the backend's ANSWER_MAX_CHARS (500).
  booth_answer: z.string().min(1).max(600).optional(),
  // Booth reply cache (#387): the backend's entries at this point of the case, newest first, for a typed answer
  // (booth_typed and booth_answer) while its switch is on. rimpl embeds answer_deidentified and may name one to
  // reuse; the replies stay in the backend. An older RIMPL strips it.
  booth_cache: z.object({
    entries: z.array(z.object({
      id: z.string().min(1).max(64),
      model: z.string().min(1).max(200),
      embedding: z.array(z.number()).max(4096),
      cues: z.array(z.string().max(64)).max(64),
    }).strict()).max(64),
  }).strict().optional(),
});

// De-identify everything one outbound call carries under ONE registry, so a token means one person
// (or phone, HN, ...) across the whole prompt: `[NAME-1]` in the history and `[NAME-1]` in the
// current message are the same referent, and one person never gets two tokens. Separate registries
// (as here before) numbered each piece from 1, so two different patients could share `[NAME-1]`.
//
// ORDER IS LOAD-BEARING. Tokens are numbered by first appearance in processing order, and a name part
// seen earlier is also caught bare later (the filter's bare-name pass). The order is the order the
// session happened in: chief complaint (given at creation) -> stored history, oldest first -> the
// current message. That makes the numbering prefix-stable: turn N numbers every earlier turn exactly
// as turn N-1 did, so the tokens the model wrote into its own stored replies keep meaning the same
// person on later turns. POST /deidentify (the auditor's view) uses the same order for the same reason.
//
// Returns the pieces still separate: the caller embeds `cleanMessage` for RAG and sends the very same
// string to the model (the RAG lookup and the AI call must see identical de-identified text).
function deidentifyTurn({ chiefComplaint, history, message, hints }) {
  const registry = makeRegistry();
  // Every surname found anywhere in the turn masks every other mention, in the same order as below (#238).
  primeRegistry([chiefComplaint || '', ...history.map((m) => m.content), message], registry, hints);
  const cleanChiefComplaint = chiefComplaint ? stripPii(chiefComplaint, registry, hints) : '';
  const cleanHistory = stripHistoryPii(history, hints, registry);
  const cleanMessage = stripPii(message, registry, hints);
  return { cleanChiefComplaint, cleanHistory, cleanMessage };
}

// A booth physician turn (backend/src/services/booth-dialogue.js dialogueTurns) is the vetted vignette (turn 1 only),
// the vetted bank question, then the visitor's answer. A typed answer comes fenced behind a note line (#400,
// booth-dialogue.js `fenced`): `[vignette \n\n] question \n note \n ⟦answer⟧`, read from the end, so a line break in
// the question cannot move the fence. The backend strips the fence marks from the answer, and the note holds no line
// break. A tapped answer, or a typed one from a backend older than #400, follows the first line bare
// (backend/src/booth-cases/tree-schema.js refuses a question that holds a line break). `own`: the question masks on
// its own.
const FENCED = /(?:^|\n)([^\n]*)\n⟦([^⟦⟧]*)⟧$/;
function boothTurnParts(content, first, hints) {
  let vignette = null;
  let rest = content;
  const gap = first ? rest.indexOf('\n\n') : -1;
  if (gap >= 0) { vignette = rest.slice(0, gap); rest = rest.slice(gap + 2); }
  const fence = FENCED.exec(rest);
  const end = fence ? fence.index : rest.indexOf('\n');
  const question = end > 0 ? rest.slice(0, end) : null;
  return {
    vignette, question, own: question !== null && stripPii(question, makeRegistry(), hints) !== question,
    note: fence ? fence[1] : null, answer: fence ? fence[2] : rest.slice(end + 1),
  };
}

// The clean forms of `lead` and of `answer` read after it on the next line, as if the note line were not between
// them. The cut between the two falls in the clean text, so neither side holds anything the filter did not see: a cut
// inside a token moves back to the token's '[', and an end of `lead` the filter left as typed after the cut, up to a
// token or a space, goes back to its side.
function cleanAfter(lead, answer, strip) {
  if (!lead) return { cleanLead: '', cleanAnswer: strip(answer) };
  const clean = strip(`${lead}\n${answer}`);
  const cleanBefore = strip(lead);
  let cut = 0;
  while (cut < cleanBefore.length && cleanBefore[cut] === clean[cut]) cut += 1;
  const open = cut > 0 ? clean.lastIndexOf('[', cut - 1) : -1;
  if (open > clean.lastIndexOf(']', cut - 1)) cut = open;
  const rest = clean.slice(cut);
  for (let k = Math.min(rest.length, lead.length); k > 0; k -= 1) {
    if (lead.endsWith(rest.slice(0, k)) && (k === rest.length || /[\s[]/.test(rest[k]))) { cut += k; break; }
  }
  // The line break between them, which the filter may have turned into a space.
  return { cleanLead: clean.slice(0, cut), cleanAnswer: clean.slice(cut).replace(/^\s/, '') };
}

// What of a question the answer is read after: all of it, unless the question masks on its own. Vetted text holds no
// PII, so such a mask is a false positive: a question opening with the pronoun คุณ ("คุณจะส่งตรวจ…") becomes a name,
// which then takes the answer on the next line as its surname (#406), and its words become that name's aliases; a
// label can mask on its own at the end of a question too (นางสาว reads as the title นาง and the name สาว). Then it is
// the longest end of the question that, read with the answer, leaves no token of its own in the answer, under a
// registry that knows what every other question of the call that masks on its own masks, and what this one masks once
// it is read apart (any end short of all of it). So a label that ends the question masks the value typed under it (#375,
// #412), and no false name in the question takes the answer.
function boothLead(part, ownParts, hints, from) {
  const { question, own, answer } = part;
  if (question === null || !own) return question ?? '';
  for (let start = from; start < question.length; start += 1) {
    const lead = question.slice(start);
    const known = makeRegistry();
    const others = ownParts.filter((p) => start > 0 || p !== part).map((p) => p.question);
    primeRegistry([...others, `${lead}\n${answer}`], known, hints);
    const { cleanLead, cleanAnswer } = cleanAfter(lead, answer, (s) => stripPii(s, known, hints));
    if (!takenBy(cleanLead, cleanAnswer)) return lead;
  }
  return '';
}

// Whether a clean answer holds a token of the clean question text it was read after: a name in the question took it.
const TOKEN = /\[[A-Z]+-\d+\]/g;
const takenBy = (cleanLead, cleanAnswer) => (cleanAnswer.match(TOKEN) ?? []).some((t) => cleanLead.includes(t));

// The texts of a turn's parts in the order they are read: the answer after its lead, and a question read `apart`
// (only part of it leads the answer) as a text of its own before it.
const boothTurnTexts = ({ vignette, question, lead, apart, note, answer }) => [
  vignette, apart ? question : null, lead ? `${lead}\n${answer}` : answer, note,
].filter((s) => s !== null);

// A question read apart is read on its own for its line; the note is read on its own.
function cleanBoothTurn({ vignette, question, lead, apart, note, answer }, registry, hints) {
  const strip = (s) => stripPii(s, registry, hints);
  const head = vignette === null ? '' : `${strip(vignette)}\n\n`;
  const { cleanLead, cleanAnswer } = cleanAfter(lead, answer, strip);
  const cleanQuestion = question === null ? null : apart ? strip(question) : cleanLead;
  const said = note === null ? cleanAnswer : `${strip(note)}\n⟦${cleanAnswer}⟧`;
  return { content: `${head}${cleanQuestion === null ? '' : `${cleanQuestion}\n`}${said}`, lead: cleanLead, answer: cleanAnswer };
}

// deidentifyTurn for a booth turn: the same one registry and order, with each physician turn read in its parts.
// The kept typed answer (#375) is the answer exactly as the AI sees it: the text inside the fence (or after the
// question line, unfenced). It holds none of the vetted text before it, except a token the filter laid over both.
// A lead is first checked against what the other questions mask; once every text of the call is known, a lead whose
// question still took its answer reads less of the question, until none does (a lead of nothing takes nothing).
function deidentifyBoothTurn({ chiefComplaint, history, message, hints, boothAnswer }) {
  const turns = [...history, { role: 'physician', content: message }];
  const firstPhysician = turns.findIndex((m) => m.role === 'physician');
  const parts = turns.map((m, i) => (m.role === 'physician' ? boothTurnParts(m.content, i === firstPhysician, hints) : null));
  const ownParts = parts.filter((p) => p?.own);
  const from = new Map(ownParts.map((p) => [p, 0]));
  for (;;) {
    for (const p of parts.filter(Boolean)) {
      p.lead = boothLead(p, ownParts, hints, from.get(p));
      p.apart = p.question !== null && p.lead !== p.question;
    }
    const registry = makeRegistry();
    primeRegistry([chiefComplaint || '', ...turns.flatMap((m, i) => (parts[i] ? boothTurnTexts(parts[i]) : [m.content]))], registry, hints);
    const cleanChiefComplaint = chiefComplaint ? stripPii(chiefComplaint, registry, hints) : '';
    const cleaned = turns.map((m, i) => (parts[i] ? cleanBoothTurn(parts[i], registry, hints) : { content: stripPii(m.content, registry, hints) }));
    const taken = parts.filter((p, i) => p?.own && p.lead && takenBy(cleaned[i].lead, cleaned[i].answer));
    if (taken.length === 0) {
      const cleanTurns = turns.map((m, i) => ({ ...m, content: cleaned[i].content }));
      const cleanMessage = cleanTurns.pop().content;
      const cleanBoothAnswer = boothAnswer ? cleaned[cleaned.length - 1].answer || null : undefined;
      return { cleanChiefComplaint, cleanHistory: cleanTurns, cleanMessage, cleanBoothAnswer };
    }
    for (const p of taken) from.set(p, p.question.length - p.lead.length + 1);
  }
}

// Every input here MUST already be PII-stripped by deidentifyTurn (see the route): this function only
// assembles the prompt and masks nothing.
function buildMessages(cleanHistory, cleanMessage, ragDocs, cleanChiefComplaint) {
  // Ground every turn in the case the physician opened the session with, so the AI
  // never has to ask for patient details it was already given at creation.
  const cc = cleanChiefComplaint
    ? `ข้อมูลผู้ป่วยเบื้องต้น / Case (chief complaint): ${cleanChiefComplaint}\n\n`
    : '';
  const context = ragDocs.length
    ? `\n\nRelevant guidelines:\n${ragDocs.map(d => `[${d.source}] ${d.content}`).join('\n')}`
    : '';
  // Strip any clinical-artifact control syntax from prior turns before replaying them to the cloud:
  // the artifact body stays (clinical context the AI may need), but the `:::artifact{...}` fence never
  // re-enters the chat context — otherwise the model would see, and start mimicking, the literal delimiter.
  const history = cleanHistory.map(m => ({
    role: m.role === 'physician' ? 'user' : 'assistant',
    content: stripArtifactDelimiters(m.content),
  }));
  return [...history, { role: 'user', content: cc + cleanMessage + context }];
}

// What the model LAST saw plus what it said, for the ONE call whose answer is returned — as a plain
// integer, or null. The backend stores this as ples.context_tokens for its transcript cap; the
// input_tokens / output_tokens it also receives are BILLING figures and are summed over every call in
// the turn, so on a citation-retry turn they run ~2x the real context and the 64k cap fired at ~32k.
// null, never 0, when the provider reported no usage at all: the backend then falls back to its own
// sum instead of storing a zero that would let the cap never fire.
function contextTokens(inputTokens, outputTokens) {
  if (inputTokens == null && outputTokens == null) return null;
  const n = Number(inputTokens ?? 0) + Number(outputTokens ?? 0);
  return Number.isInteger(n) ? n : null;
}

router.post('/', async (req, res) => {
  // The turn's clock, for the optional-retry cutoff below (the backend's deadline runs from about here).
  const turnStartedAt = Date.now();
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { history, message, language, chief_complaint, patient_ref, socratic, artifacts, evidence_marker,
          rescue_active, already_qualified, rescue_rounds, stream, router_enabled, deep_mode, booth_mode, booth_bank, booth_typed, booth_answer,
          booth_cache } = parsed.data;
  // KNOWN patient identifiers to scrub deterministically (closes the bare-unlabelled-name leak).
  const hints = deriveHintTokens(patient_ref);
  // Examiner mode (CLE2 / remediation) leads with Socratic questioning and MUST end on ❓; natural
  // mode (CLE1/CLE3) answers directly and must NOT force a ❓ — that's the experimental contrast.
  // Append the artifact guidance only when the superadmin toggle (forwarded as `artifacts`) is on, and
  // the evidence-marker guidance (its placement differs by mode) only when `evidence_marker` is on. A
  // rescue turn REPLACES all of this below, so the rescue prompt never carries either. The assembly is
  // lib/prompts.js chatSystemPrompt, the one the model manifest enumerates.
  let systemPrompt = chatSystemPrompt({ socratic, artifacts, evidenceMarker: evidence_marker });
  // Fires if the physician's client (or the backend's deadline) hangs up: a queued call leaves the
  // queue and an in-flight one is cancelled, so a turn nobody is waiting for stops holding the model.
  const signal = requestSignal(req, res);
  // Set once the rescue decision is known (below). Until a first delta is sent the route answers in
  // plain JSON, so every early failure keeps its usual status and body.
  let sse = null;

  try {
    // De-identify ONCE, up front, under one shared registry (deidentifyTurn): PII must never leave
    // the on-prem boundary — not to Claude and not to the OpenAI embeddings API behind RAG.
    // ragLookup previously received the raw message.
    const { cleanChiefComplaint, cleanHistory, cleanMessage, cleanBoothAnswer } = booth_mode
      ? deidentifyBoothTurn({ chiefComplaint: chief_complaint, history, message, hints, boothAnswer: booth_answer })
      : deidentifyTurn({ chiefComplaint: chief_complaint, history, message, hints });
    // BOOTH MODE (#211): after the de-identification above and before anything else a PLE turn does. No
    // RAG, and always plain JSON, even with `stream`; a failure takes the catch below.
    if (booth_mode) {
      return res.json(await boothReply({
        messages: buildMessages(cleanHistory, cleanMessage, [], cleanChiefComplaint), bank: booth_bank, typed: booth_typed,
        answerDeidentified: cleanBoothAnswer, cache: booth_cache, signal,
      }));
    }
    const ragDocs = await ragLookup(cleanMessage);
    const messages = buildMessages(cleanHistory, cleanMessage, ragDocs, cleanChiefComplaint);

    // Socratic rescue (CREC082 PLE Instruction Sheet §4). Decided HERE, from the conversation, on
    // the turn it applies to — never from which episode this is or who the physician is.
    //
    // Failure is silent by design. If the classifier errors or returns malformed JSON, the turn
    // proceeds as a normal reply: a missed rescue costs one scaffolding nudge, whereas failing the
    // request would cost the physician their turn over an advisory signal. It is logged, not raised.
    let rescue = null;
    const exchangesSoFar = history.filter(m => m.role === 'physician' || m.role === 'user').length;

    // The rescue has run its round cap. It ends HERE, under the rescue prompt one last time — the
    // constraint holds for the turn the physician is already mid-way through — and the backend is
    // told so it can close the rescue out and record why it ended. Falling through to the block
    // below instead would have produced a turn on the general examiner prompt, which is the
    // instrument swap the per-round rescue exists to prevent.
    if (rescueExhausted({ rescueActive: rescue_active, rescueRounds: rescue_rounds })) {
      systemPrompt = chatSystemPrompt({ rescue: true });
      rescue = {
        activated: false, rescuing: true, recovered: false, exhausted: true,
        reason: 'rescue round cap reached without the session qualifying',
        elements: null, on_topic: null, qualifying: null,
        exchanges_before: exchangesSoFar,
        // No classifier ran, so there is nothing to bill. Reported as zero rather than omitted, so
        // the backend's spend path sees the same shape on every round.
        assessment: { input_tokens: 0, output_tokens: 0, provider: null },
      };
    } else if (shouldAssess({ history, socraticActive: socratic, rescueActive: rescue_active, alreadyQualified: already_qualified, rescueRounds: rescue_rounds })) {
      try {
        // Include the turn just sent — the physician may have qualified the session WITH this
        // message, and rescuing them for a gap they have already closed would be plainly wrong.
        // The turns already stripped above, under the SAME registry, so the classifier reads the
        // tokens the chat call reads (re-stripping here used a fresh registry: a second numbering).
        const assessed = await assessQualifying(
          formatDeidentified([...cleanHistory, { role: 'physician', content: cleanMessage }]), { signal });
        const decision = rescueDecision(assessed);
        rescue = {
          // First activation, distinct from a later round of an ongoing rescue. The backend stamps
          // the activation POINT from this and must never move it, so the two cannot share a flag.
          activated: decision.rescue && !rescue_active,
          // This round actually ran under the rescue prompt — the condition the post-check and the
          // citation skip both key off, and true on continuing rounds as well as the first.
          rescuing: decision.rescue,
          // The session came back. This is the "return to PLE eligibility" the analysis plan asks
          // for, and it was unobservable while a rescued session was assessed only once.
          recovered: rescue_active && !decision.rescue,
          // Only the cap-reached branch above sets this.
          exhausted: false,
          reason: decision.reason,
          elements: assessed.elements,
          on_topic: assessed.onTopic,
          qualifying: assessed.qualifying,
          exchanges_before: exchangesSoFar,
          // Reported so the backend can charge it to the STUDY rather than the physician. These
          // tokens were returned by the classifier all along and simply thrown away, which made the
          // spend invisible — fine at one call per session, not fine at one per round.
          assessment: {
            input_tokens: assessed.inputTokens ?? 0,
            output_tokens: assessed.outputTokens ?? 0,
            provider: assessed.provider ?? null,
          },
        };
        if (decision.rescue) systemPrompt = chatSystemPrompt({ rescue: true });
      } catch (e) {
        // The client has hung up: there is no turn to deliver, so do not buy the reply either.
        if (isAborted(e)) throw e;
        console.error('[RIMPL chat] rescue assessment failed, continuing as a normal turn:', e.message);
        // A malformed classifier reply was still BILLED. Report the usage even though the assessment
        // is unusable, or the study's cost record drifts below what was actually spent — and under
        // an active rescue the next turn buys another one.
        if (e.usage) {
          rescue = {
            activated: false, rescuing: false, recovered: false, exhausted: false, reason: null,
            elements: null, on_topic: null, qualifying: null,
            exchanges_before: exchangesSoFar,
            assessment: {
              input_tokens: e.usage.inputTokens ?? 0,
              output_tokens: e.usage.outputTokens ?? 0,
              provider: e.usage.provider ?? null,
            },
          };
        }
      }
    }

    // A rescue turn asks questions and deliberately gives no answer, so it has nothing to cite and
    // the citation retry does not apply — running it would prompt the model to answer, which is the
    // one thing the rescue must not do.
    const rescuing = !!rescue?.rescuing;   // EVERY rescue round, not only the first

    // FAST/DEEP ROUTER (services/router.js; app setting chat_router_enabled, forwarded as
    // `router_enabled`). Decided HERE: after the rescue decision, because a rescue turn is always fast,
    // and before the first call. It reads `cleanMessage` — the de-identified text the model is about to
    // receive, never the raw `message` — and returns only a tier, a reason from a fixed set and its
    // version. `route` is recorded whatever happens next (middleware_flags below), so the record says
    // what the router decided even on a turn where the tier could not be applied.
    const route = router_enabled
      ? routeTurn({ message: cleanMessage, historyLength: cleanHistory.length, socratic, rescuing, sticky: deep_mode })
      : null;
    // The tier is APPLIED only where it changes what the provider does: a chat provider that honours
    // `thinking` (services/ai.js providerSupportsThinking: an on-prem instance whose THINKING_STYLE is
    // set). Anywhere else, and always with the router off, no `thinking` field is sent and the ceiling
    // stays CHAT_MAX_TOKENS, so the request is byte-identical to one sent before the router existed.
    const tierApplied = route ? await providerSupportsThinking('chat') : false;
    const deep = tierApplied && route.tier === 'deep';
    // Reasoning tokens count against max_tokens, so a deep turn runs under the larger ceiling.
    // (lib/turn-limits.js TIER_POLICY / RETRY_POLICY describe this wiring for the model manifest;
    // tests/manifest-chat-policy.test.js holds the two equal.)
    const turnMaxTokens = deep ? CHAT_DEEP_MAX_TOKENS : CHAT_MAX_TOKENS;

    // Streaming: known only now, because a rescue turn is never streamed (see the schema).
    if (stream && !rescuing) sse = sseStream(res);
    let shown = false;   // text of the CURRENT call has reached the caller
    let contentStarted = false;   // ANY reply text has been streamed this turn (never reset, unlike `shown`)
    const onDelta = sse ? (t) => { shown = true; contentStarted = true; sse.send('delta', { text: t }); } : undefined;
    // SSE `status` {phase:'thinking'}: sent ONCE, when the reply's reasoning starts arriving and before
    // any reply text, so the physician sees "thinking…" through a deep turn's silence. Router on and
    // streamed turns only: with the router off the stream is exactly what it was. The provider reports
    // THAT reasoning began (providers/local-factory.js onReasoning), never what it was. Sending it opens
    // the stream, so a failure after reasoning began arrives as the `done` event carrying its usual
    // status and body — the same as a failure after the first delta (lib/sse.js).
    let statusSent = false;
    const onReasoning = sse && router_enabled
      ? () => { if (statusSent || contentStarted) return; statusSent = true; sse.send('status', { phase: 'thinking' }); }
      : undefined;

    const firstCall =
      await callAI({ purpose: 'chat', systemPrompt, messages, maxTokens: turnMaxTokens, signal, onDelta,
        ...(tierApplied ? { thinking: deep } : {}), ...(onReasoning ? { onReasoning } : {}) });
    let { text, tokenCount, inputTokens, outputTokens, provider, model, failed_over_from } = firstCall;
    // Was the tier honoured by the provider that ANSWERED? Normally the one asked above — but not after
    // the (dormant) chat fail-over, or a superadmin toggle flipped between that question and the call.
    // A turn must never be recorded as thought on a provider that ignores `thinking`; nor is the retry
    // below, pinned to `provider`, sent a field that provider would ignore (it is sent thinking:false).
    const thinkingHonoured = tierApplied && supportsThinking(provider);
    // The call whose answer goes back: the retry below REPLACES these while the billing sums accumulate.
    // On a fail-over turn this result already is the fail-over call's, so these are its figures.
    let lastInputTokens = inputTokens;
    let lastOutputTokens = outputTokens;
    // The first reply as produced, and whether the physician watched it arrive (for the placement fix below).
    const firstReply = text;
    const firstReplyShown = shown;
    // PLACEMENT (evidence marker on, not a rescue turn): a reply with exactly ONE valid marker that sits in
    // the wrong place — examiner: anywhere but directly above the final ❓ (after it, physician-ui's ❓
    // display breaks and the question renders twice); natural: anywhere but the last line — or next to a
    // near-miss evidence statement, is put right by post-filter placeEvidenceLine with NO model call. null
    // = nothing to move. Applied to whichever reply is returned: an adopted retry below, or the first.
    const placeMarker = (t) => (evidence_marker && !rescuing ? placeEvidenceLine(t, { socratic }) : null);

    // ONE corrective retry, whatever is wrong. Independent checks decide whether it fires, and a turn
    // that fails several gets a SINGLE retry whose prompt asks for every fix, so a turn never makes
    // more than two AI calls in total (and the billing sums below stay a plain two-call sum).
    //   - citation missing (both modes), or — examiner mode only — the ❓ missing. Not on a rescue turn.
    //   - LANGUAGE: the physician wrote substantially in Thai and the reply is mostly-not-Thai
    //     (post-filter's isLanguageMismatch, which ignores code, URLs, citations, :::artifact blocks
    //     and a trailing References list). `language === 'th'` alone is NOT enough: the client sets it
    //     when the message contains ANY Thai codepoint, so "What is first-line for CAP? ครับ" is 'th'.
    //     We therefore also require the physician's own message to be >= THAI_MIN_SHARE Thai, so a
    //     physician who wrote in English is never forced into Thai (an English turn is never policed
    //     either). That share is computed here, on-prem; only the boolean outcome is used. This check
    //     DOES apply to a rescue turn: it asks for a rewrite, not a fresh answer, so it cannot make a
    //     rescue reply answer the question it is deliberately withholding.
    const needCitation = !rescuing && (!hasCitation(text) || (socratic && !extractSocraticQuestion(text)));
    const physicianWroteThai = language === 'th' && isThaiMessage(message);
    const languageMismatch = physicianWroteThai && isLanguageMismatch(text, language);
    // RESCUE: a rescue reply with no question, more than the allowed questions, or a diagnosis/plan breaks
    // the rescue (rescue.js checkRescueReply). It gets the same single retry — a REWRITE into questions.
    const needRescue = rescuing && !checkRescueReply(text).ok;
    // EVIDENCE MARKER (evidence_marker on): exactly one parseable evidence-level line, outside any fence
    // (post-filter extractEvidenceLevel). Not on a rescue turn: the rescue prompt replaced the guidance
    // and a rescue reply recommends nothing to grade.
    const needEvidence = evidence_marker && !rescuing && extractEvidenceLevel(text) == null;
    let languageRetried = false;   // the retry's reply is the one being returned
    let rescueRetried = false;
    let evidenceRetried = false;   // the returned reply carries the line the evidence retry supplied
    // A streamed first draft that the retry below replaces. The physician watched it arrive, so the
    // record keeps it (the backend stores it beside the reply it was replaced by); never set on a
    // non-streamed turn, where nobody saw it.
    let supersededDraft = null;
    let supersededReason = null;
    // Which check the single retry is for, most important first. 'language' and 'evidence' are the
    // OPTIONAL ones: their first reply was already deliverable (cited, with its ❓ in examiner mode), so
    // a failure of either retry keeps the first reply instead of failing the turn.
    const reason = needCitation ? 'citation' : needRescue ? 'rescue' : languageMismatch ? 'language' : needEvidence ? 'evidence' : null;
    // DEADLINE (lib/turn-limits.js CHAT_OPTIONAL_RETRY_CUTOFF_MS, half the backend's 100 s). An optional
    // retry that would START this late, and take as long as the first call did, would run past the
    // backend's deadline — which fails the WHOLE turn closed and loses a reply that was deliverable. So
    // it is skipped: the first reply goes out as it is, logged by elapsed time only (never content).
    const elapsedMs = Date.now() - turnStartedAt;
    const retrySkipped = (reason === 'language' || reason === 'evidence') && elapsedMs > CHAT_OPTIONAL_RETRY_CUTOFF_MS;
    if (retrySkipped) {
      console.warn(`[RIMPL chat] ${reason} retry skipped: ${elapsedMs} ms into the turn, past the ${CHAT_OPTIONAL_RETRY_CUTOFF_MS} ms cutoff — delivering the first reply`);
    }
    // EVIDENCE-ONLY (the marker is the one thing wrong): SPLICE, DON'T ADOPT. The first reply already
    // passed every other check and, streamed, is already being read, so it is KEPT. The retry asks for
    // the marker line alone, in a small call, and post-filter spliceEvidenceLine writes that one line into
    // the first reply. Nothing else the model writes is used, so it cannot drop an artifact or reword
    // prose behind the physician's back. Combined failures (citation + evidence, language + evidence)
    // still re-answer / rewrite in full, with the marker asked for in the same retry.
    const evidenceOnly = reason === 'evidence';
    if ((needCitation || languageMismatch || needRescue || needEvidence) && !retrySkipped) {
      let retryPrompt;
      if (needCitation) {
        retryPrompt = socratic
          ? (language === 'th'
            ? 'ช่วยตอบคำถามเดิมให้ครบถ้วนและเป็นประโยชน์อีกครั้ง โดยใส่การอ้างอิงอย่างน้อยหนึ่งแห่งในรูปแบบ (แหล่ง, ปี) และปิดท้ายด้วยคำถามชวนคิดขึ้นบรรทัดใหม่นำหน้าด้วย ❓ — ตอบให้จริง ไม่ต้องปฏิเสธคำถาม'
            : 'Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation and end with a ❓ question on its own line. Engage with the question — do not decline to answer.')
          : (language === 'th'
            ? 'ช่วยตอบคำถามเดิมให้ครบถ้วนและเป็นประโยชน์อีกครั้ง โดยใส่การอ้างอิงอย่างน้อยหนึ่งแห่งในรูปแบบ (แหล่ง, ปี) — ตอบให้จริง ไม่ต้องปฏิเสธคำถาม และไม่ต้องปิดท้ายด้วยคำถามชวนคิด'
            : 'Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation. Engage with the question — do not decline, and do not append a follow-up question.');
        // Both checks failed: the same single retry also pins the language.
        if (languageMismatch) retryPrompt += ' และเขียนคำตอบทั้งหมดเป็นภาษาไทย (Write the whole reply in Thai.)';
        // A re-answer that must also carry the evidence line.
        if (needEvidence) retryPrompt += EVIDENCE_RETRY_PROMPT.suffix[language];
      } else if (needRescue) {
        retryPrompt = language === 'th' ? RESCUE_RETRY_PROMPT.th : RESCUE_RETRY_PROMPT.en;
        if (languageMismatch) retryPrompt += ' และเขียนเป็นภาษาไทย (Write it in Thai.)';
      } else if (languageMismatch) {
        // Language (and perhaps the evidence line): the reply is otherwise acceptable, so ask for a
        // rewrite that keeps its content, citations, any ❓ and any :::artifact block — not a new answer.
        retryPrompt = 'กรุณาเขียนคำตอบก่อนหน้านี้ใหม่เป็นภาษาไทย โดยคงเนื้อหาทางคลินิก การอ้างอิง (แหล่ง, ปี) และคำถามที่ขึ้นต้นด้วย ❓ (ถ้ามี) ไว้ตามเดิม และคงบล็อก :::artifact ทั้งบล็อก (ถ้ามี) ไว้ตามเดิมทุกประการ — ชื่อยา ตัวย่อ และชื่อแหล่งอ้างอิงเป็นภาษาอังกฤษได้ '
          + '(Please rewrite your previous reply in Thai, keeping the same clinical content, (Source, Year) citations and any ❓ question on its own line. Keep any :::artifact block exactly as is, fence lines included. Drug names, abbreviations and source titles may stay in English.)';
        if (needEvidence) retryPrompt += EVIDENCE_RETRY_PROMPT.suffix[language];
      } else {
        // Evidence line only: ask for the LINE alone (see evidenceOnly above) — not a rewrite.
        retryPrompt = EVIDENCE_RETRY_PROMPT.only[language];
      }
      // A citation retry re-ANSWERS, so the artifact fence is stripped from the just-produced reply
      // before it is fed back, and the corrected reply doesn't echo the literal delimiter. A
      // language-only retry REWRITES and must keep the fence the side panel depends on, so it sees the
      // reply intact — but only when artifacts are on (the system prompt then explains the fence); with
      // them off a stray fence is stripped as before. (The marker-only call sees it the same way; its
      // answer is never stored, only the one line taken from it.)
      const keepFence = !needCitation && !needRescue && artifacts;
      const retryMessages = [...messages,
        { role: 'assistant', content: keepFence ? text : stripArtifactDelimiters(text) },
        { role: 'user', content: retryPrompt },
      ];
      // The full reply ceiling, CHAT_MAX_TOKENS — a corrected reply may itself carry an artifact, so a LOWER
      // retry cap would truncate it worse than the original (the old 1500 cap assumed a "<400 words" reply).
      // The exception is the marker-only call, which asks for one line (EVIDENCE_LINE_MAX_TOKENS).
      //
      // The retry NEVER THINKS, even after a deep first call: with the router's tier applied it is sent
      // `thinking: false` (and with it not applied, no field at all, as before). The first call already did
      // the reasoning, and every retry is a rewrite of that reply (cite it, close it on ❓, put it in Thai,
      // turn it into questions, give the evidence line) — not a fresh problem. A second reasoning pass would
      // roughly double a deep turn, and a deep first call plus its MANDATORY citation retry, both thinking,
      // would not fit inside the backend's chat deadline (RIMPL_CHAT_TIMEOUT_MS), which fails the whole
      // turn closed. So the retry also drops back to the FAST ceiling: CHAT_DEEP_MAX_TOKENS exists only to
      // leave the reasoning room, and this call has none to leave. The marker-only call never thought
      // either: a reasoning trace cannot fit in 128 tokens, and would eat the line it exists to fetch.
      //
      // PINNED to whichever provider served the first call. Now that the provider is a live setting
      // rather than an env var, a superadmin flipping `chat` between these two calls would otherwise
      // have ONE physician turn written half by Claude and half by the DGX — and `messages` has no
      // model column, so nothing would record that it happened. `provider` is undefined only when a
      // caller mocked callAI without it, in which case this falls back to normal resolution.
      const firstText = text;
      const firstShown = shown;
      // Tell the caller the text it is showing is about to be replaced. The retry itself is NOT streamed:
      // a retry that failed half-way would leave words on screen that no record holds (and a failed
      // language-only retry keeps the first reply). Its finished text goes out in one piece below.
      // Not for the marker-only call: it never replaces what is on screen up front (decided below).
      if (sse && firstShown && !evidenceOnly) { sse.send('replace', { reason }); shown = false; }
      let retry;
      try {
        retry = await callAI({ purpose: 'chat', provider, systemPrompt, messages: retryMessages,
          maxTokens: evidenceOnly ? EVIDENCE_LINE_MAX_TOKENS : CHAT_MAX_TOKENS, signal,
          ...(thinkingHonoured ? { thinking: false } : {}) });
      } catch (err) {
        // The client is gone, or the retry was needed for a missing citation/❓ (that reply was not
        // deliverable, and failing closed there is the existing behaviour): propagate.
        if (isAborted(err) || needCitation) throw err;
        // A LANGUAGE-only (or rescue / evidence-line) retry is a nicety on top of a reply that was
        // already deliverable. Losing the physician's turn (and, on a rescue turn, the rescue activation
        // riding on this response) to a queue_full / 413 / 5xx on it would be worse than the first
        // answer. Keep the first reply and its token sums; log the code only, never content.
        console.warn(`[RIMPL chat] ${reason} retry failed (${err?.code ?? err?.status ?? 'error'}) — delivering the first reply`);
        retry = null;
      }
      // Billed whatever becomes of its text below.
      if (retry) {
        tokenCount += retry.tokenCount;
        inputTokens += retry.inputTokens;
        outputTokens += retry.outputTokens;
      }
      if (retry && evidenceOnly) {
        // context_tokens stays the FIRST call's: the stored reply is the first reply plus one line, and
        // the marker call's own prompt (the conversation again) is not context the next turn carries.
        const spliced = spliceEvidenceLine(firstText, retry.text, { socratic });
        if (!spliced) {
          console.warn('[RIMPL chat] evidence retry gave no single evidence line — delivering the first reply unchanged');
        } else {
          text = spliced.text;
          evidenceRetried = true;
          if (sse) {
            if (firstShown && text.startsWith(firstText)) {
              // NATURAL: the line is appended after what the physician is reading. A plain delta, no
              // `replace`, nothing superseded — the screen and the record end up holding the same text.
              sse.send('delta', { text: text.slice(firstText.length) });
            } else {
              // EXAMINER: the line goes directly ABOVE the ❓, i.e. mid-text, so it cannot be a delta (nor
              // can a natural reply whose stray evidence statements had to be removed). `replace` with the
              // whole spliced reply, and the draft is recorded as for any replaced draft. The alternative —
              // appending after the ❓ — would break the examiner rule that the ❓ is the very last line,
              // which physician-ui relies on to show the question as the question (ple-chat.js strips a
              // trailing ❓ line into its own element), and would make the streamed reply differ from the
              // non-streamed one.
              if (firstShown) { sse.send('replace', { reason }); supersededDraft = firstText; supersededReason = reason; }
              sse.send('delta', { text });
            }
          }
        }
      } else if (retry) {
        // The adopted re-answer / rewrite gets the same placement fix, before it goes out.
        text = placeMarker(retry.text) ?? retry.text;
        lastInputTokens = retry.inputTokens;
        lastOutputTokens = retry.outputTokens;
        languageRetried = languageMismatch;
        rescueRetried = needRescue;
        evidenceRetried = needEvidence;
        if (firstShown) { supersededDraft = firstText; supersededReason = reason; }
        if (sse) sse.send('delta', { text });
        // The one retry is all there is. If the reply is STILL not Thai, deliver it (a late English
        // answer beats a 502) but leave a trace with the measured share only — never the content.
        if (languageMismatch && isLanguageMismatch(text, language)) {
          console.warn(`[RIMPL chat] language retry did not produce Thai (share ${thaiShare(stripNonProse(text)).toFixed(2)}) — delivering as-is`);
        }
      }
    }

    // The first reply stands (no retry, a skipped one, a failed one, or a marker retry that gave no line):
    // put a misplaced marker right. Streamed, the physician has read the misplaced version, so it is
    // replaced on screen and recorded as a superseded draft, the same path as the examiner splice.
    if (text === firstReply) {
      const placed = placeMarker(text);
      if (placed) {
        if (sse && firstReplyShown) {
          if (shown) sse.send('replace', { reason: 'evidence' });   // not already cleared by a retry's replace
          sse.send('delta', { text: placed });
          supersededDraft = firstReply;
          supersededReason = 'evidence';
        }
        text = placed;
      }
    }

    const evidenceLevel = evidence_marker && !rescuing ? extractEvidenceLevel(text) : null;
    (sse ? sse.out() : res).json({
      content: text,
      refs: extractReferences(text),
      socratic_question: extractSocraticQuestion(text),
      token_count: tokenCount,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      // The returned call's own in+out (see contextTokens above) — NOT the two-call sums above it.
      context_tokens: contextTokens(lastInputTokens, lastOutputTokens),
      // Which vendor actually served this turn — the backend prices per provider (local = $0), so
      // omitting it under a hybrid would bill on-prem tokens at cloud rates.
      provider,
      model,
      // Which instructions produced this reply: the hash of the system prompt actually sent on the
      // returned call (mode prompt, rescue prompt if the rescue took over, plus artifact guidance).
      prompt_version: promptLabel('chat', systemPrompt),
      // Set only when the primary provider was down and CHAT_FAILOVER_PROVIDER answered instead
      // (services/ai.js; dormant — unset — by default). Null on every ordinary turn. The citation
      // retry above is pinned to `provider`, so the whole turn came from the provider named above.
      failed_over_from: failed_over_from ?? null,
      // True when the language guard fired AND its retry's reply is the one returned. False when the
      // guard did not fire, or when its retry failed and the first reply was kept. Advisory and
      // rimpl-local: the backend whitelists its response to the physician and does not forward this.
      language_retry: languageRetried,
      // True when the rescue rules failed on the first reply AND the rewrite is the reply returned.
      rescue_retry: rescueRetried,
      // CCME R5 evidence marker: the level the returned reply's ONE evidence line states — 'high' |
      // 'moderate' | 'low' | 'expert' | 'not_graded', a STABLE set (lib/prompts.js EVIDENCE_LEVELS) — or null: setting off, a rescue turn, or no single parseable
      // line even after the retry (the reply is delivered regardless; this field is how that shows).
      // Advisory, like language_retry: the backend whitelists its physician response and does not
      // forward either field.
      evidence_level: evidenceLevel,
      // True when the evidence check fired on the first reply AND the returned reply came from its retry:
      // the marker line spliced in (evidence-only), or the combined re-answer / rewrite returned. False
      // when the check did not fire, the retry failed or was skipped (deadline), or gave no single line.
      evidence_retry: evidenceRetried,
      // Advisory, for the backend to persist: which turn the rescue fired on, why, and whether the
      // reply actually honoured the protocol's constraints. The SAP analyses trigger rate and
      // activation point, so an unrecorded rescue is a lost data point.
      // Post-checked on every round that ran under the rescue prompt. Checking only the first round
      // left rounds two onward of a rescued session governed by no constraint at all.
      rescue: rescue && { ...rescue, reply_check: rescue.rescuing ? checkRescueReply(text) : null },
      // The per-turn middleware record (CCME mapping §2: with a router, the thinking flag has to be
      // recorded PER TURN). ALWAYS present on success, same seven keys, so the backend stores one object
      // per turn whatever is switched on. Every value is a fixed vocabulary, a number or null — nothing
      // derived from the conversation's text:
      //   router_version  'router-v1' … (services/router.js ROUTER_VERSION); null with the router off
      //   tier            'fast' | 'deep' as ROUTED; null with the router off
      //   reason          services/router.js REASONS ('rescue' | 'sticky' | a keyword category | 'default')
      //   thinking        true | false as sent to, and honoured by, the provider that answered; null when
      //                   no tier was applied (router off, or a provider that ignores `thinking`) — so a
      //                   routed `tier: 'deep'` with `thinking: null` was decided but NOT applied
      //   thinking_budget the max_tokens a deep turn ran under (reasoning + reply); null otherwise
      // `thinking` and `thinking_budget` describe the FIRST call of the turn — the one the tier governs.
      // A corrective retry, if one ran, is always thinking:false at CHAT_MAX_TOKENS (or the marker-only
      // EVIDENCE_LINE_MAX_TOKENS), so it has nothing to record here; whether it ran is language_retry /
      // rescue_retry / evidence_retry (and, streamed, superseded_reason) in this same body.
      //   evidence_level  = evidence_level above
      //   failed_over_from = failed_over_from above
      middleware_flags: {
        router_version: route ? route.version : null,
        tier: route ? route.tier : null,
        reason: route ? route.reason : null,
        thinking: thinkingHonoured ? deep : null,
        thinking_budget: thinkingHonoured && deep ? (firstCall.maxTokens ?? turnMaxTokens) : null,
        evidence_level: evidenceLevel,
        failed_over_from: failed_over_from ?? null,
      },
      // Streamed turns only (absent otherwise, so a non-streamed body is unchanged): the draft the
      // physician saw before the retry replaced it, and which check replaced it.
      ...(sse ? { superseded_draft: supersededDraft, superseded_reason: supersededReason } : {}),
    });
  } catch (err) {
    logAiError('[RIMPL chat]', err);
    // 503 queue_full (+ Retry-After) / 499 client gone / 413 transcript_too_large / else this 500.
    // Once a stream is open the error becomes its final event, with the status and body it would
    // have had (lib/sse.js out()).
    const out = sse ? sse.out() : res;
    sendAiError(out, err, 'AI service temporarily unavailable. Please try again.');
    if (sse?.open && isAborted(err) && !res.writableEnded) res.end();
  }
});

module.exports = router;
