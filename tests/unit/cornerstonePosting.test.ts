import assert from 'node:assert/strict';
import test from 'node:test';
import { cornerstoneJobAdEmployer, readCornerstonePosting, type CornerstoneEvidenceReader } from '../../src/lib/cornerstonePosting';
import { enrichAtsListingJob, readAtsJobEnrichmentMarker, type AtsJobEnrichmentDependencies } from '../../src/lib/atsJobEnrichment';
import { fetchExpandedAtsPosting } from '../../src/lib/expandedAtsPosting';

const slug = 'fixture.csod.com::4::default';
const url = 'https://fixture.csod.com/ux/ats/careersite/4/home/requisition/123';
const title = 'Channel Manager';
const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ corp: 'fixture', exp: 4102444800 })).toString('base64url')}.signature`;
const html = `<meta property="og:title" content="${title}"><script>var csodPlayerRouteInfo={"cid":"4","routeInfo":{"reqid":"123"}};
csod.context=${JSON.stringify({ corp: 'fixture', user: -103, cultureID: 1, cultureName: 'en-US', token, endpoints: { cloud: 'https://us.api.csod.com/' } })};</script>`;
const ad = '<p>Employer: Example Manufacturing</p><p>Manage the partner channel and distributor relationships across the assigned territory. Develop account plans with the sales team.</p>';
const legacy = (fields: unknown) => ({ status: 200, totalRecords: 1, data: [{ items: [{ fields }] }] });
const fixture = () => ({
  apply: legacy({ applyStatus: 2 }),
  publication: { status: 0, data: { postings: [{ careerSiteId: 4, postingUrl: `${url}?c=fixture`, startDate: '2026-11-01T00:00:00', endDate: null }] } },
  details: { status: 0, data: { displayTitle: title, ref: 'req123', allowApply: true, requisitionStatusId: 2, defaultCultureId: 1, availableCultures: [1],
    primaryLocation: { city: 'Austin', state: 'TX', country: 'US' }, additionalLocations: [{ city: 'Dallas', state: 'TX', country: 'US' }] } },
  ad: legacy({ id: 123, reqId: 'req123', title, ad }),
});
const now = new Date('2026-11-17T02:00:00Z');
function reader(data = fixture(), calls: string[] = []): CornerstoneEvidenceReader {
  return async (target, options) => {
    calls.push(target);
    assert.equal(new URL(target).origin, new URL(url).origin);
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
    const payload = target.includes('GetRequisitionApplyStatus') ? data.apply
      : target.includes('/jobDetails?') ? data.details : target.includes('/requisition/') ? data.publication : data.ad;
    return Response.json(payload);
  };
}

test('shell-only public evidence verifies employer, exact ID, title, site, full ad and geographic locations', async () => {
  const calls: string[] = [];
  const result = await readCornerstonePosting(html, url, reader(fixture(), calls), { expectedTitle: title, now });
  assert.equal(result.company, 'Example Manufacturing');
  assert.equal(result.description, ad);
  assert.equal(result.location, 'Austin, TX, US; Dallas, TX, US');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(target => !target.includes(token)));
  assert.ok(!JSON.stringify(result).includes(token));
});

test('employer proof reads recruiting statements in each ad, including different brands on a shared tenant', () => {
  const name = (ad: string) => cornerstoneJobAdEmployer(ad, url, title, 'req123');
  assert.equal(name('<p>Why Savers?<br>Savers is one of the UK’s discount retailers. Savers is part of AS Watson Group.</p>'), 'Savers');
  assert.equal(name('<p>Why Superdrug?<br>Superdrug is a health and beauty retailer.</p>'), 'Superdrug');
  assert.equal(name('<p>Who We Are<br>JPS Health Network is a healthcare system.</p><p>Acclaim Multispecialty Group is the medical practice group.</p><p>Why JPS?</p>'), 'JPS Health Network');
  assert.equal(name('<p>Why join Tetra Tech?</p><p>Tetra Tech is a consulting and engineering company.</p>'), 'Tetra Tech');
  assert.equal(name('<p>Why\r\njoin Tetra Tech?</p><p>Tetra\r\nTech is a consulting and engineering company.</p>'), 'Tetra Tech');
  assert.equal(name('<p>Acclaim Health (Acclaim) is a medical group.</p><p>About Acclaim Health:</p><p>Acclaim Health is a medical group partnering with JPS Health Network.</p>'), 'Acclaim Health');
  assert.equal(name('<p>The University of Illinois System is an equal opportunity employer, including disability.</p>'), 'University of Illinois System');
  assert.equal(name('<p>The University of New Mexico is committed to hiring and retaining a diverse workforce. We are an Equal Opportunity Employer.</p>'), 'University of New Mexico');
  assert.equal(name('<table><tr><th>Employer</th><td>Example Manufacturing</td></tr></table>'), 'Example Manufacturing');
  const linde = '<p class="above-job-title">Linde Electronics GmbH</p><p class="job-title">Channel Manager</p><p class="below-job-title">Austria | req123</p>';
  assert.equal(cornerstoneJobAdEmployer(linde, url.replace('fixture.', 'linde.'), title, 'req123'), 'Linde Electronics GmbH');
  assert.equal(cornerstoneJobAdEmployer(linde.replace('Linde Electronics GmbH', 'Linde Gas GmbH'), url.replace('fixture.', 'linde.'), title, 'req123'), 'Linde Gas GmbH');
  assert.equal(cornerstoneJobAdEmployer(linde.replace(' | ', '｜'), url.replace('fixture.', 'linde.'), title, 'req123'), 'Linde Electronics GmbH');
  assert.equal(cornerstoneJobAdEmployer(linde, url.replace('fixture.', 'linde.'), title, 'req999'), '');
});

test('mentions, generic headings, ambiguous organizations and unrelated branding do not prove an employer', () => {
  for (const ad of [
    '<p>Work with Savers and Tetra Tech customers.</p>', '<p>Why Savers?</p><p>Support our customers.</p>',
    '<p>Why us?</p><p>Us is a company.</p>', '<p>About the role:</p><p>The role is a chance to grow.</p>', '<p>Our client Example is an equal opportunity employer.</p>',
    '<p>Employer: Unknown Company</p>', '<p>Employer: Confidential</p>',
    '<p>Employer: First Employer</p><p>Employer: Second Employer</p>',
    '<p>First Employer is an equal opportunity employer.</p><p>Second Employer is an equal opportunity employer.</p>',
    '<p>Why join First Employer?</p><p>First Employer is a manufacturer.</p><p>Employer: Second Employer</p>',
    '<img alt="Example Manufacturing Logo" src="/example-logo.png"><p>Contact Example Manufacturing.</p>',
    '<blockquote>Employer: Example Manufacturing</blockquote><p hidden>Employer: Example Manufacturing</p>',
    '<script>Employer: Example Manufacturing</script>',
  ]) assert.equal(cornerstoneJobAdEmployer(ad, url, title, 'req123'), '', ad);
});

test('schema, identity, availability, language and employer failures leave the posting unresolved', async () => {
  const changes: Array<(data: ReturnType<typeof fixture>) => void> = [
    d => { d.apply.data[0].items[0].fields = { applyStatus: 0 }; },
    d => { d.publication.data.postings[0].careerSiteId = 5; },
    d => { d.publication.data.postings[0].postingUrl = url.replace('/123', '/999'); },
    d => { d.publication.data.postings[0].postingUrl = url.replace('fixture.', 'different.'); },
    d => { d.publication.data.postings[0].postingUrl = `${url}?id=999`; },
    d => { d.publication.data.postings[0].startDate = '2099-01-01T00:00:00'; },
    d => { d.publication.data.postings.push({ ...d.publication.data.postings[0] }); },
    d => { d.details.data.displayTitle = 'Different role'; },
    d => { d.details.data.ref = 'req999'; },
    d => { d.details.data.allowApply = false; },
    d => { d.details.data.availableCultures = [2]; },
    d => { d.ad.data[0].items[0].fields = { id: 999, reqId: 'req123', title, ad }; },
    d => { d.ad.data[0].items.push({ fields: { id: 123, reqId: 'req123', title, ad } }); },
    d => { d.ad.data[0].items[0].fields = { id: 123, reqId: 'req123', title: 'Different role', ad }; },
    d => { d.ad.data[0].items[0].fields = { id: 123, reqId: 'req123', title, ad: 'Description too Large. Unable to load this field' }; },
    d => { d.ad.data[0].items[0].fields = { id: 123, reqId: 'req123', title, ad: ad.replace('Employer:', 'Our customer:') }; },
  ];
  for (const change of changes) {
    const data = fixture(); change(data);
    await assert.rejects(readCornerstonePosting(html, url, reader(data), { expectedTitle: title, now }), { name: 'AtsDetailResponseError' });
  }
});

test('contradictory initial pages and structured evidence never fall through to another identity source', async () => {
  for (const body of [html.replace('"reqid":"123"', '"reqid":"999"'), html.replace('"cid":"4"', '"cid":"5"'),
    html.replace('content="Channel Manager"', 'content="Different role"'),
    html + '<meta property="og:title" content="Different role">',
    html + '<script type="application/ld+json">INVALID</script>',
    html + '<script type="application/ld+json">[{"@type":"JobPosting"},{"@type":"JobPosting"}]</script>']) {
    await assert.rejects(readCornerstonePosting(body, url, async () => { assert.fail('No follow-up request allowed'); }, { expectedTitle: title, now }));
  }
  await assert.rejects(readCornerstonePosting(html, url, async target => {
    const response = Response.json(fixture().apply);
    Object.defineProperty(response, 'url', { value: target.replace('fixture.', 'other.') });
    return response;
  }, { now }), /changed response identity/);
});

const raw = { id: `${slug}::123`, publicAtsPostingId: '123', title, description: '<p>Listing excerpt.</p>', company: 'Wrong sampled employer', location: 'US', url };
function dependencies(read: CornerstoneEvidenceReader): Partial<AtsJobEnrichmentDependencies> {
  let insideFence = false;
  return {
    safeExternalFetch: async (target, options) => String(target) === url ? new Response(html) : read(String(target), options),
    fetchPlatformResponse: async (_p, _s, dispatch, options) => {
      assert.equal(insideFence, false, 'follow-up requests must not nest a provider fence');
      insideFence = true;
      try { const response = await dispatch(); await options?.onResponse?.(response); return response; }
      finally { insideFence = false; }
    },
    reserveProviderBudgetForSource: async () => ({ allowed: true }),
    recordProviderSuccess: async () => {}, recordProviderFailure: async () => { assert.fail('Posting evidence must not open a provider circuit'); },
    createDeferredError: () => Object.assign(new Error('Retain for retry'), { name: 'AtsPlatformDeferredError' }),
    passesPreFilter: () => ({ passes: true, reason: '' }), now: () => now,
  };
}

test('saved raw listings gain a verified enrichment marker without rewriting original evidence or inheriting an employer', async () => {
  const before = structuredClone(raw);
  let budgets = 0, requests = 0, receipts = 0;
  const deps = dependencies(reader());
  const enriched = await enrichAtsListingJob({ platform: 'cornerstone', slug, job: raw, requestTimeoutMs: 1000,
    onRequestStarted: () => { requests++; }, onResponseReceived: () => { receipts++; } }, {
    ...deps, reserveProviderBudgetForSource: async () => { budgets++; return { allowed: true }; },
  });
  const marker = readAtsJobEnrichmentMarker(enriched);
  assert.equal(marker?.company, 'Example Manufacturing');
  assert.equal(marker?.description, ad);
  assert.equal(marker?.status, 'enriched');
  assert.deepEqual(raw, before);
  assert.equal(readAtsJobEnrichmentMarker(raw), null);
  assert.equal(budgets, 10); assert.equal(requests, 5); assert.equal(receipts, 5);
  assert.ok(!JSON.stringify(enriched).includes(token));
});

test('classic publication URLs and explicit default-language fallback retain exact identity checks', async () => {
  const data = fixture();
  data.publication.data.postings[0].postingUrl = 'https://fixture.csod.com/ats/careersite/jobdetails.aspx?site=4&c=fixture&id=123';
  data.details.data.availableCultures = [4]; data.details.data.defaultCultureId = 4;
  const calls: string[] = [];
  assert.equal((await readCornerstonePosting(html, url, reader(data, calls), { now })).company, 'Example Manufacturing');
  assert.ok(calls.at(-1)?.endsWith('cultureId=4'));
  for (const bad of ['site=5&c=fixture&id=123', 'site=4&c=other&id=123', 'site=4&c=fixture&id=124', 'site=4&c=fixture&id=123&id=124', 'site=4&site=5&c=fixture&id=123']) {
    data.publication.data.postings[0].postingUrl = `https://fixture.csod.com/ats/careersite/jobdetails.aspx?${bad}`;
    await assert.rejects(readCornerstonePosting(html, url, reader(data), { now }), /published URL disagrees/);
  }
});

