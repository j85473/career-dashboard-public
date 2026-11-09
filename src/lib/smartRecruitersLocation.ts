import { hasExplicitRemoteExclusion, hasResidencyRequirement, hasRegularPresenceRequirement } from './jobLocationPolicy';
import { US_STATE_LOCATION_PATTERN } from './postingLocation';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const countries = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
const cleanAddress = (value: unknown): string => text(value).split(',').map(part => part.trim()).filter(Boolean).join(', ');

/** The posting address is not a residence restriction when the ATS says remote.
 * Preserve the address alongside the work arrangement and country. This retains
 * the posting for JD eligibility review; it does not establish worldwide access
 * or override explicit residency/office requirements.
 */
export function smartRecruitersLocation(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return text(value) || null;
  const location = value as Record<string, unknown>;
  const code = text(location.country);
  const country = /^[a-z]{2}$/i.test(code) ? countries.of(code.toUpperCase()) || code : code;
  const fullLocation = cleanAddress(location.fullLocation);
  const arrangementOnly = /^(?:remote|virtual|home[- ]based)$/i.test(fullLocation);
  const address = fullLocation && !arrangementOnly ? fullLocation
    : [fullLocation || text(location.city), text(location.region), country].filter(Boolean).join(', ');
  if (location.hybrid === true) return address ? `Hybrid - ${address}` : 'Hybrid';
  if (location.remote !== true) return address || null;
  // Authored restrictions remain attached to the remote location. A city by
  // itself is only the posting address; "Ohio only" is an actual restriction.
  const restricted = hasResidencyRequirement(address) || hasRegularPresenceRequirement(address)
    || hasExplicitRemoteExclusion(address) || /\b(?:only|residents?|restricted|eligible states?|except|excluding|within \d+)\b/i.test(address)
    || new RegExp(`^(?:Remote\\s*[-,]?\\s*)?${US_STATE_LOCATION_PATTERN}(?:,?\\s*(?:US|USA|United States))?(?:\\s*\\(Remote\\))?$`, 'i').test(address);
  if (restricted) return `Remote - ${address}`;
  const remote = country ? `Remote - ${country}` : 'Remote';
  // "Remote" is a work arrangement, never a second eligible location that
  // can bypass the country attached to the same posting.
  if (/^(?:remote|virtual|home[- ]based)$/i.test(address)) return remote;
  return address && address !== country ? `${remote}; ${address}` : remote;
}

/** An authored candidate-location field limits eligibility even when the
 * office address or remote flag is broader. Other custom fields (department,
 * sales territory, brands, etc.) are not evidence of where applicants may live.
 */
export function smartRecruitersPostingLocation(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const job = value as Record<string, unknown>;
  const location = job.location && typeof job.location === 'object' && !Array.isArray(job.location)
    ? job.location as Record<string, unknown> : {};
  const candidates = (Array.isArray(job.customField) ? job.customField : [])
    .filter((field): field is Record<string, unknown> => !!field && typeof field === 'object' && !Array.isArray(field))
    .filter(field => /^candidate\s+location$/i.test(text(field.fieldLabel)))
    .map(field => cleanAddress(field.valueLabel)).filter(Boolean);
  if (!candidates.length) return smartRecruitersLocation(job.location);
  const remote = location.remote === true || /^remote$/i.test(text(location.city));
  return [...new Set(candidates)].map(candidate => smartRecruitersLocation({
    fullLocation: candidate,
    country: candidate,
    remote,
    hybrid: location.hybrid,
  })).filter(Boolean).join('; ');
}
