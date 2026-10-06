// Cria (ou troca a chave de) um cliente em data/clientes.json e mostra a chave UMA vez.
// O arquivo guarda só o hash SHA-256; quem perder a chave precisa gerar outra.
//
// Uso:
//   npm run cliente -- acme "ACME Transportes"          # cliente sem CDs (cadastre no JSON)
//   npm run cliente -- demo "Demonstração" --demo       # usa os CDs de exemplo da Grande Florianópolis
//   npm run cliente -- acme --nova-chave                # troca a chave de um cliente existente
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(ROOT, process.env.CLIENTES_FILE || 'data/clientes.json');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [id, nome] = args.filter((a) => !a.startsWith('--'));

if (!id || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) {
  console.error('Informe o id do cliente: minúsculas, números, - e _ (até 40). Ex.: npm run cliente -- acme "ACME"');
  process.exit(1);
}

const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
let cliente = list.find((c) => c.id === id);
if (cliente && !flags.has('--nova-chave')) {
  console.error(`O cliente "${id}" já existe. Use --nova-chave para trocar a chave.`);
  process.exit(1);
}
if (!cliente) {
  cliente = { id, nome: nome || id, centros: flags.has('--demo') ? 'demo' : [] };
  list.push(cliente);
}

const chave = crypto.randomBytes(24).toString('base64url');
cliente.chaveSha256 = crypto.createHash('sha256').update(chave).digest('hex');

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
const shown = file.startsWith(ROOT + path.sep) ? path.relative(ROOT, file) : file;
console.log(`Cliente "${id}" gravado em ${shown}.`);
console.log(`Chave de acesso (guarde agora; ela não é salva): ${chave}`);
console.log('Reinicie o servidor para valer.');
