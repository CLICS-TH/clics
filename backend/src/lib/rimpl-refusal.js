// A rimpl 422 'refused': the model's safeguards declined the request (claude-sonnet-5-5 declines in
// five categories with HTTP 200, `stop_reason: "refusal"`). services/rimpl-client.js rimplError()
// reads the body into `err.category` and `err.usage` ({ input_tokens, output_tokens, provider }).
//
// Deterministic: rimpl-client lists 422 in DETERMINISTIC_STATUSES, because the same request is
// declined again and every attempt is billed. Callers METER `err.usage` (the call was served and
// billed) and must never retry it on another model.
//
// Kept apart from rimpl-client.js so code that mocks the transport still gets the real predicate.
function isRimplRefusal(err) {
  return !!err && err.code === 'refused' && !!err.usage;
}

module.exports = { isRimplRefusal };
