const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

/** Shared recruiting accounts can publish jobs for several subsidiaries.
 * Only explicit posting fields name the brand/legal employer; never infer it
 * from a mention in the job description or rename the entire recruiting board.
 */
export function smartRecruitersPostingCompany(value: unknown): string | null {
  const job = record(value);
  if (!job) return null;
  const fields = (Array.isArray(job.customField) ? job.customField : []).map(record).filter(field => field !== null);
  const uniqueField = (label: RegExp): string | null => {
    const values = [...new Set(fields.filter(field => label.test(text(field.fieldLabel)))
      .map(field => text(field.valueLabel)).filter(Boolean))];
    // Multiple selections are not one employer. Prefer the legal entity or
    // account name rather than arbitrarily choosing the first brand.
    return values.length === 1 && !/[;|\n]/.test(values[0]) ? values[0] : null;
  };
  return uniqueField(/^brands?$/i) || uniqueField(/^legal entity$/i)
    || text(record(job.company)?.name) || null;
}
