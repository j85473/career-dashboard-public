import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebDiscoveryArguments } from '../../scripts/crawl_ats_boards';
import { STARTUP_VC_DISCOVERY_SEEDS } from '../../src/lib/atsStartupDiscovery';
import { extractAtsDiscoveryLinks } from '../../src/lib/atsWebDiscoveryLinks';
import { runAtsWebDiscovery } from '../../src/lib/atsWebDiscovery';
import { AtsWebDiscoveryState } from '../../src/lib/atsWebDiscoveryState';

test('startup pack composes with operator seeds and leaves publishing explicit', () => {
  const args = parseWebDiscoveryArguments(['--source-pack', 'startup-vc', '--seed', STARTUP_VC_DISCOVERY_SEEDS[0]]);
  assert.deepEqual(args.seeds, [...STARTUP_VC_DISCOVERY_SEEDS]);
  assert.equal(args.publish, false);
  assert.deepEqual(parseWebDiscoveryArguments([]).seeds, []);
  assert.throws(() => parseWebDiscoveryArguments(['--source-pack', 'other']));
  assert.throws(() => parseWebDiscoveryArguments(['--source-pack', 'startup-vc', '--status']));
});

test('company routes outrank job copies while account and editorial routes stay out', () => {
  const found = extractAtsDiscoveryLinks(`
    <a href="/companies/acme/jobs/abc-sales">Sales role</a>
    <a href="/companies/industry/saas">Industry</a>
    <a href="https://account.ycombinator.com/authenticate?continue=apply">Apply</a>
    <a href="https://startupschool.org/">Startup School</a>
    <a href="/library/story">Story</a>
    <a href="/companies/skip/jobs/123" rel="nofollow">Skip</a>`, 'https://www.ycombinator.com/jobs');
  assert.equal(found.links[0].url, 'https://www.ycombinator.com/companies/acme');
  assert.ok(found.links.some(link => link.url.endsWith('/abc-sales')));
  assert.ok(!found.links.some(link => /authenticate|library|\/skip\/|startupschool/.test(link.url)));
  const profile = extractAtsDiscoveryLinks('<a href="https://acme.example/">acme.example</a>', 'https://www.indexventures.com/companies/acme/');
  assert.deepEqual(profile.links, [{ url: 'https://acme.example/', priority: 125 }]);
  const footer = extractAtsDiscoveryLinks('<a href="https://trust.wellfound.ai/">Trust</a><a href="https://a16z.substack.com/">Substack</a>', 'https://wellfound.com/company/acme');
  assert.deepEqual(footer.links, []);
});

test('VC listings still identify real ATS destinations, with source URLs kept out of ATS identities', () => {
  for (const source of ['https://jobs.a16z.com/jobs', 'https://jobs.sequoiacap.com/companies']) {
    const found = extractAtsDiscoveryLinks('<a href="https://job-boards.greenhouse.io/Acme/jobs/123">Apply</a>', source);
    assert.deepEqual(found.boards.map(({ platform, slug }) => ({ platform, slug })), [{ platform: 'greenhouse', slug: 'Acme' }]);
  }
  const index = extractAtsDiscoveryLinks('<a href="/companies/acme/">Acme</a>', 'https://www.indexventures.com/companies/');
  assert.equal(index.links[0].priority, 120);
  assert.deepEqual(index.boards, []);
});

test('public Wellfound company metadata reaches an employer ATS without collecting board copies', async () => {
  const payload = JSON.stringify({ props: { pageProps: { apolloState: { data: {
    'Startup:1': { companyUrl: 'https://acme.example/' },
    'Startup:2': { companyUrl: 'http://127.0.0.1/private' },
    'Viewer:1': { companyUrl: 'https://unrelated.example/' },
  } } } } });
  const profile = `<script id="__NEXT_DATA__" type="application/json">${payload}</script>`;
  const pages: Record<string, string> = {
    'https://wellfound.com/jobs': '<a href="/company/acme/jobs">Acme jobs</a>',
    'https://wellfound.com/company/acme': profile,
    'https://wellfound.com/company/acme/jobs': '<a href="/company/acme">Company</a>',
    'https://acme.example/': '<a href="/careers">Careers</a>',
    'https://acme.example/careers': '<a href="https://jobs.ashbyhq.com/Acme">Apply</a>',
  };
  let now = 1_000_000_000;
  const visited: string[] = [];
  const state = new AtsWebDiscoveryState(':memory:');
  try {
    await runAtsWebDiscovery(state, ['https://wellfound.com/jobs'], { maxRequests: 12 }, {
      now: () => now, sleep: async ms => { now += ms; },
      request: async url => {
        visited.push(url);
        if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
        assert.ok(url in pages, `Unexpected discovery destination ${url}`);
        return new Response(pages[url], { headers: { 'content-type': 'text/html' } });
      },
    });
    assert.deepEqual(state.pendingCandidates(10, now).map(({ platform, slug }) => ({ platform, slug })), [{ platform: 'ashby', slug: 'Acme' }]);
    assert.ok(visited.includes('https://acme.example/careers'));
    assert.ok(!visited.some(url => url.includes('ashbyhq') || url.includes('127.0.0.1') || url.includes('unrelated')));
    assert.deepEqual(extractAtsDiscoveryLinks(`<meta name="robots" content="nofollow">${profile}`, 'https://wellfound.com/company/acme'), { boards: [], links: [] });
    assert.doesNotThrow(() => extractAtsDiscoveryLinks('<script id="__NEXT_DATA__" type="application/json">broken</script>', 'https://wellfound.com/company/acme'));
  } finally { state.close(); }
});
