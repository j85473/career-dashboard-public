import assert from 'node:assert/strict';
import test from 'node:test';
import { descriptionWorkLocation } from '../../src/lib/descriptionWorkLocation';
import { localTriageVerdict } from '../../src/lib/localTriage';
import { parseGreenhousePosting } from '../../src/lib/greenhousePosting';

const title = 'Territory Sales Manager (TSM) FL-Orlando/Jacksonville';
const description = 'Manage and grow dealer accounts.\n\nPosition Title: Territory Sales Manager-FL\n\nLocation: Remote FL-Orlando/Jacksonville\n\nEmployment Type: Full Time';

test('the retained Greenhouse remote label is narrowed by the explicit Florida work location before geography triage', () => {
  const posting = parseGreenhousePosting({ id: 4456312009, title, company_name: 'Latham, The Pool Company',
    location: { name: 'USA Remote' }, content: description.replace(/\n/g, '<br>') }, { board: 'lathampool', id: '4456312009' });
  assert.equal(posting?.location, 'Remote FL-Orlando/Jacksonville');
  assert.equal(localTriageVerdict({ title, location: posting?.location, capRationale: '' }).pass, false);
});

test('the updated Greenhouse location list retains sites without treating USA Remote as an independent nationwide option', () => {
  const location = descriptionWorkLocation('Florida; Orlando, Florida, United States; USA Remote; Zephyrhills, Florida, United States', description);
  assert.equal(location, 'Florida; Orlando, Florida, United States; Zephyrhills, Florida, United States; Remote FL-Orlando/Jacksonville');
  assert.equal(localTriageVerdict({ title, location, capRationale: '' }).pass, false);
});

test('explicit local work locations remain eligible and Markdown labels work', () => {
  const location = descriptionWorkLocation('Unknown Location', '**Work Location:** Minneapolis, MN (Remote)');
  assert.equal(location, 'Minneapolis, MN (Remote)');
  assert.equal(localTriageVerdict({ title: 'Account Manager', location, capRationale: '' }).pass, true);
  assert.equal(descriptionWorkLocation('USA Remote', 'Location: Orlando, Florida'), 'Orlando, Florida (Remote)');
});

test('coverage, boilerplate, nationwide eligibility, conflicting labels and existing concrete locations cannot become restrictions', () => {
  for (const body of ['Covers Florida and Georgia accounts.', 'Headquarters in Orlando, Florida.',
    'Location: Remote nationwide; customers in Florida', 'Location: Remote in the US',
    'Location: USA Remote', 'Location: Remote FL\nLocation: Remote MN',
    'Location: https://example.com/Florida', 'Location: Florida territory coverage', 'Location: USA Remote (Florida preferred)']) {
    assert.equal(descriptionWorkLocation('USA Remote', body), undefined, body);
  }
  assert.equal(descriptionWorkLocation('Minneapolis, MN', description), undefined);
  assert.equal(descriptionWorkLocation('Minneapolis, MN; USA Remote', description), undefined);
  assert.equal(descriptionWorkLocation('Virginia; USA Remote', 'Location: Remote West Virginia'), undefined);
  assert.equal(descriptionWorkLocation('USA Remote', 'Location: Remote US\nAccounts in Florida'), undefined);
});
