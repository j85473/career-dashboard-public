import { PLATFORMS } from '../scripts/discoverATS';
import { FUTURE_ATS_DISCOVERY_PATTERNS, futureAtsCandidateUrl, type FutureAtsPlatform } from './atsDiscoveryBacklog';
export { FUTURE_ATS_DISCOVERY_PATTERNS, futureAtsCandidateUrl } from './atsDiscoveryBacklog';

const futureAdapters = Object.fromEntries(Object.entries(FUTURE_ATS_DISCOVERY_PATTERNS).map(([platform, patterns]) => [platform, {
  cc_pattern: [...patterns],
  extract_slug: (url: string) => futureAtsCandidateUrl(platform as FutureAtsPlatform, url),
}])) as Record<FutureAtsPlatform, { cc_pattern: string[]; extract_slug: (url: string) => string | null }>;

/** Existing collector entries take precedence when an integration is added. */
export const ATS_DISCOVERY_PLATFORMS = { ...futureAdapters, ...PLATFORMS };
export const isDiscoveryOnlyAtsPlatform = (platform: string): boolean =>
  Object.hasOwn(futureAdapters, platform) && !Object.hasOwn(PLATFORMS, platform);
export const discoveryCandidateStatus = (platform: string): 'pending' | 'awaiting_adapter' =>
  isDiscoveryOnlyAtsPlatform(platform) ? 'awaiting_adapter' : 'pending';
