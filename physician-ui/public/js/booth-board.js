// Booth Mode board (#212 finishes this file and css/booth-board.css). #210 ships the two seams booth-play.js
// already calls, so #212 never edits the play:
//   renderTag(tag)                              the tag on the result card; #212 adds the deterministic icon here
//   mountResultBoard(slot, { tag, scoreBody })  fills the result card's board slot; scoreBody is the score
//                                               response as received, where #212 adds the ranks
import { tagText } from './booth-copy.js';

/** @param {number} tag @returns {HTMLElement} */
export function renderTag(tag) {
  const el = document.createElement('p');
  el.className = 'booth-tag';
  el.textContent = tagText(tag);
  return el;
}

export function mountResultBoard(_slot, _ctx) {}
