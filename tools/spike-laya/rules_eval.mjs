import { RulesInterpreter } from '../../voice/interpreters/rules.js';
import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/' + (process.argv[2] ?? 'voice_commands_pt.json') + '', import.meta.url), 'utf8'));
const rules = new RulesInterpreter();
let n = 0, ok = 0, falsePos = 0, miss = 0; const per = {}, wrong = [];
for (const [command, sentences] of Object.entries(data)) for (const s of sentences) {
    n++; const call = rules.interpret(s); const got = call?.command ?? 'none';
    const hit = got === command; ok += hit; per[command] ??= [0, 0]; per[command][1]++; per[command][0] += hit;
    if (!hit) { wrong.push([s, command, got]); if (command === 'none') falsePos++; else if (got === 'none') miss++; }
}
console.log(`regras: ${ok}/${n} = ${(100 * ok / n).toFixed(1)}% | conversa tomada por comando: ${falsePos} | comando não entendido: ${miss} | trocas: ${n - ok - falsePos - miss}`);
console.log(Object.entries(per).map(([c, v]) => `${c} ${v[0]}/${v[1]}`).join(', '));
for (const w of wrong.slice(0, 60)) console.log('  ERRO', JSON.stringify(w));
