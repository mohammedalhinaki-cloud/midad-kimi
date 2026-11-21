/** True only when the signed-in identity changes, not when that session refreshes. */
export function hasAuthIdentityChanged(previousUserId, nextUserId) {
  return (previousUserId ?? null) !== (nextUserId ?? null);
}
