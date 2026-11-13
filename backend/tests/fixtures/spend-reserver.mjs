// One process of the spend ledger's contention test: once the start file exists, reserves `usd` against `cap` until
// refused, or `tries` times, then prints the ids it was granted.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [ledgerTool, startFile, usd, cap, tries] = process.argv.slice(2);
const { reserve } = await import(pathToFileURL(ledgerTool).href);
process.stdout.write('ready\n');
// A spin, not a timer: every process leaves the barrier within microseconds of the others, so they contend.
while (!existsSync(startFile));
const ids = [];
for (let i = 0; i < Number(tries); i += 1) {
  const id = reserve({ runId: `r${process.pid}`, build: 'TST', usd: Number(usd), cap: Number(cap) });
  if (!id) break;
  ids.push(id);
}
process.stdout.write(`${JSON.stringify(ids)}\n`);
