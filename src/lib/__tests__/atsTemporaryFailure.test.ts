import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAtsServiceAvailable, AtsTemporaryUnavailableError, atsTemporaryRetryDelayMs,
  isAtsMaintenancePage, isAtsTemporaryFailure,
} from '../atsTemporaryFailure';
import { isAtsBoardLevelFailure, isAtsProviderWideError } from '../atsAcquisition';
import { expandedConfig } from '../expandedPublicAts';

const now = new Date('2026-11-14T17:00:00Z');

test('gateway and server failures preserve board health and honor Retry-After', async () => {
  for (const status of [408, 425, 500, 502, 503, 504, 521]) {
    const response = new Response('Service down', { status, headers: { 'Retry-After': '7200' } });
    await assert.rejects(assertAtsServiceAvailable('hireology', response, now), (error: unknown) => {
      assert.ok(error instanceof AtsTemporaryUnavailableError);
      assert.equal(error.status, status);
      assert.equal(error.retryAt?.toISOString(), '2026-11-14T19:00:00.000Z');
      assert.equal(isAtsBoardLevelFailure(error), false);
      assert.equal(isAtsProviderWideError(error, 'hireology'), false, 'one failed host must not close every employer');
      return true;
    });
  }
  await assert.rejects(assertAtsServiceAvailable('workday', new Response('', {
    status: 503, headers: { 'Retry-After': 'Sat, 14 Nov 2026 20:00:00 GMT' },
  }), now), (error: unknown) => error instanceof AtsTemporaryUnavailableError && error.retryAt?.getTime() === now.getTime() + 3 * 3600_000);
});

test('HTTP 200 maintenance pages are retryable while job JSON and missing boards retain their meaning', async () => {
  const html = '<html><title>Workday</title><h1>Workday is currently unavailable</h1></html>';
  const response = new Response(html, { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(assertAtsServiceAvailable('workday', response), AtsTemporaryUnavailableError);
  assert.equal(response.bodyUsed, true, 'a rejected body must be released instead of retaining its connection');
  const healthyHtml = new Response('<h1>Employer careers</h1>', { headers: { 'Content-Type': 'text/html' } });
  await assertAtsServiceAvailable('hireology', healthyHtml);
  assert.equal(await healthyHtml.text(), '<h1>Employer careers</h1>', 'healthy bootstrap HTML stays available to its parser');
  await assertAtsServiceAvailable('workday', new Response(JSON.stringify({ total: 0, jobPostings: [] }), { headers: { 'Content-Type': 'application/json' } }));
  for (const status of [400, 401, 403, 404, 410, 429]) {
    await assertAtsServiceAvailable('workday', new Response('Unavailable', { status }));
  }
  assert.equal(isAtsBoardLevelFailure(new Error('HTTP 404')), true);
  assert.equal(isAtsTemporaryFailure(new Error('HTTP 404')), false);
});

test('career text, JavaScript and generic HTML do not establish a maintenance outage', () => {
  for (const html of ['<h1>Maintenance Technician</h1>', '<h1>Careers</h1><p>Scheduled maintenance experience required</p>',
    '<script>const message = "Workday is currently unavailable";</script><h1>Careers</h1>',
    '<script>const template = "<h1>Service Unavailable</h1>";',
    '<!-- <h1>Service Unavailable</h1> -->', '<h1>Page not found</h1>']) {
    assert.equal(isAtsMaintenancePage(html), false, html);
  }
  assert.equal(isAtsMaintenancePage('<title>Scheduled Maintenance</title>'), true);
  assert.equal(isAtsMaintenancePage('<h1>Service Unavailable</h1>'), true);
});

test('an unbounded HTML response is inspected only through a small prefix', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(20_000))); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/html' } });
  await assertAtsServiceAvailable('workday', response);
  await response.body!.cancel();
  assert.equal(cancelled, true);
});

test('missing Hireology bootstrap stays pending and an unrelated identity remains rejected', () => {
  assert.throws(() => expandedConfig('hireology', 'example', '<html><title>Careers</title></html>'), (error: unknown) => {
    assert.ok(error instanceof AtsTemporaryUnavailableError);
    assert.match(error.message, /configuration is missing/);
    assert.equal(isAtsBoardLevelFailure(error), false);
    return true;
  });
  assert.throws(() => expandedConfig('hireology', 'example', '<html></html>', 'https://careers.hireology.com/other'), /changed board identity/);
});

test('network failures do not age boards and temporary retry waits stay bounded and spread', () => {
  for (const error of [new TypeError('fetch failed'), new Error('ECONNRESET'), new Error('request timed out')]) {
    assert.equal(isAtsTemporaryFailure(error), true);
    assert.equal(isAtsBoardLevelFailure(error), false);
  }
  for (const [failures, maximum] of [[0, 15], [1, 30], [2, 60], [100, 60]]) {
    const delay = atsTemporaryRetryDelayMs(failures, 'workday:example.wd5::careers');
    assert.ok(delay > (maximum - 1) * 60_000 && delay <= maximum * 60_000);
  }
  assert.notEqual(atsTemporaryRetryDelayMs(2, 'workday:a'), atsTemporaryRetryDelayMs(2, 'workday:b'));
});
