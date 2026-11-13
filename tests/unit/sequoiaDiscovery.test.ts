import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAtsWebDiscovery } from '../../src/lib/atsWebDiscovery';
import { extractAtsDiscoveryLinks, extractSequoiaDiscoveryLinks } from '../../src/lib/atsWebDiscoveryLinks';
import { AtsWebDiscoveryState } from '../../src/lib/atsWebDiscoveryState';
import { isSequoiaDiscoveryApiUrl, SEQUOIA_DISCOVERY_BOOTSTRAP, sequoiaDiscoveryApiUrl,
  sequoiaDiscoveryDestinations, sequoiaDiscoveryRequest, sequoiaDiscoverySession } from '../../src/lib/sequoiaDiscovery';

const bootstrap = '<script>window.serverInitialData = {"fixedBoard":"sequoia-capital","csrfToken":"public-anonymous-token"};</script>';
const directory = (websites: string[], sequence: string | null = null, total = websites.length) => JSON.stringify({
  companies: websites.map((url, i) => ({ id: `company-${i}`, website: { url } })), total,
  meta: { size: 21, sequence }, errors: [],
});

test('only the exact public directory endpoint can receive an anonymous POST session', () => {
  const session = sequoiaDiscoverySession(bootstrap, ['anonymous=public-cookie; Path=/; HttpOnly']);
  const url = sequoiaDiscoveryApiUrl('opaque+/=');
  assert.equal(isSequoiaDiscoveryApiUrl(url), true);
  const request = sequoiaDiscoveryRequest(url, session);
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), { query: {}, meta: { size: 21, sequence: 'opaque+/=' }, board: { id: 'sequoia-capital', isParent: true } });
  for (const invalid of ['https://jobs.sequoiacap.com.evil.test/api-boards/search-companies',
    'http://jobs.sequoiacap.com/api-boards/search-companies', 'https://jobs.sequoiacap.com/api-boards/save-user',
    `${sequoiaDiscoveryApiUrl()}?sequence=`, `${sequoiaDiscoveryApiUrl()}?sequence=x&sequence=y`,
    `${sequoiaDiscoveryApiUrl()}?other=1`]) {
    assert.equal(isSequoiaDiscoveryApiUrl(invalid), false);
    assert.throws(() => sequoiaDiscoveryRequest(invalid, session));
  }
  assert.throws(() => sequoiaDiscoverySession(bootstrap.replace('sequoia-capital', 'other-board'), ['a=b']));
  assert.throws(() => sequoiaDiscoverySession(bootstrap, []));
});

test('Sequoia uses actual employer websites and keeps pagination at the directory depth', () => {
  const first = sequoiaDiscoveryApiUrl();
  const links = extractAtsDiscoveryLinks(bootstrap, SEQUOIA_DISCOVERY_BOOTSTRAP);
  assert.ok(links.links.some(link => link.url === first && link.priority === 130));
  assert.deepEqual(extractAtsDiscoveryLinks(`<meta name="robots" content="nofollow">${bootstrap}`, SEQUOIA_DISCOVERY_BOOTSTRAP), { boards: [], links: [] });
  const found = extractSequoiaDiscoveryLinks(directory(['https://employer.example/careers',
    'http://127.0.0.1/private', 'javascript:alert(1)', 'https://jobs.lever.co/ExactTenant'], 'next', 20), first);
  assert.deepEqual(found.links, [{ url: sequoiaDiscoveryApiUrl('next'), priority: 130, depthDelta: 0 },
    { url: 'https://employer.example/careers', priority: 125 }]);
  assert.deepEqual(found.boards.map(({ platform, slug }) => ({ platform, slug })), [{ platform: 'lever', slug: 'ExactTenant' }]);
  const namesOnly = JSON.stringify({ companies: [{ id: 'NoATSGuess', domain: 'company.example', jobSources: [{ id: 'greenhouse' }] }], total: 1, meta: {}, errors: [] });
  assert.deepEqual(extractSequoiaDiscoveryLinks(namesOnly, first), { boards: [], links: [] });
});

test('changed, truncated, error, and nonadvancing directory responses remain failures', () => {
  const url = sequoiaDiscoveryApiUrl();
  for (const body of ['broken', '{}', directory([], 'next', 4), directory(['https://a.example'], null, 4),
    directory(Array(22).fill('https://a.example')), JSON.stringify({ companies: [], total: 0, meta: {}, errors: [{ status: 503 }] })]) {
    assert.throws(() => sequoiaDiscoveryDestinations(body, url));
  }
  assert.throws(() => sequoiaDiscoveryDestinations(directory(['https://a.example'], 'same', 3), sequoiaDiscoveryApiUrl('same')));
  assert.throws(() => sequoiaDiscoveryDestinations(directory(['https://a.example'], 'same', 3), `${url}?sequence=%73ame`));
  assert.deepEqual(sequoiaDiscoveryDestinations(directory([]), url), { websites: [], nextUrl: null });
});

