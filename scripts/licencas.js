// Licenças das dependências: gera THIRD_PARTY_NOTICES.md e confere se todas permitem
// uso comercial em produto fechado. O FrotaLogIA é proprietário (ver LICENSE), então
// dependência copyleft (GPL, AGPL, LGPL, MPL, SSPL...) não pode entrar sem análise.
//
// Uso:
//   npm run licencas            # regenera THIRD_PARTY_NOTICES.md
//   npm run licencas -- --check # só confere (o teste faz o mesmo)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_FILE = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');

// Permissivas: permitem vender produto fechado; exigem manter o aviso de copyright.
export const PERMITIDAS = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', '(MIT OR Apache-2.0)',
]);

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/** Dependências instaladas, a partir do package-lock.json. */
export function listDependencies(root = ROOT) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([p]) => p.startsWith('node_modules/'))
    .map(([p, info]) => {
      const dir = path.join(root, p);
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const license = typeof pj.license === 'string' ? pj.license : JSON.stringify(pj.license ?? pj.licenses ?? null);
      const file = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f));
      return {
        name: pj.name,
        version: pj.version,
        license,
        dev: Boolean(info.dev),
        repository: typeof pj.repository === 'string' ? pj.repository : pj.repository?.url ?? null,
        // Fim de linha em LF: o git normaliza o arquivo gerado, e o teste compara byte a byte.
        text: file ? fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n?/g, '\n').trim() : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function checkLicenses(deps) {
  return deps.filter((d) => !PERMITIDAS.has(d.license)).map((d) => `${d.name}@${d.version}: ${d.license}`);
}

export function renderNotices(deps) {
  const prod = deps.filter((d) => !d.dev);
  const lines = [
    '# Avisos de terceiros',
    '',
    'O FrotaLogIA é software proprietário (ver `LICENSE`). Ele usa os componentes abaixo,',
    'cada um sob a licença do seu autor. Todas são permissivas e exigem manter este aviso.',
    '',
    'Gerado por `npm run licencas`. Não edite à mão.',
    '',
    '| Pacote | Versão | Licença |',
    '|---|---|---|',
    ...prod.map((d) => `| ${d.name} | ${d.version} | ${d.license} |`),
    '',
    '## Serviços e dados externos',
    '',
    '- **OpenStreetMap** (dados do mapa): © colaboradores do OpenStreetMap, licença ODbL. A atribuição aparece no canto do mapa e não pode ser removida.',
    '- **OpenFreeMap / OpenMapTiles** (tiles e estilo padrão): atribuição exibida no mapa.',
    '- **Fontes Noto e Google Fonts** (Public Sans, Bricolage Grotesque): SIL Open Font License 1.1.',
    '- **OSRM público** (`router.project-osrm.org`, só no simulador): servidor de demonstração, sem uso comercial. Em produção, use uma instância própria.',
    '',
    '## Textos das licenças',
    '',
  ];
  for (const d of prod) {
    lines.push(`### ${d.name}@${d.version} (${d.license})`, '');
    if (d.repository) lines.push(`Origem: ${d.repository}`, '');
    lines.push(d.text ? ['```', d.text, '```'].join('\n') : `Licença ${d.license}; o pacote não traz o texto completo.`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deps = listDependencies();
  const problemas = checkLicenses(deps);
  if (problemas.length) {
    console.error('Dependências com licença que não permite (ou não foi analisada para) uso em produto fechado:');
    for (const p of problemas) console.error(`  - ${p}`);
    process.exit(1);
  }
  const notices = renderNotices(deps);
  if (process.argv.includes('--check')) {
    const atual = fs.existsSync(NOTICES_FILE) ? fs.readFileSync(NOTICES_FILE, 'utf8') : '';
    if (atual !== notices) {
      console.error('THIRD_PARTY_NOTICES.md desatualizado. Rode: npm run licencas');
      process.exit(1);
    }
    console.log(`Licenças ok: ${deps.length} dependências, todas permissivas.`);
  } else {
    fs.writeFileSync(NOTICES_FILE, notices);
    console.log(`THIRD_PARTY_NOTICES.md gerado: ${deps.filter((d) => !d.dev).length} componentes, todos permissivos.`);
  }
}
