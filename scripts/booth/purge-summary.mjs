/*
 * Pure: formats the summary booth_event_summary() returns (db/migration-booth-purge.sql) into the counts report
 * scripts/booth/purge-event.mjs prints for CCME. The math lives in SQL, next to the rows it describes.
 * Aggregates only: no id, tag or per-play row ever reaches the output.
 */
export const SAFE_EVENT_CODE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
const DOMAIN_KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const SPREAD_KEYS = ['min', 'p25', 'median', 'p75', 'max', 'mean', 'sd'];
const BANGKOK_OFFSET_MS = 7 * 3_600_000;

const round1 = (x) => (x == null ? null : Math.round(Number(x) * 10) / 10);

export function bangkokTime(iso) {
  if (!iso) return null;
  return `${new Date(Date.parse(iso) + BANGKOK_OFFSET_MS).toISOString().slice(0, 19)}+07:00`;
}

/**
 * @param {string} code
 * @param {{ plays: number, scored: number, unavailable: number, abandoned: number, started: number, ranked: number,
 *   spend_usd: number, first_play_at: string|null, last_play_at: string|null,
 *   spread: Record<string, number|null>, domain_mean: Record<string, number|null> }} s
 */
export function report(code, s) {
  const v = (x) => (x == null ? '-' : String(x));
  const spread = SPREAD_KEYS.map((k) => `${k === 'sd' ? 'SD' : k} ${v(round1(s.spread[k]))}`).join('  ');
  return [
    `Booth event ${code}`,
    `plays ${s.plays}  scored ${s.scored}  unavailable ${s.unavailable}  abandoned ${s.abandoned}  started ${s.started}`,
    `ranked scored ${s.ranked}`,
    `total spend USD ${Number(s.spend_usd).toFixed(2)}`,
    `first play ${v(bangkokTime(s.first_play_at))}  last play ${v(bangkokTime(s.last_play_at))}`,
    `score spread (scored composites, 0-100): ${spread}`,
    `domain mean (0-5): ${DOMAIN_KEYS.map((k) => `${k} ${v(round1(s.domain_mean[k]))}`).join('  ')}`,
  ].join('\n');
}

/** The command the operator runs next. Every one runs from backend/, where the runbook leaves them. */
export const command = (code, flags = '') => `node ../scripts/booth/purge-event.mjs --event ${code}${flags ? ` ${flags}` : ''}`;

/**
 * Pure: what one run of purge-event.mjs ends with. `ccme` is the one block to send CCME, or null with `none` saying
 * why there is none yet; `next` is the exact next step. `outcome` is what the run observed:
 *   { kind: 'deleted', summary }                     a --delete that committed (summary.recorded: the latest earlier purge)
 *   { kind: 'read', summary, attempt }               a dry run; `attempt` is the --attempt id it was given, if any
 *   { kind: 'refused' } · { kind: 'missing' }        BP409 · the purge migration is not applied
 *   { kind: 'failed', del, attempt }                 the call failed; with del, `attempt` is the delete's id
 */
export function plan(code, outcome) {
  const deleteCmd = `\`${command(code, '--delete')}\``;
  const at = (rec) => bangkokTime(rec.purged_at);
  switch (outcome.kind) {
    case 'refused':
      return { ccme: null, none: 'none yet (nothing was deleted)',
        next: `Switch the booth off on the superadmin overview (tap the Booth Mode switch), then run ${deleteCmd}.` };
    case 'missing':
      return { ccme: null, none: 'none yet (nothing was deleted)',
        next: `Ask the owner to apply db/migration-booth-purge.sql, then run \`${command(code)}\`.` };
    case 'failed':
      return outcome.del
        ? { ccme: null, none: 'unknown yet (the delete may or may not have committed)',
          next: `Run \`${command(code, `--attempt ${outcome.attempt}`)}\`. It deletes nothing and says whether this delete committed.` }
        : { ccme: null, none: 'none yet (nothing was deleted)',
          next: `Run the same command again: \`${command(code, outcome.attempt ? `--attempt ${outcome.attempt}` : '')}\`.` };
    case 'deleted': {
      const { summary } = outcome;
      if (summary.plays > 0) {
        return { ccme: { title: `the ${summary.plays} plays deleted now`, summary },
          next: 'Done. Send the CCME summary block above to CCME. Nothing else to run.' };
      }
      if (summary.recorded) {
        return { ccme: { title: `recorded when ${code} was purged at ${at(summary.recorded)}`, summary: summary.recorded.summary },
          next: 'Done: nothing was left to delete. Send the CCME summary block above to CCME. Nothing else to run.' };
      }
      return { ccme: null, none: `none (${code} has no plays and no recorded purge)`, next: 'Nothing to do. Check the event code.' };
    }
    case 'read': {
      const { summary, attempt } = outcome;
      const live = summary.plays;
      if (attempt && summary.attempt) {
        const ccme = { title: `the delete of attempt ${attempt}, committed at ${at(summary.attempt)}`, summary: summary.attempt.summary };
        return live > 0
          ? { ccme, next: `The delete committed. Send the CCME summary block above to CCME. The ${live} live plays were started after it and are not in it: with the booth switched off, run ${deleteCmd} to purge them, and send the CCME summary it prints too.` }
          : { ccme, next: 'The delete committed. Send the CCME summary block above to CCME. Nothing else to run.' };
      }
      if (live > 0 && attempt) {
        return { ccme: null, none: 'none yet (that delete did not commit: nothing was deleted)',
          next: `Nothing was deleted. With the booth switched off, run ${deleteCmd} once more. It prints the CCME summary of what it deletes.` };
      }
      // ADR 0010: an event's plays are kept, so a plain read never advises the delete.
      if (live > 0) {
        return { ccme: null, none: `none (the ${live} live plays are kept)`,
          next: `Nothing to run: booth plays are kept (ADR 0010). Only for a test event or an owner-ordered removal, with the booth switched off, run ${deleteCmd}. It prints the CCME summary of what it deletes.` };
      }
      if (summary.recorded) {
        return { ccme: { title: `recorded when ${code} was purged at ${at(summary.recorded)}`, summary: summary.recorded.summary },
          next: `${attempt ? 'That delete did not commit, and nothing is left to delete. ' : 'Nothing to delete. '}Send the CCME summary block above to CCME if it was not sent then. Nothing else to run.` };
      }
      return { ccme: null, none: `none (${code} has no plays and no recorded purge)`, next: 'Nothing to do. Check the event code.' };
    }
    default:
      throw new Error(`unknown outcome ${outcome.kind}`);
  }
}

/** The two lines (and block) every run ends with. */
export function ending(code, p) {
  const head = p.ccme ? `== CCME summary (${p.ccme.title}) ==\n${report(code, p.ccme.summary)}` : `CCME summary: ${p.none}`;
  return `${head}\nNext step: ${p.next}`;
}
