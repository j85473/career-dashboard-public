import { ATS_OPTIONS, identifyAts } from './atsUtils';

type DisplayJob = Parameters<typeof identifyAts>[0] & {
  canonicalUrl?: string | null;
  linkedinEasyApply?: boolean | null;
};

export const DISPLAY_ATS_OPTIONS = [...ATS_OPTIONS, 'LinkedIn', 'LinkedIn Easy Apply', 'JSearch', 'Himalayas', 'SerpAPI']
  .sort((a, b) => a === 'Unknown' ? 1 : b === 'Unknown' ? -1 : a.localeCompare(b));

function postingAts(job: DisplayJob): string {
  return identifyAts({ ...job, url: job.canonicalUrl?.trim() || job.url });
}

/** Feed labels are a fallback until the application link identifies an ATS.
 * The saved discovery source remains separate from the displayed ATS. */
export function sourceAtsLabel(job: DisplayJob): string | null {
  if ((job.canonicalUrl?.trim() || job.url) && postingAts(job) !== 'Unknown') return null;
  const source = job.source?.trim() || '';
  if (/^linkedin(?:\b|$)/i.test(source)) return job.linkedinEasyApply === true ? 'LinkedIn Easy Apply' : 'LinkedIn';
  if (/^jsearch(?:\b|$)/i.test(source)) return 'JSearch';
  if (/^himalayas(?:\b|$)/i.test(source)) return 'Himalayas';
  if (/^serpapi(?:\b|$)/i.test(source)) return 'SerpAPI';
  return null;
}

export function displayAts(job: DisplayJob): string {
  return sourceAtsLabel(job) || postingAts(job);
}

export function atsChoicesForJob(job: DisplayJob): readonly string[] {
  const label = sourceAtsLabel(job);
  return label?.startsWith('LinkedIn') ? ['LinkedIn', 'LinkedIn Easy Apply'] : label ? [label] : ATS_OPTIONS;
}

export function atsSelectionUpdate(job: DisplayJob, label: string) {
  return sourceAtsLabel(job)?.startsWith('LinkedIn')
    ? { linkedinEasyApply: label === 'LinkedIn Easy Apply' }
    : { manualAts: label };
}

/** Only explicit provider metadata establishes Easy Apply. A LinkedIn URL or
 * an absent external application URL is not evidence of an on-site form. */
export function readLinkedInEasyApply(row: Record<string, unknown>): boolean | null {
  for (const key of ['applyType', 'apply_type']) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    const kind = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (kind === 'EASY_APPLY') return true;
    if (kind === 'EXTERNAL') return false;
  }
  for (const key of ['easyApply', 'easy_apply', 'isEasyApply', 'is_easy_apply', 'linkedinEasyApply']) {
    const value = row[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(?:true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  }
  return null;
}
