// The /admin/ai-readiness `model_lock` body for a lock the backend could not compare, as
// backend/src/services/model-lock.js modelLockCheck builds it. Shared by AiReadinessPage.test.tsx (which
// renders it) and backend-mirrors.test.ts (which pins it to the backend), so a new reason of this kind
// fails the pin until the readiness test renders it too. Not a test file: jest's testMatch is *.test.*.
//
// modelLockCheck returns these four from its `out` object, BEFORE it reads the live manifest. Nothing was
// compared, yet `match` is FALSE, not null, and `live_evaluator_sha256` is null. A fixture that sent
// `match: null` here is how a false "evaluator MISMATCH" went unseen.
export const NULL_DIGEST_REASONS = [
  'lock_record_unmigrated', 'lock_record_unreadable', 'lock_not_bound_to_manifest', 'live_manifest_unknown',
] as const;
export type NullDigestReason = (typeof NULL_DIGEST_REASONS)[number];

export function nullDigestLock(reason: NullDigestReason, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'down', locked: true, locked_at: '2026-10-14T03:00:00.000Z', provider: 'local',
    manifest_sha256: 'ab'.repeat(32),
    // A lock taken before binding has no frozen evaluator digest; the others have one.
    evaluator_sha256: reason === 'lock_not_bound_to_manifest' ? null : 'e'.repeat(64),
    // rimpl's own /health/deep sha: known even when the live manifest was never fetched.
    live_sha256: 'cd'.repeat(32),
    live_evaluator_sha256: null,
    match: false,
    reason,
    ...(reason === 'live_manifest_unknown' ? { live_manifest: 'unreachable' } : {}),
    ...over,
  };
}
