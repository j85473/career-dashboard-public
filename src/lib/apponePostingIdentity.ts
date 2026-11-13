export function isAppOneHost(host: string): boolean {
  return host === 'appone.com' || host.endsWith('.appone.com');
}

/** R_ID identifies the opening; JID, PositionID and board IDs do not. */
export function appOnePostingIdentity(value: string): { id: string; descriptionUrl: string } | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || !isAppOneHost(url.hostname) || !/^\/(?:MainInfoReq|Main)\.asp$/i.test(url.pathname)) return null;
    const ids = [...url.searchParams].filter(([key]) => /^r_id$/i.test(key));
    if (ids.length !== 1 || !/^[1-9]\d*$/.test(ids[0][1])) return null;
    url.protocol = 'https:';
    url.pathname = '/MainInfoReq.asp';
    url.hash = '';
    url.searchParams.delete(ids[0][0]);
    url.searchParams.set('R_ID', ids[0][1]);
    return { id: ids[0][1], descriptionUrl: url.toString() };
  } catch { return null; }
}
