# Five-step grill play: banks keyed on the previous tier, tapped answers replied from a reviewed reply bank

Status: accepted 2026-11-04 for booth round 2's second wave; not live until every ready case switches to five steps in one deploy. Amends ADR 0006: the option text rule holds, the bank keying and who picks the next question change.

The reply bank part was deferred past the second wave (owner, 2026-11-04, #382) so that the wave fits one week, and lands with #382. From then a five-step case is drawn only with a complete, reviewed reply bank (`backend/src/booth-cases/reply-bank.js`, AUTHORING.md "The reply bank"), and a tapped answer on it makes no AI call. One reply entry serves every variant of its bank: three reviewed alternatives per (bank, chosen option, language), as a reply comments on the option, not the question's wording. The tree keying applies from the five-step cutover.

A booth case has five steps: diagnosis, first tests, management, reassessment (the case moves on: a response to treatment or a complication), and disposition. Each step's option bank is keyed on the tier of the step before it only, 1 + 3 + 3 + 3 + 3 = 13 banks per case, where keying on the full path would need 121. For a tapped answer, the reply comes from the case's reply bank: replies written offline per (bank, variant, chosen option, language), each passing the AI safety review, shown at once; the server picks the next question variant and a one-per-tier trio from the bank at random. The live AI runs only for typed answers, sorted under the sort memo, with an optional semantic reply cache (embeddings made locally in rimpl from the de-identified text; reuse only at cosine ≥ 0.95 on the same case version, bank and path; never across a negation or stop word, never for an answer sorted "weaker" or a reply with a safety line; switched on only after a labelled pair set shows zero unsafe reuses). We chose this because the owner asked for five steps (#357) and faster replies (#356): a live reply took p50 5.4 s, p95 7.8 s in the sandbox, before the network hops.

## Considered options

- **Banks keyed on the last two tiers** (31 per case) or **on a running track** (13 per case): more memory of the play, at 2.4 times the authoring, or with a track that hides which step went wrong.
- **A live exact cache of AI replies**: no offline work, but nothing is reviewed and the first visitor on each key still waits.
- **Streaming the live reply, or a faster model**: kept for typed answers if the measured reply p95 needs them.

## Consequences

- A bank cannot react to an answer two or more steps back, and a reply to a tapped answer cannot refer to earlier steps.
- The AI no longer chooses the next question after a tapped answer. Every reply a tapper sees has been reviewed, which no live reply was.
- The board ranks only five-step plays from the cutover on.
