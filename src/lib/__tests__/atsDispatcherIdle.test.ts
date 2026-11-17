import assert from 'node:assert/strict';
import test from 'node:test';
import { runAtsV2ContinuousDispatcher, type AtsV2LanePlan } from '../atsAcquisitionDispatcherV2';

type Dependencies = NonNullable<Parameters<typeof runAtsV2ContinuousDispatcher>[1]>;
const emptyPlan: AtsV2LanePlan = { totalSlots: 8, coverageSlots: 0, continuationSlots: 0,
  requiredByNow: 0, coverageDebt: 0, projectedContacts: null, reason: 'idle',
  coverageEligible: 0, continuationEligible: 0 };

function fixture() {
  const controller = new AbortController();
  let clock = 0, plans = 0, claims = 0, pauses = 0;
  let plan = emptyPlan;
  const dependencies: Dependencies = {
    monotonicNow: () => clock,
    reconcileExpiredAtsV2Work: async () => ({ batchClaims: 0, itemClaims: 0, segmentClaims: 0, workReceipts: 0, finalizedBatches: 0 }),
    repairStaggeredAtsRotationSchedule: async () => ({ repaired: 0, startsAt: new Date(), endsAt: new Date() }),
    readAtsListingPauses: async () => { pauses++; return []; },
    claimNextAtsV2Coverage: async () => { claims++; controller.abort(); return null; },
    claimNextAtsV2Continuation: async () => { claims++; controller.abort(); return null; },
    runAtsV2Claim: async () => { throw new Error('No fixture work claim'); },
    wait: async () => { controller.abort(); },
  };
  return { controller, dependencies,
    setPlan(value: AtsV2LanePlan) { plan = value; }, advance(ms: number) { clock += ms; },
    get plans() { return plans; }, get claims() { return claims; }, get pauses() { return pauses; },
    run(totalSlots = 8) { return runAtsV2ContinuousDispatcher({ signal: controller.signal,
      totalSlots, shouldDrain: () => false, plan: async () => { plans++; return plan; },
      onError: ({ error }) => { throw error; } }, dependencies); },
  };
}

test('eight idle lanes share one plan and do not perform candidate or pause scans', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.plans, 1);
  assert.equal(f.claims, 0);
  assert.equal(f.pauses, 0);
});

test('a retry becoming due wakes selection after the bounded shared-plan refresh', async () => {
  const f = fixture();
  let waits = 0;
  f.dependencies.wait = async (_signal, ms) => {
    if (f.controller.signal.aborted) return;
    assert.equal(ms, 1000);
    waits++;
    f.advance(ms);
    f.setPlan({ ...emptyPlan, continuationSlots: 1, continuationEligible: 1 });
  };
  await f.run(1);
  assert.equal(waits, 1);
  assert.equal(f.plans, 2);
  assert.equal(f.claims, 1);
});

test('a restarted dispatcher does not inherit another session\'s empty plan', async () => {
  const first = fixture();
  await first.run(1);
  const restarted = fixture();
  restarted.setPlan({ ...emptyPlan, continuationSlots: 1, continuationEligible: 1 });
  await restarted.run(1);
  assert.equal(first.claims, 0);
  assert.equal(restarted.plans, 1);
  assert.equal(restarted.claims, 1);
});
