import assert from 'node:assert/strict';
import test from 'node:test';
import { smartRecruitersPostingCompany } from '../smartRecruitersCompany';

const company = { name: 'StepStone Group', identifier: 'StepStoneGroup' };
test('Appcast posting uses its explicit brand rather than its shared recruiting account', () => {
  assert.equal(smartRecruitersPostingCompany({ company, customField: [
    { fieldLabel: 'Brands', valueLabel: 'Appcast' },
    { fieldLabel: 'Legal Entity', valueLabel: 'Appcast Inc' },
  ] }), 'Appcast');
  assert.equal(smartRecruitersPostingCompany({ company, customField: [
    { fieldLabel: 'Brands', valueLabel: 'Totaljobs' },
  ] }), 'Totaljobs');
  assert.equal(smartRecruitersPostingCompany({ company }), 'StepStone Group');
});

test('missing or ambiguous brand falls back to legal entity then published account name', () => {
  assert.equal(smartRecruitersPostingCompany({ company, customField: [
    { fieldLabel: 'Brand', valueLabel: '' }, { fieldLabel: 'Legal Entity', valueLabel: 'Appcast Inc' },
  ] }), 'Appcast Inc');
  assert.equal(smartRecruitersPostingCompany({ company, customField: [
    { fieldLabel: 'Brands', valueLabel: 'Appcast' }, { fieldLabel: 'Brands', valueLabel: 'Totaljobs' },
  ] }), 'StepStone Group');
  assert.equal(smartRecruitersPostingCompany({ company, customField: [
    { fieldLabel: 'Brands', valueLabel: 'Appcast; Totaljobs' },
  ] }), 'StepStone Group');
});

test('unrelated custom fields, description mentions and tenant identifiers are not employer evidence', () => {
  assert.equal(smartRecruitersPostingCompany({ company, customField: [null,
    { fieldLabel: 'Client Brand', valueLabel: 'Appcast' }, { fieldLabel: 'Department', valueLabel: 'Appcast' },
  ], description: 'Working with Appcast clients' }), 'StepStone Group');
  assert.equal(smartRecruitersPostingCompany({ company: { identifier: 'StepStoneGroup' } }), null);
  for (const input of [null, [], 'Appcast', {}]) assert.equal(smartRecruitersPostingCompany(input), null);
});
