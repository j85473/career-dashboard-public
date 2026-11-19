import { scrapeAtsApi, scrapeJobPostingMetadata, type AtsScrapeResult } from './atsApi';
import { isSpecificPostingUrl, verifiedEmployerLocation } from './atsDirectMatch';
import { isScorableJobDescription, isClosedJobPosting } from './jobDescriptionQuality';
import { completePostingMetadata, postingMetadataValue } from './postingMetadata';
import { urlMatchesAnyHost } from './urlHost';
import { cleanHtmlText } from './jobIngestion';

/** An Apply URL can still point to a reprint, redirect service, or board. */
export function canonicalEmployerPostingUrl(url: string | null | undefined): string | null {
  if (!isSpecificPostingUrl(url) || urlMatchesAnyHost(url, [
    'adzuna.com', 'appcast.io', 'careerforce.mn.gov', 'dejobs.org', 'dice.com',
    'glassdoor.com', 'himalayas.app', 'indeed.com', 'jobsyn.org', 'linkedin.com',
    'jsearch.p.rapidapi.com', 'remoteok.com', 'themuse.com', 'weworkremotely.com',
    'ziprecruiter.com',
  ])) return null;
  return url;
}

async function readEmployerDetails(url: string): Promise<AtsScrapeResult | null> {
  const posting = await scrapeAtsApi(url, { requireSameUrl: true });
  if (posting?.location || posting?.postingVerificationError || posting?.platform === 'dejobs') return posting;
  return completePostingMetadata(posting, () => scrapeJobPostingMetadata(url, { requireSameUrl: true }));
}

export async function readCanonicalPosting(
  url: string | null,
  read: (url: string) => Promise<AtsScrapeResult | null> = readEmployerDetails,
): Promise<AtsScrapeResult | null> {
  if (!url) return null;
  const posting = await read(url).catch(() => null);
  if (!posting || posting.platform === 'dejobs') return null;
  if (posting.postingVerificationError) {
    return { text: '', ats: posting.ats, postingVerificationError: posting.postingVerificationError };
  }
  return {
    ...posting,
    title: postingMetadataValue(posting.title),
    company: postingMetadataValue(posting.company),
    location: verifiedEmployerLocation(posting.location),
  };
}

/** A usable employer copy wins even when a reprint has more text. */
export function canonicalPostingDescription(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const body = cleanHtmlText(text);
  return isClosedJobPosting(body) || isScorableJobDescription(body, { structuredSource: true })
    ? body : undefined;
}