test('follow-up service failures retain shared protection without terminalizing saved work', async () => {
  let failures = 0;
  const deps = dependencies(async () => new Response('', { status: 503 }));
  await assert.rejects(enrichAtsListingJob({ platform: 'cornerstone', slug, job: raw, requestTimeoutMs: 1000 }, {
    ...deps, recordProviderFailure: async () => { failures++; },
  }), { name: 'AtsPlatformDeferredError' });
  assert.equal(failures, 1);
  assert.equal(readAtsJobEnrichmentMarker(raw), null);
});

test('oversized public posting evidence is a local hold, not a provider outage', async () => {
  await assert.rejects(enrichAtsListingJob({ platform: 'cornerstone', slug, job: raw, requestTimeoutMs: 1000 },
    dependencies(async () => new Response(' '.repeat(5 * 1024 * 1024 + 1)))), (error: unknown) => {
      assert.equal((error as Error).name, 'AtsPlatformDeferredError');
      assert.deepEqual((error as { retryReason: unknown }).retryReason, { code: 'posting_mismatch', scope: 'posting' });
      return true;
    });
});

test('missing employer, closed posting, rate limits and cancellation preserve pending work', async () => {
  const unresolved = fixture(); unresolved.ad.data[0].items[0].fields = { id: 123, reqId: 'req123', title, ad: ad.replace('Employer:', 'Our customer:') };
  await assert.rejects(enrichAtsListingJob({ platform: 'cornerstone', slug, job: raw, requestTimeoutMs: 1000 }, dependencies(reader(unresolved))),
    (error: unknown) => {
      assert.equal((error as Error).name, 'AtsPlatformDeferredError');
      assert.deepEqual((error as { retryReason: unknown }).retryReason, { code: 'employer_unverified', scope: 'posting' }); return true;
    });
  for (const status of [403, 404, 429]) {
    await assert.rejects(enrichAtsListingJob({ platform: 'cornerstone', slug, job: raw, requestTimeoutMs: 1000 },
      dependencies(async () => new Response('', { status }))), { name: 'AtsPlatformDeferredError' });
  }
  const abort = new AbortController();
  await assert.rejects(enrichAtsListingJob({ platform: 'cornerstone', slug, job: raw, requestTimeoutMs: 1000, signal: abort.signal },
    dependencies(async () => { abort.abort(); return Response.json(fixture().apply); })), { name: 'AtsPlatformDeferredError' });
});

test('direct posting reads use the same verification path', async () => {
  const result = await fetchExpandedAtsPosting(url, async (target, options) => String(target) === url ? new Response(html) : reader()(String(target), options));
  assert.equal(result?.company, 'Example Manufacturing');
  assert.equal(result?.location, 'Austin, TX, US; Dallas, TX, US');
  assert.match(result?.text || '', /Manage the partner channel/);
});