test('published company website reaches its real ATS with no Sequoia credentials forwarded', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  let now = 1_000_000_000;
  const calls: string[] = [];
  try {
    await runAtsWebDiscovery(state, [sequoiaDiscoveryApiUrl()], { maxRequests: 6, maxDepth: 2 }, {
      now: () => now, sleep: async ms => { now += ms; },
      request: async (url, init) => {
        calls.push(url);
        if (new URL(url).hostname !== 'jobs.sequoiacap.com') {
          assert.equal(init.method, 'GET');
          assert.equal(new Headers(init.headers).has('cookie'), false);
          assert.equal(new Headers(init.headers).has('x-csrf-token'), false);
        }
        if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
        if (url === SEQUOIA_DISCOVERY_BOOTSTRAP) return new Response(bootstrap, { headers: { 'content-type': 'text/html', 'set-cookie': 'anonymous=public-cookie; Path=/' } });
        if (url === sequoiaDiscoveryApiUrl()) return new Response(directory(['https://employer.example/']), { headers: { 'content-type': 'application/json' } });
        assert.equal(url, 'https://employer.example/');
        return new Response('<a href="https://jobs.ashbyhq.com/ExactEmployer">Careers</a>', { headers: { 'content-type': 'text/html' } });
      },
    });
    assert.equal(calls.length, 5);
    assert.deepEqual(state.pendingCandidates(10, now).map(({ platform, slug, sourceUrl }) => ({ platform, slug, sourceUrl })),
      [{ platform: 'ashby', slug: 'ExactEmployer', sourceUrl: 'https://employer.example/' }]);
  } finally { state.close(); }
});

test('paginated discovery resumes after the request budget and never persists anonymous credentials', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'sequoia-discovery-'));
  const filename = path.join(folder, 'state.sqlite');
  let state = new AtsWebDiscoveryState(filename);
  let now = 1_000_000_000;
  const calls: Array<{ url: string; at: number }> = [];
  const dependencies = {
    now: () => now, sleep: async (ms: number) => { now += ms; },
    request: async (url: string, init: RequestInit) => {
      calls.push({ url, at: now });
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === SEQUOIA_DISCOVERY_BOOTSTRAP) return new Response(bootstrap, { headers: { 'content-type': 'text/html', 'set-cookie': 'anonymous=public-cookie; Path=/; HttpOnly' } });
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('x-csrf-token'), 'public-anonymous-token');
      assert.equal(headers.get('cookie'), 'anonymous=public-cookie');
      const payload = JSON.parse(String(init.body));
      const sequence = new URL(url).searchParams.get('sequence');
      assert.equal(payload.meta.sequence ?? null, sequence);
      assert.equal(payload.meta.size, 21);
      assert.equal(payload.board.id, 'sequoia-capital');
      assert.ok(url === sequoiaDiscoveryApiUrl() || url === sequoiaDiscoveryApiUrl('next'));
      return new Response(sequence ? directory(['https://job-boards.greenhouse.io/SecondTenant'])
        : directory(['https://jobs.lever.co/FirstTenant'], 'next', 2), { headers: { 'content-type': 'application/json' } });
    },
  };
  try {
    const first = await runAtsWebDiscovery(state, [SEQUOIA_DISCOVERY_BOOTSTRAP], { maxRequests: 3, maxDepth: 1 }, dependencies);
    assert.equal(first.requests, 3);
    assert.equal(first.stopReason, 'request_budget');
    assert.equal(state.pendingCandidates(10, now).length, 1);
    state.close();
    state = new AtsWebDiscoveryState(filename);
    const second = await runAtsWebDiscovery(state, [], { maxRequests: 3, maxDepth: 1 }, dependencies);
    assert.equal(second.requests, 2, 'a resumed pass refreshes the anonymous session and then fetches only the saved continuation');
    assert.deepEqual(state.pendingCandidates(10, now).map(({ slug }) => slug).sort(), ['FirstTenant', 'SecondTenant']);
    assert.equal(state.report().pages.filter(row => row.status === 'visited').reduce((n, row) => n + Number(row.count), 0), 3);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 5000);
    state.close();
    for (const suffix of ['', '-wal']) {
      let bytes: Buffer;
      try { bytes = readFileSync(filename + suffix); } catch { continue; }
      assert.equal(bytes.includes(Buffer.from('public-anonymous-token')), false);
      assert.equal(bytes.includes(Buffer.from('public-cookie')), false);
    }
    state = new AtsWebDiscoveryState(filename);
  } finally { state.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('robots denial prevents session bootstrap and API access; session expiry remains retryable', async () => {
  for (const mode of ['robots', 'session', 'schema', 'html'] as const) {
    const state = new AtsWebDiscoveryState(':memory:');
    let now = 1_000_000_000;
    const calls: string[] = [];
    try {
      await runAtsWebDiscovery(state, [sequoiaDiscoveryApiUrl()], { maxRequests: 3 }, {
        now: () => now, sleep: async ms => { now += ms; },
        request: async url => {
          calls.push(url);
          if (url.endsWith('/robots.txt')) return new Response(`User-agent: *\n${mode === 'robots' ? 'Disallow: /companies' : 'Allow: /'}`);
          if (url === SEQUOIA_DISCOVERY_BOOTSTRAP) return new Response(bootstrap, { headers: { 'content-type': 'text/html', 'set-cookie': 'anonymous=public-cookie; Path=/' } });
          if (mode === 'session') return new Response('expired', { status: 412 });
          return new Response(mode === 'schema' ? '{}' : '<html>challenge</html>', { headers: { 'content-type': mode === 'schema' ? 'application/json' : 'text/html' } });
        },
      });
      assert.ok(state.report().pages.some(row => row.status === 'retry'));
      assert.deepEqual(state.pendingCandidates(10, now), []);
      if (mode === 'robots') assert.deepEqual(calls, ['https://jobs.sequoiacap.com/robots.txt']);
    } finally { state.close(); }
  }
});
