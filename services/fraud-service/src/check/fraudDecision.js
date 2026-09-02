/**
 * The answer: may this trade be filled.
 *
 * `decision` is what the caller acts on; `reasons` is prose a human reads (empty on an
 * allow); `codes` is the same objections as stable machine-readable tokens, in the same
 * order. A denial always carries at least one reason.
 */
function allow(checkId, at) {
  return { decision: 'ALLOW', reasons: [], codes: [], checkId, evaluatedAt: new Date(at).toISOString() };
}

function deny(reasons, codes, checkId, at) {
  if (reasons.length === 0) throw new Error('a denial must carry at least one reason');
  if (reasons.length !== codes.length) {
    throw new Error(`every reason needs its code: ${reasons.length} reasons, ${codes.length} codes`);
  }
  return { decision: 'DENY', reasons, codes, checkId, evaluatedAt: new Date(at).toISOString() };
}

module.exports = { allow, deny };
