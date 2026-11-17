'use client';

import { useEffect, useRef, useState } from 'react';
import { startClientPolling } from '@/lib/clientPolling';
import { useDashboardRefresh } from '@/lib/useDashboardRefresh';
import { atsRetryLabel, type AtsQueueSnapshot } from '@/lib/atsQueueSnapshot';

const count = (value: number) => value.toLocaleString('en-US');

export function AtsQueuePanel({ snapshot, unavailable = false }: {
  snapshot?: AtsQueueSnapshot | null; unavailable?: boolean;
}) {
  const [stage, setStage] = useState('All stages');
  const visibleHolds = snapshot?.holds.filter(hold => stage === 'All stages' || hold.stage === stage) || [];
  if (!snapshot) return <section className="ats-queue-panel" aria-label="ATS queues"><p role="status">{unavailable ? 'ATS queue details are temporarily unavailable. Refreshing automatically.' : 'Loading ATS queue details…'}</p></section>;
  const retryHolds = snapshot.holds.filter(hold => hold.retryAt);
  const earliest = retryHolds.map(hold => hold.retryAt!).sort()[0] || null;
  return (
    <details className="ats-queue-panel" aria-label="ATS queues" open>
      <summary className="ats-queue-heading">
        <strong>New boards &amp; held work</strong>
      </summary>
      <dl className="ats-queue-metrics">
        <div><dt>Ready for validation</dt><dd>{count(snapshot.validationDue)}</dd></div>
        <div><dt>Validation retry holds</dt><dd>{count(snapshot.validationHeld)}</dd></div>
        <div><dt>Size review required</dt><dd>{count(snapshot.sizeReview)}</dd></div>
        <div><dt>First-collection queue</dt><dd>{count(snapshot.ready)}</dd></div>
        <div><dt>Awaiting handoff</dt><dd>{count(snapshot.awaitingHandoff)}</dd></div>
        <div><dt>Unfinished collections</dt><dd>{count(snapshot.collecting)}</dd></div>
      </dl>
      {snapshot.capacity && <details className="ats-queue-holds">
        <summary>Capacity and actual work</summary>
        <dl className="ats-queue-metrics">
          <div><dt>New collections ready</dt><dd>{count(snapshot.capacity.newCollectionsReady)}</dd></div>
          <div><dt>Saved listing turns ready</dt><dd>{count(snapshot.capacity.listingTurnsReady)}</dd></div>
          <div><dt>Processing turns ready</dt><dd>{count(snapshot.capacity.processingTurnsReady)}</dd></div>
          <div><dt>Batches being worked</dt><dd>{count(snapshot.capacity.workingBatches)}</dd></div>
          <div><dt>Persistence charged to capacity</dt><dd>{count(snapshot.capacity.persistenceCapacityJobs)} jobs</dd></div>
          <div><dt>Public collection reservations</dt><dd>{count(snapshot.capacity.publicReservedJobs)} jobs</dd></div>
        </dl>
        <p className="ats-queue-help">{({
          idle: 'No acquisition work is eligible at this observation.',
          draining: 'Processing demand is using reserved capacity while saved listings keep a bounded opportunity.',
          staging_blocked: 'Retained collection volume is holding new intake while saved work finishes.',
          cohort_balanced: 'Older unfinished listings limit intake; the current cohort retains its bounded allowance.',
          finishing_listings: 'New intake is waiting for unfinished listings to release capacity.',
          coverage_idle_loan: 'Saved work can borrow unused new-collection capacity.',
          continuation_idle_loan: 'New collections can borrow unused processing capacity.',
          coverage_target_remaining: 'Eligible new collections and saved work are sharing capacity.',
          coverage_goal_met: 'The contact target is met; eligible work continues using spare capacity.',
        } as Record<string, string>)[snapshot.capacity.policyReason] || 'Eligible work is sharing the available collection capacity.'}</p>
        <p className="ats-queue-help">Ready counts exclude future retries and live claims. Retained postings remain visible in the hold details. A worker capacity lease does not mean that worker is processing a batch.</p>
        {snapshot.capacity.resources.length > 0 && <div className="ats-queue-table-scroll"><table className="ats-queue-table">
          <thead><tr><th>Work pool</th><th>Queue</th><th>Recorded service minutes</th><th>Turns</th><th>Last opportunity</th></tr></thead>
          <tbody>{snapshot.capacity.resources.flatMap(resource => resource.classes.map(c => <tr key={`${resource.resource}:${c.key}`}>
            <td>{({ 'api-coverage': 'API new collections', 'api-listing': 'API saved listings', 'api-drain': 'API processing',
              'public-browser': 'Public browser', 'public-http-adp': 'ADP over HTTP', 'public-http-shared': 'Other public HTTP' } as Record<string, string>)[resource.resource] || 'Other collection'}</td>
            <td>{({ first: 'First collections', current: 'Current cohort', overdue: 'Older active work', recovery: 'Recovery',
              refresh: 'Refresh', continuation: 'Saved progress', retry: 'Retry' } as Record<string, string>)[c.key] || c.key}</td>
            <td>{(c.serviceMs / 60000).toLocaleString('en-US', { maximumFractionDigits: 1 })}</td><td>{count(c.turns)}</td>
            <td>{c.lastSelectedAt ? new Date(c.lastSelectedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not served yet'}</td>
          </tr>))}</tbody>
        </table></div>}
      </details>}
      <details className="ats-queue-holds">
        <summary>
          <span>Hold &amp; retry details · {count(snapshot.holds.length)} groups</span>
          <span className="ats-queue-next-retry">{earliest ? <>Retry eligibility: {atsRetryLabel(earliest, snapshot.observedAt)}</> : 'No timed retry holds'}</span>
        </summary>
        <p className="ats-queue-help">{snapshot.admissionNote}</p>
        <div className="ats-queue-persistence">
          <span>Normalization &amp; persistence: <strong>{count(snapshot.persistenceDue)} runnable items</strong> · <strong>{count(snapshot.persistenceHeld)} held items</strong></span>
        </div>
        <p className="ats-queue-help">Each row counts its own stage; do not add these counts together. Validation due and Acquisition due retain failures after their retry time passes. Times are Central and show earliest eligibility, not a promised attempt. Due work also waits for worker and intake capacity and admission policy. Acquisition handoff is checked every five minutes.</p>
        <label className="ats-queue-filter">Show stage
          <select value={stage} onChange={event => setStage(event.target.value)}>
            {['All stages', 'First collection', 'Validation due', 'Validation', 'Size review', 'Persistence', 'Acquisition due', 'Acquisition', 'Provider', 'Common Crawl'].map(value => <option key={value}>{value}</option>)}
          </select>
        </label>
        {visibleHolds.length === 0 ? <p>No held work in this view.</p> : (
          <div className="ats-queue-table-scroll">
            <table className="ats-queue-table">
              <thead><tr><th>Stage / provider</th><th>Work awaiting retry</th><th>Reason</th><th>Earliest eligibility</th></tr></thead>
              <tbody>{visibleHolds.map((hold, index) => (
                <tr key={`${hold.stage}:${hold.provider}:${index}`}>
                  <td><strong>{hold.stage}</strong><br />{hold.provider}</td>
                  <td>{count(hold.count)} {hold.unit}{hold.items > 0 && <><br /><span>{count(hold.items)} remaining items</span></>}</td>
                  <td>{hold.reason}{hold.example && <details className="ats-queue-example"><summary>Example board or source</summary><span>{hold.example}</span></details>}</td>
                  <td>{hold.stage === 'First collection' && !hold.retryAt && hold.reason.startsWith('Awaiting automatic')
                    ? 'Next handoff check · within five minutes'
                    : atsRetryLabel(hold.retryAt, snapshot.observedAt, hold.stage === 'Size review' || /review required/i.test(hold.reason))}
                    {hold.lastRetryAt && hold.lastRetryAt !== hold.retryAt && <small>Other retries through {atsRetryLabel(hold.lastRetryAt, snapshot.observedAt)}</small>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="ats-queue-observed">Observed {new Date(snapshot.observedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })} Central</p>
      </details>
      {unavailable && <p className="ats-queue-observed" role="status">Refresh unavailable · showing last observed counts</p>}
    </details>
  );
}

/** Queue diagnostics poll independently so heavy reads cannot delay pipeline
 * controls, the health endpoint or the existing three-second status refresh. */
export function LiveAtsQueuePanel() {
  const [snapshot, setSnapshot] = useState<AtsQueueSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const refreshRef = useRef<(() => void) | null>(null);
  useDashboardRefresh(() => refreshRef.current?.());
  useEffect(() => {
    const polling = startClientPolling({
      request: async signal => {
        const response = await fetch('/api/pipeline/ats-queues', { signal });
        if (!response.ok) throw new Error('Queue diagnostics unavailable');
        return await response.json() as AtsQueueSnapshot;
      },
      onData: data => { setSnapshot(data); setUnavailable(false); },
      onError: () => setUnavailable(true),
      intervalMs: () => document.hidden ? 60000 : 15000,
    });
    refreshRef.current = polling.refresh;
    return () => { polling.stop(); refreshRef.current = null; };
  }, []);
  return <AtsQueuePanel snapshot={snapshot} unavailable={unavailable} />;
}
