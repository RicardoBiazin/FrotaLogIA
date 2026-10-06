import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listDependencies, checkLicenses, renderNotices, NOTICES_FILE } from '../scripts/licencas.js';

// O FrotaLogIA é proprietário e será vendido: dependência copyleft não pode entrar sem análise.
test('todas as dependências têm licença permissiva', () => {
  assert.deepEqual(checkLicenses(listDependencies()), []);
});

test('licença copyleft ou desconhecida é barrada', () => {
  const dep = (license) => ({ name: 'x', version: '1.0.0', license });
  assert.equal(checkLicenses([dep('GPL-3.0'), dep('AGPL-3.0-only'), dep('null'), dep('MIT')]).length, 3);
});

test('THIRD_PARTY_NOTICES.md está atualizado (rode npm run licencas)', () => {
  assert.equal(fs.readFileSync(NOTICES_FILE, 'utf8'), renderNotices(listDependencies()));
});
