/** Read-only SQL fixtures; the CTEs shadow both production tables.
 * node --import tsx tests/integration/statsScoringScope.ts | psql -X -v ON_ERROR_STOP=1
 */
import { currentScoreScope } from '../../src/lib/statsScoringScope';

type Event = {
  id: string; jobId: string; createdAt: string; evaluationType: string;
  staleAt: string | null; schemaVersion: string; aimFactualExtractionId: string;
  inputBindings: Record<string, string>; passed: boolean; semanticResultHash: string;
  sourceAimEventId: string | null; aimFitScore: number | null; experienceFitScore: number | null;
};

const events: Event[] = [];
const jobs = ['valid', 'stale', 'source', 'extraction', 'semantic', 'schema', 'tie', 'failed-aim', 'stale-aim', 'stale-extraction'];
for (const jobId of jobs) {
  const aim: Event = {
    id: `aim-${jobId}`, jobId, createdAt: '2026-11-01', evaluationType: 'aim_fit',
    staleAt: null, schemaVersion: 'career-dashboard-aim-result-v2',
    aimFactualExtractionId: `ex-${jobId}`, inputBindings: { globalInputVersionsHash: 'fixture' },
    passed: jobId !== 'failed-aim', semanticResultHash: `semantic-${jobId}`,
    sourceAimEventId: null, aimFitScore: 80, experienceFitScore: null,
  };
  events.push(aim);
  const experience: Event = {
    ...aim, id: `experience-${jobId}-a`, evaluationType: 'experience_fit',
    schemaVersion: 'career-dashboard-experience-result-v2', sourceAimEventId: aim.id,
    inputBindings: { aimSemanticResultHash: aim.semanticResultHash },
    experienceFitScore: 75,
  };
  events.push(experience);
  if (['valid', 'stale', 'source', 'extraction', 'semantic', 'schema', 'tie'].includes(jobId)) {
    const newest = { ...experience, id: `experience-${jobId}-z`, createdAt: jobId === 'tie' ? experience.createdAt : '2026-11-02' };
    if (jobId === 'valid') newest.experienceFitScore = 90;
    if (jobId === 'stale' || jobId === 'tie') newest.staleAt = '2026-11-03';
    if (jobId === 'source') newest.sourceAimEventId = 'older-aim';
    if (jobId === 'extraction') newest.aimFactualExtractionId = 'older-extraction';
    if (jobId === 'semantic') newest.inputBindings = { aimSemanticResultHash: 'older-semantic-result' };
    if (jobId === 'schema') newest.schemaVersion = 'retired-schema';
    events.push(newest);
  }
  if (jobId === 'stale-aim') events.push({ ...aim, id: 'aim-stale-newest', createdAt: '2026-11-02', staleAt: '2026-11-03' });
}

function literal(value: unknown, type: string): string {
  if (value === null) return `NULL::${type}`;
  if (typeof value === 'boolean' || typeof value === 'number') return `${value}::${type}`;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `'${text.replaceAll("'", "''")}'::${type}`;
}
const types: Record<keyof Event, string> = {
  id: 'text', jobId: 'text', createdAt: 'timestamp', evaluationType: 'text', staleAt: 'timestamp',
  schemaVersion: 'text', aimFactualExtractionId: 'text', inputBindings: 'jsonb', passed: 'boolean',
  semanticResultHash: 'text', sourceAimEventId: 'text', aimFitScore: 'int', experienceFitScore: 'int',
};
const columns = Object.keys(types) as Array<keyof Event>;
const scope = currentScoreScope({ aimInputVersionsHash: 'fixture', experienceInputVersionsHash: 'provenance-only' });
const rendered = scope.text.replace(/\$(\d+)/g, (_, ordinal) => literal(scope.values[Number(ordinal) - 1], 'text'));
console.log(`BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
WITH "JobScoreEvent" (${columns.map(column => `"${column}"`).join(',')}) AS (
  VALUES ${events.map(event => `(${columns.map(column => literal(event[column], types[column])).join(',')})`).join(',\n')}
), "AimFactualExtraction" (id, "staleAt") AS (
  VALUES ${jobs.map(job => `(${literal(`ex-${job}`, 'text')}, ${literal(job === 'stale-extraction' ? '2026-11-03' : null, 'timestamp')})`).join(',\n')}
), ${rendered}
SELECT 'latest scores and bindings preserved' AS fixture,
  1 / ((SELECT array_agg(id ORDER BY id) FROM current_experience) IS NOT DISTINCT FROM ARRAY['experience-valid-z']::text[])::int AS experience_passed,
  1 / ((SELECT "experienceFitScore" FROM current_experience) IS NOT DISTINCT FROM 90)::int AS score_passed,
  1 / ((SELECT COUNT(*) FROM current_aim) = 8)::int AS aim_passed;
ROLLBACK;`);
