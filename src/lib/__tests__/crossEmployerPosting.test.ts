import assert from 'node:assert/strict';
import test from 'node:test';
import { findCrossEmployerPosting, findPublisherForIncomingPosting } from '../crossEmployerPosting';
import { resolveDirectAtsPosting, type DirectMatchDeps } from '../atsDirectMatch';
import { sameEmployerPosting } from '../savedPostingOwner';

const title = 'Channel Account Manager';
const words = Array.from({ length: 210 }, (_, n) => `partner${n}`).join(' ');
const description = `Manage a partner portfolio and develop distribution accounts. ${words}`;
const publisher = { id: 'publisher', source: 'JSearch', company: 'Publisher', title, location: 'Minneapolis, MN',
  url: 'https://www.jobleads.com/us/jobs/channel-manager', description, canonicalUrl: null, userCanonicalUrl: null };
const direct = { ...publisher, id: 'employer', company: 'Hiring Company', source: 'ATS-greenhouse',
  url: 'https://job-boards.greenhouse.io/employer/jobs/987654' };
type Card = Omit<typeof publisher, 'userCanonicalUrl' | 'canonicalUrl'> & {
  userCanonicalUrl?: string | null; canonicalUrl?: string | null; observations?: { source: string; url: string }[];
};
function catalogue(rows: Card[]) {
  return { job: { findMany: async ({ where }: { where: {
    AND?: { title?: { equals: string }; source?: unknown }[]; OR?: { company?: { equals?: string } }[];
  } }) => {
    if (where.AND) {
      const key = where.AND.find(item => item.title)?.title?.equals.toLowerCase();
      const publisherOnly = where.AND.some(item => item.source);
      return rows.filter(row => row.title.toLowerCase() === key && (!publisherOnly || !row.source.startsWith('ATS-')));
    }
    return rows.filter(row => where.OR?.some(item => item.company?.equals?.toLowerCase() === row.company.toLowerCase()));
  } } } as unknown as DirectMatchDeps['store'];
}

test('a publisher or brand label can resolve a substantial reprint to one saved employer posting', async () => {
  const examples = [['RosterPoint', 'Workiva'], ['AmerisourceBergen', 'AmerisourceBergen Corporation'],
    ['Nobel Biocare', 'Dental Imaging Technologies'], ['Walmart - Internal', 'Walmart']];
  for (const [publisherName, employerName] of examples) {
    const copy = { ...publisher, company: publisherName, description: description + ' Publisher footer.' };
    const store = catalogue([{ ...direct, company: employerName }]);
    const match = await resolveDirectAtsPosting(copy, { store, allowLivePing: false });
    assert.equal(match?.url, direct.url, publisherName);
  }
});

test('employer links selected by the user or preserved as ATS sightings count on publisher-sourced cards', async () => {
  const branded = 'https://careers.example.com/jobs/987654';
  const fromObservation = { ...publisher, id: 'second', company: direct.company, observations: [{ source: direct.source, url: direct.url }] };
  for (const [row, url] of [[fromObservation, direct.url], [{ ...fromObservation, userCanonicalUrl: branded }, branded]] as const) {
    const result = await findCrossEmployerPosting(publisher, catalogue([row]));
    assert.ok(result?.kind === 'matched');
    assert.equal(result.match.url, url);
    assert.equal(result.match.postingLocation, null);
  }
});

test('similar UK requisitions stay unresolved even when one body is an exact copy', async () => {
  const uk = { ...direct, location: 'Remote - UK' };
  const rival = { ...uk, id: 'second', url: direct.url.replace('987654', '987655'),
    description: description.replace('partner100', 'distributor100') };
  const copy = { ...publisher, location: uk.location };
  const store = catalogue([uk, rival]);
  assert.equal((await findCrossEmployerPosting(copy, store))?.kind, 'unresolved');
  assert.equal(await resolveDirectAtsPosting({ ...copy, company: direct.company }, { store, allowLivePing: false }), null);
  assert.equal(await findPublisherForIncomingPosting(uk, catalogue([copy, rival])), null);
});

test('a competing requisition in the named employer catalogue vetoes a cross-employer match', async () => {
  const rival = { title: title + ' - Minneapolis, MN', url: direct.url.replace('987654', '111111'),
    description, location: publisher.location };
  assert.equal((await findCrossEmployerPosting(publisher, catalogue([direct]), [rival]))?.kind, 'unresolved');
});

test('short text, different territories, conflicting requisitions and truncated searches stay unresolved', async () => {
  for (const copy of [{ ...publisher, description: 'Manage partners.' }, { ...publisher, location: 'Germany' },
    { ...publisher, description: description + '\nRequisition ID: R99999' }]) {
    assert.equal(await findCrossEmployerPosting(copy, catalogue([direct])), null);
  }
  const crowded = Array.from({ length: 101 }, (_, i) => ({ ...direct, id: String(i) }));
  assert.equal((await findCrossEmployerPosting(publisher, catalogue(crowded)))?.kind, 'unresolved');
});

test('a later employer posting can claim one publisher copy but cannot replace a selected destination', async () => {
  assert.equal((await findPublisherForIncomingPosting(direct, catalogue([publisher])))?.id, publisher.id);
  assert.equal(await findPublisherForIncomingPosting(direct, catalogue([{ ...publisher, userCanonicalUrl: publisher.url }])), null);
  assert.equal(await findPublisherForIncomingPosting(direct, catalogue([publisher, { ...publisher, id: 'second' }])), null);
});

test('a Greenhouse host alias identifies one opening while the same number at another employer stays separate', () => {
  assert.ok(sameEmployerPosting(direct.url, direct.url.replace('job-boards.', 'boards.')));
  assert.equal(sameEmployerPosting(direct.url, direct.url.replace('/employer/', '/different/')), false);
});
