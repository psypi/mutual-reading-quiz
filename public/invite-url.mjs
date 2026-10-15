export function buildInviteUrl(origin, roomId, inviteToken) {
  const url = new URL('/', origin);
  url.hash = new URLSearchParams({room: roomId, token: inviteToken}).toString();
  return url.href;
}
