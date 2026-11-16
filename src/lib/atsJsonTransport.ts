import { safeExternalFetch } from './safeExternalFetch';

type JsonTransportDependencies = {
  fetch: typeof fetch;
  safeExternalFetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
};

const transports: JsonTransportDependencies = {
  fetch: (input, init) => fetch(input, init),
  safeExternalFetch: (input, init) => safeExternalFetch(input, init),
};

/** Use the existing bounded native HTTP transport for Workday JSON, matching
 * the public-posting recovery path. A response is returned exactly once;
 * callers still own status validation, provider limits and cooldowns. */
export function fetchAtsJson(
  platform: string,
  url: string,
  init: RequestInit,
  dependencies: JsonTransportDependencies = transports,
): Promise<Response> {
  return platform === 'workday'
    ? dependencies.safeExternalFetch(url, init)
    : dependencies.fetch(url, init);
}
