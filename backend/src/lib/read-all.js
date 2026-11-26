// PostgREST answers at most 1000 rows a request, so a longer read would be cut short silently.
const PAGE = 1000;

/** Every row of an ordered query, read PAGE rows a request. null when a read fails, after `onFail` is told why.
 *  `query` builds a fresh query each call, ordered on a key that makes the pages disjoint. */
async function readAll(query, onFail = () => {}) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1);
    if (error || !Array.isArray(data)) {
      onFail(error?.message ?? 'not a list');
      return null;
    }
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

module.exports = { readAll, PAGE };
