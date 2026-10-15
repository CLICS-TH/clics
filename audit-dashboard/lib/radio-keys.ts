// Arrow-key navigation for a radiogroup, plus the roving tab stop that goes with it.
//
// A group announced as a radiogroup is operated with arrows, not Tab — that is what the role
// promises. A screen-reader user who hears "radio group" presses an arrow key; if nothing happens,
// the control is broken for them. Shared by DomainScorer (score + anchor-clarity chips) and the
// overview's minimum-auditors group, so every radiogroup in the dashboard behaves the same way.
//
// Attach the returned handler to the radiogroup element. Pair it with a roving tabIndex on the
// options: 0 on the checked option (or the first when none is checked), -1 on the rest.
import type { KeyboardEvent } from 'react';

export function radioKeys<T>(values: readonly T[], current: T | null | undefined, pick: (v: T) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = values.findIndex((v) => v === current);
    // No selection yet: an arrow enters the group at the first option rather than doing nothing.
    const next = at < 0 ? 0 : (at + step + values.length) % values.length;
    pick(values[next]);
    // Focus follows the selection, or the visible ring stays on the option just left behind.
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
}
