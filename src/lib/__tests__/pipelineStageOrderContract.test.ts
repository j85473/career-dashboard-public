import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function source(...segments: string[]): string {
  return readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

const ingestion = source('src', 'lib', 'jobIngestion.ts');
const localScoring = source('src', 'lib', 'jobScoring.ts');
const jdRecovery = source('src', 'app', 'api', 'jobs', 'batch-jd-submit', 'route.ts');
const pipeline = source('src', 'lib', 'pipelineRunner.ts');
const extractionRoute = source('src', 'lib', 'pipelineManualRunners.ts');
const queues = source('src', 'lib', 'jobListQuery.ts');
const inboxVerification = source('src', 'lib', 'verifyJobsAlive.ts');

test('Inbox source expiry checks the employer copy and preserves score authority', () => {
  assert.match(inboxVerification, /await resolveCanonical\(job/);
  assert.match(inboxVerification, /employer\.liveness === 'alive'/);
  assert.match(inboxVerification, /employerLinkReplacementFields\(job, replacement\)/);
  assert.match(inboxVerification, /updatedAt: job\.updatedAt/);
  assert.match(inboxVerification, /client\.\$transaction\(async tx => \{[\s\S]*?lockJobForEmployerLocationRepair\(tx, job\.id\)[\s\S]*?return persist\(tx\)/);
  assert.doesNotMatch(inboxVerification, /updateData\.(?:aimFitScore|reqFitScore|scoringStatus|description|jdClaimedAt|localClaimedAt)\s*=/);
});

test('the pipeline continuously supervises ingestion, local scoring, and JD recovery', () => {
  assert.match(pipeline, /superviseLoop\('Source Ingestion', runIngestionLoop\)/);
  assert.match(pipeline, /superviseLoop\('ATS Acquisition Process', runAtsAcquisitionProcess\)/);
  assert.match(pipeline, /runAtsAcquisitionWorkerProcess\(\{/);
  assert.match(pipeline, /superviseLoop\('ATS Batch Processing', runAtsBatchProcessingLoop\)/);
  assert.match(pipeline, /superviseLoop\('ATS Segment Publication', runAtsSegmentPublicationLoop\)/);
  assert.match(pipeline, /superviseLoop\('Local Scoring', runLocalScoringLoop\)/);
  assert.match(pipeline, /superviseLoop\('Cooldown Recovery', runCooldownRecoveryLoop\)/);
  assert.match(pipeline, /superviseLoop\('JD Extraction', runJDExtraction\)/);
  assert.match(pipeline, /await Promise\.allSettled\(\[/);
});

test('ingestion routes complete JDs to local scoring and incomplete JDs to recovery', () => {
  assert.match(ingestion, /const enrichedPostingClosed = isClosedJobPosting\(finalDescription\)/);
  assert.match(ingestion, /const needsJd = !enrichedPostingClosed && !isScorableJobDescription\(finalDescription, \{ structuredSource: true \}\)/);
  assert.match(
    ingestion,
    /scoringStatus: lifecycleProtectedSource[\s\S]*?: enrichedPostingClosed \|\| appliedRepeat \? 'skipped' : needsJd \? 'needs_jd' : 'queued'/,
  );
});

test('ingestion applies affirmative non-English information before description recovery', () => {
  const languageIndex = ingestion.indexOf('const availableLanguage = assessJobInfoLanguage({');
  const atsIndex = ingestion.indexOf('atsResult = await scrapeAtsApi(', languageIndex);
  const detailsIndex = ingestion.indexOf('const scraped = await tryFetchFullDescription({', languageIndex);

  assert.ok(languageIndex >= 0, 'ingestion language gate is missing');
  assert.ok(atsIndex > languageIndex, 'ATS enrichment must follow the language gate');
  assert.ok(detailsIndex > languageIndex, 'details recovery must follow the language gate');
  assert.match(ingestion, /&& !availableLanguage\.isAffirmativelyNonEnglish/);
});

test('confirmed closed postings expire unless the Manual Import lifecycle is protected', () => {
  assert.match(ingestion, /const machineInitialStatus = lifecycleProtectedSource[\s\S]*?: enrichedPostingClosed[\s\S]*?\? 'expired'/);
  assert.match(localScoring, /if \(closed\)[\s\S]*?buildClosedPostingUpdate\(\)/);
  assert.match(jdRecovery, /existingDecision\.kind === 'closed'[\s\S]*?buildClosedPostingUpdate\(\)/);
  assert.match(jdRecovery, /recoveryDecision\.kind === 'closed'[\s\S]*?buildClosedPostingUpdate\(\)/);
});

test('local scoring either withholds deterministically or hands eligible jobs to Aim', () => {
  assert.match(localScoring, /scoringStatus: 'queued'/);
  assert.match(localScoring, /scoringStatus: deterministicallyRejected \|\| postingClosedBeforeAim \? 'skipped' : 'scored'/);
  assert.match(localScoring, /currentJob\.source === 'Manual Import' \? currentJob\.status : 'dismissed'/);
});

test('local scoring checks the resolved JD for role exclusions before assigning a score', () => {
  const recoveryIndex = localScoring.indexOf('await resolveFullDescription(scoringJob)');
  const exclusionIndex = localScoring.indexOf('await filterNewIntakeRole(currentJob,', recoveryIndex);
  const scoringIndex = localScoring.indexOf('runLocalHeuristic(jobWithFullDesc,', exclusionIndex);
  assert.ok(recoveryIndex >= 0 && exclusionIndex > recoveryIndex && scoringIndex > exclusionIndex);
  assert.match(localScoring.slice(exclusionIndex, scoringIndex), /resolvedDescription: fullDesc/);
  assert.match(localScoring.slice(exclusionIndex, scoringIndex), /if \(recoveredExclusion\) \{[\s\S]*?continue;/);
});

test('unscored JSearch jobs are verified after local acceptance and before Aim eligibility', () => {
  const triageIndex = localScoring.indexOf('const deterministicallyRejected =');
  const verificationIndex = localScoring.indexOf('await verifyJSearchBeforeAim(', triageIndex);
  const aimEligibilityIndex = localScoring.indexOf("scoringStatus: deterministicallyRejected || postingClosedBeforeAim ? 'skipped' : 'scored'", verificationIndex);
  assert.ok(triageIndex >= 0, 'local triage decision is missing');
  assert.ok(verificationIndex > triageIndex, 'JSearch verification must follow local acceptance');
  assert.ok(aimEligibilityIndex > verificationIndex, 'Aim eligibility must follow JSearch verification');
  assert.match(localScoring, /currentJob\.source === 'JSearch'/);
  assert.match(localScoring, /currentJob\.aimFitScore === null && currentJob\.reqFitScore === null/);
  assert.match(localScoring, /verificationStatus: preAimVerification\.liveness/);
  assert.match(localScoring, /status: 'expired'/);
  assert.match(localScoring, /updatedAt: currentJob\.updatedAt,[\s\S]*?scoreEvents: \{ none: \{\} \}/);
});

test('new direct Workday jobs must pass the public page check before the Aim handoff', () => {
  const triageIndex = localScoring.indexOf('const deterministicallyRejected =');
  const verificationIndex = localScoring.indexOf('await verifyWorkdayBeforeAim(', triageIndex);
  const updateIndex = localScoring.indexOf('data: workdayDisposition ?', verificationIndex);
  const aimEligibilityIndex = localScoring.indexOf("scoringStatus: deterministicallyRejected || postingClosedBeforeAim ? 'skipped' : 'scored'", updateIndex);
  assert.ok(triageIndex >= 0 && verificationIndex > triageIndex);
  assert.ok(updateIndex > verificationIndex && aimEligibilityIndex > updateIndex);
  assert.match(localScoring, /!deterministicallyRejected && isUnscoredAutomatedJob\s*&& currentJob\.source === DIRECT_WORKDAY_SOURCE && currentJob\.status === 'pending_af'\s*&& !currentJob\.tailoringStaged/);
  assert.match(localScoring, /workdayVerification\.liveness !== 'alive'[\s\S]*?buildClosedPostingUpdate\(\)[\s\S]*?\{ scoringStatus: 'queued', batchJobId: null \}/);
  assert.equal(localScoring.match(/AND: \[workdayRetryWhere\]/g)?.length, 2);
});

test('local scoring applies affirmative non-English information before its JD resolver', () => {
  const languageIndex = localScoring.indexOf('const availableLanguage = assessJobInfoLanguage({');
  const resolveIndex = localScoring.indexOf('await resolveFullDescription(scoringJob)', languageIndex);

  assert.ok(languageIndex >= 0, 'local scoring language gate is missing');
  assert.ok(resolveIndex > languageIndex, 'local scoring JD resolution must follow the language gate');
  assert.match(localScoring, /availableLanguage\.isAffirmativelyNonEnglish && !lifecycleProtected/);
  assert.match(localScoring, /passReason: availableLanguage\.reason/);
});

test('successful JD recovery returns the same jobs to local scoring before Aim', () => {
  const queueUpdate = jdRecovery.indexOf("scoringStatus: 'queued'");
  const localRetry = jdRecovery.indexOf('await scoreJobs(undefined, request.signal, {');
  assert.ok(queueUpdate >= 0, 'JD recovery must return successful descriptions to queued');
  assert.ok(localRetry > queueUpdate, 'local scoring must run after JD recovery queues the jobs');
  assert.match(jdRecovery, /jobIds: claimedJobs\.map\(\(job\) => job\.id\)/);
  assert.doesNotMatch(extractionRoute, /Waiting for Jina/);
});

test('Aim only receives locally scored jobs and Experience only receives Aim-scored jobs', () => {
  assert.match(queues, /case 'aim_fit':[\s\S]*?scoringStatus: 'scored'/);
  assert.match(queues, /case 'aim_fit':[\s\S]*?aimFitScore: null/);
  assert.match(queues, /case 'experience_fit':[\s\S]*?aimFitScore: \{ not: null \}/);
  assert.match(queues, /case 'experience_fit':[\s\S]*?reqFitScore: null/);
});
