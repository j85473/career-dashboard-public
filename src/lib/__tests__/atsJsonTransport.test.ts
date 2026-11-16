import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAtsJson } from '../atsJsonTransport';
import { buildAtsBoardRequest, parseAtsListingPayload } from '../atsAcquisition';

test('Workday listing pages retain their POST cursor, signal and returned status without an alternate retry', async () => {
  const controller = new AbortController();
  const request = buildAtsBoardRequest({ platform: 'workday', slug: 'acme.wd5::Careers' }, 40);
  const init = { ...request.init, signal: controller.signal };
  let calls = 0;
  const refusal = new Response('temporarily unavailable', { status: 429, headers: { 'Retry-After': '120' } });
  const response = await fetchAtsJson('workday', request.url, init, {
    fetch: async () => { throw new Error('Workday must not retry through another client'); },
    safeExternalFetch: async (url, received) => {
      calls++;
      assert.equal(url, 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs');
      assert.equal(received, init);
      assert.equal(received?.signal, controller.signal);
      assert.equal(received?.method, 'POST');
      assert.equal(JSON.parse(String(received?.body)).offset, 40);
      return refusal;
    },
  });
  assert.equal(response, refusal);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '120');
  assert.equal(calls, 1);
});

test('successful Workday JSON retains every posting and the catalogue total for pagination', async () => {
  const jobs = Array.from({ length: 20 }, (_, index) => ({ externalPath: `/job/REQ-${index}`, title: 'Account Manager' }));
  const response = await fetchAtsJson('workday', 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs', {}, {
    fetch: async () => { throw new Error('unexpected fetch'); },
    safeExternalFetch: async () => Response.json({ total: 123, jobPostings: jobs }),
  });
  const page = parseAtsListingPayload('workday', await response.json());
  assert.deepEqual(page.jobs, jobs);
  assert.equal(page.total, 123);
});

test('other JSON providers retain their existing client and request signals', async () => {
  const init = { signal: new AbortController().signal };
  for (const platform of ['greenhouse', 'ashby', 'lever', 'workable', 'oracle']) {
    const response = new Response('{}');
    assert.equal(await fetchAtsJson(platform, 'https://example.com/jobs', init, {
      fetch: async (_url, received) => { assert.equal(received, init); return response; },
      safeExternalFetch: async () => { throw new Error('unrelated provider transport changed'); },
    }), response);
  }
});
