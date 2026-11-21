//RulesInterpreter: turns a Portuguese sentence into a command call with a fixed grammar. No model, no network, deterministic: the
//base that always works. (A zero-shot decision model was measured against it and lost: docs/spike-laya.md.)
//
//  interpret(text, ctx) -> { command, args, confidence } | null        ctx: { actionTitles?: [string] } (titles/aliases of the actions on screen)
//
//An interpreter picks the command and cuts the phrases out ("a tabela de notícias"); resolving them to instances is the command's job.
//When nothing matches it answers null ("não entendi"): it never guesses a command, so a misheard sentence cannot run the wrong one.

//Same length as the input (so match positions point into the original text): lowercase, no accents
const fold = text => [...String(text)].map(ch => ch.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')[0] ?? ' ').join('');
const SIDE = { esquerda: 'left', esquerdo: 'left', direita: 'right', direito: 'right', cima: 'top', acima: 'top', baixo: 'bottom', abaixo: 'bottom' };
const clean = value => value?.replace(/^[\s,.:;!?]+|[\s,.:;!?]+$/g, '') ?? '';

//Said before or after the command without changing it: "ops, desfaz isso", "pode fechar a tabela", "abre as notas por favor"
const LEAD = /^(?:(?:ops|opa|ah|ai|errei|bom|entao|por favor|pode|podia|poderia|voce pode|voce poderia|consegue|da pra|gostaria de|quero que voce|eu quero que voce)(?=[\s,]|$)[\s,]*)+/;
const TRAIL = /(?:[\s,]+(?:por favor|pra mim|para mim|agora|ai|ja|ta))+$/;

const SIDES = 'esquerd[ao]|direit[ao]|cima|baixo';
const MOVE_VERBS = 'move|mova|mover|poe|ponha|passa|passe|joga|jogue|leva|leve|manda|mande|bota|bote|coloca|coloque|empurra|empurre';
const NOT_NEW = '(?!(?:um|uma|mais um|mais uma)\\s)';                 // "põe UM chat embaixo" adds; "põe o chat embaixo" moves

//[command, pattern]. Patterns run on the folded text; named groups are cut out of the ORIGINAL text. First match wins, so the
//specific forms come before the general ones.
const RULES = [
    // history
    ['undo', /^(?:desfaz|desfazer|desfaca|volta|voltar|volte)(?:\s+(?:atras|isso|tudo|(?:a|o)\s+ultim[ao](?:\s+(?:coisa|mudanca|acao|passo))?))?$/d],
    ['undo', /^(?:cancela|cancelar|cancele|tira|tire|anula|anule)\s+o\s+que\s+(?:eu\s+)?(?:fiz|acabei de fazer)$/d],
    ['redo', /^(?:refaz|refazer|refaca)(?:\s+(?:isso|tudo|a ultima.*))?$/d],
    ['redo', /^(?:de novo|traz de volta|devolve|reaplica|reaplique)\b.*(?:desfe|desfiz|ultim)/d],
    // about the workspace
    ['help', /^(?:(?:me\s+)?(?:mostra|diz|diga|lista|liste)\s+(?:os\s+)?comandos|quais comandos|que comandos|ajuda|o que (?:voce )?(?:pode|posso|sabe) (?:fazer|dizer))/d],
    ['describe', /^(?:(?:me\s+)?(?:diz|diga|fala|fale|mostra)\s+)?o que (?:tem|ha|esta|eu tenho)\s+(?:na tela|aberto|aqui|no workspace)/d],
    ['describe', /^(?:quais|que)\s+janelas/d],
    ['describe', /^(?:lista|liste|listar)\s+(?:as\s+)?janelas/d],
    ['stop-transcribing', /^(?:(?:para|parar|pare|desliga|desligue|interrompe|interrompa|encerra|encerre|cancela|cancele)\s+(?:de\s+transcrever|a\s+transcricao)|chega de transcrever|nao\s+transcrev[ae])/d],
    // content
    ['chat', /^(?:escreve|escreva|manda|mande|envia|envie|posta|poste|diz|diga|fala|fale)\s+(?:uma mensagem\s+)?(?:no|para o|pro)\s+chat\s*(?:[:,]|\bdizendo\b|\bfalando\b|\bque\b)?\s*(?<text>.+)$/d],
    ['note', /^(?:anota|anotar|anote|registra|registre)\b\s*(?:(?:nas|nas minhas)\s+(?:notas|anotacoes)\s*)?(?:ai\s+)?(?:que\s+)?[:,]?\s*(?<text>.+)$/d],
    ['note', /^(?:escreve|escreva)\s+nas\s+(?:notas|anotacoes)\s*(?:que\s+)?[:,]?\s*(?<text>.+)$/d],
    ['note', /^(?:toma|tome|faz|faca)\s+(?:uma\s+)?(?:nota|anotacao)\s*[:,]?\s*(?<text>.+)$/d],
    // composition
    ['rename', /^(?:renomeia|renomear|renomeie)\s+(?<what>.+?)\s+(?:para|como)\s+(?<name>.+)$/d],
    ['rename', /^(?:muda|mude|troca|troque|altera|altere)\s+o\s+(?:nome|titulo)\s+d[aeo]s?\s+(?<what>.+?)\s+(?:para|pra)\s+(?<name>.+)$/d],
    ['rename', /^(?:coloca|coloque|poe|ponha|define|defina)\s+o\s+(?:nome|titulo)\s+(?<name>.+?)\s+(?:na|no|nas|nos|em)\s+(?<what>.+)$/d],
    ['rename', /^(?:chama|chame)\s+(?<what>.+?)\s+de\s+(?<name>.+)$/d],
    ['rename', /^(?<what>.+?)\s+agora\s+se\s+chama[m]?\s+(?<name>.+)$/d],
    ['duplicate', /^(?:duplica|duplicar|duplique|copia|copie|clona|clone|repete|repita)\s+(?<what>.+)$/d],
    ['duplicate', /^(?:faz|faca|tira|tire|cria|crie)\s+uma\s+copia\s+d[aeo]s?\s+(?<what>.+)$/d],
    ['duplicate', /^(?:quero|queria|preciso de)\s+(?:outra|outro|mais um|mais uma)\s+(?:igual|identica|identico)(?:\s+(?:a|ao)\s+(?<what>.+))?$/d],
    ['disconnect', /^(?:remove|remova|tira|tire|corta|corte|desfaz|desfaca|solta|solte|apaga|apague)\s+(?:a\s+)?(?:ligacao|conexao)\s+(?:entre|d[aeo]s?)\s+(?<from>.+?)(?:\s+(?:e|com|ao?)\s+(?<to>.+))?$/d],
    ['disconnect', /^(?:desconecta|desconectar|desconecte|solta|solte)\s+(?<from>.+?)\s+(?:da|do|de|das|dos)\s+(?<to>.+)$/d],
    ['disconnect', /^(?:desconecta|desconectar|desconecte)\s+(?<from>.+)$/d],
    ['connect', /^(?:manda|mande|envia|envie|leva|leve)\s+(?:os dados|a saida|o resultado|as informacoes)\s+d[aeo]s?\s+(?<from>.+?)\s+para\s+(?<to>.+)$/d],
    ['connect', /^(?:faz|faca|deixa|deixe)\s+(?<from>.+?)\s+(?:alimentar|abastecer)\s+(?<to>.+)$/d],
    ['connect', /^(?:conecta|conectar|conecte|liga|ligue)\s+(?<from>.+?)\s+(?:na|no|em|a|ao|com|nas|nos)\s+(?<to>.+)$/d],
    // actions of a component: "mostra como grafo", "transforma isso num grafo", "quero ver como grafo"
    ['run-action', /^(?:mostra|mostrar|mostre|exibe|exiba|transforma|transforme|quero ver|me mostra|ver)\s+(?:.+?\s+)?(?:como|em forma de|num|em um|em)\s+(?<view>grafo|grafico|rede)$/d],
    // layout
    ['move', new RegExp(`^(?:${MOVE_VERBS})\\s+${NOT_NEW}(?<what>.+?)\\s+para\\s+(?:a\\s+|o\\s+)?(?:lado\\s+)?(?<side>${SIDES})$`, 'd')],
    ['move', new RegExp(`^(?:muda|mude)\\s+(?<what>.+?)\\s+de\\s+lugar\\s+para\\s+(?:a\\s+|o\\s+)?(?:lado\\s+)?(?<side>${SIDES})$`, 'd')],
    ['move', new RegExp(`^(?:${MOVE_VERBS})\\s+${NOT_NEW}(?<what>.+?)\\s+(?:em cima|embaixo|abaixo|acima)(?:\\s+d[aeo]s?\\s+(?<near>.+))?$`, 'd')],
    ['remove', /^(?:remove|remover|remova|apaga|apague|fecha|fechar|feche|exclui|exclua|elimina|elimine|deleta|delete|descarta|descarte|tira|tire)\s+(?<what>.+?)(?:\s+daqui)?$/d],
    ['remove', /^(?:some|sumir|suma)\s+com\s+(?<what>.+)$/d],
    ['remove', /^nao quero mais\s+(?<what>.+)$/d],
    ['focus', /^(?:me\s+)?(?:leva|leve)\s+(?:ate|para|pra)\s+(?<what>.+)$/d],
    ['focus', /^(?:foca|focar|foque|vai|va|ir|mostra|mostrar|mostre|abre|abra|seleciona|selecione|escolhe|escolha|olha|olhe|veja|ver|quero ver|queria ver)\s+(?:(?:em|no|na|nos|nas|para|pra|ate)\s+)(?<what>.+)$/d],
    ['focus', /^(?:mostra|mostrar|mostre|seleciona|selecione|olha|olhe|veja|ver|quero ver|queria ver)\s+(?<what>.+)$/d],
    // adding comes last: its verbs ("coloca", "abre", "faz") are the most general
    ['add', /^(?:adiciona|adicionar|adicione|abre|abra|abrir|cria|crie|criar|poe|ponha|coloca|coloque|bota|bote|inclui|inclua|insere|insira|traz|traga|faz|faca|me traz|me traga|me da|me de|quero|queria|preciso de|precisava de)\s+(?<what>.+)$/d],
];

//"... à direita da tabela", "... ao lado das notas", "... em cima da busca", "... à esquerda"
const PLACEMENTS = [
    { pattern: /\s+(?:a\s+)?(?<side>esquerda|direita)\s+d[aeo]s?\s+(?<near>.+)$/d, side: m => SIDE[m.groups.side] },
    { pattern: /\s+(?:ao lado|do lado)\s+d[aeo]s?\s+(?<near>.+)$/d, side: () => 'right' },
    { pattern: /\s+(?<side>em cima|acima|embaixo|abaixo)\s+d[aeo]s?\s+(?<near>.+)$/d, side: m => (/cima/.test(m.groups.side) ? 'top' : 'bottom') },
    { pattern: /\s+(?:a\s+)?(?<side>esquerda|direita)$/d, side: m => SIDE[m.groups.side] },
];

const cut = (text, match, name) => {
    const range = match.indices?.groups?.[name];
    return range ? clean(text.slice(range[0], range[1])) : undefined;
};

export class RulesInterpreter {
    interpret(text, ctx = {}) {
        const sentence = this.#prepare(text);
        if (!sentence) return null;
        //Titles/aliases of actions on screen ("mostrar como grafo") are commands of their own
        for (const title of ctx.actionTitles ?? []) if (fold(title).trim() === sentence.folded) return { command: 'run-action', args: { action: title }, confidence: 1 };
        for (const [command, pattern] of RULES) {
            const args = this.#match(command, pattern, sentence);
            if (args) return { command, args, confidence: 1 };
        }
        return null;
    }

    //Only the arguments of a command somebody ELSE already chose (a decision model): the same patterns, restricted to that command.
    //Returns {} when the command takes none or no pattern fits: the command then reports what is missing.
    extract(command, text, ctx = {}) {
        const sentence = this.#prepare(text);
        if (!sentence) return {};
        if (command === 'run-action') for (const title of ctx.actionTitles ?? []) if (fold(title).trim() === sentence.folded) return { action: title };
        for (const [name, pattern] of RULES) {
            if (name !== command) continue;
            const args = this.#match(name, pattern, sentence);
            if (args) return args;
        }
        return {};
    }

    //Interjections before ("ops, ...", "pode ...") and after ("... por favor") are cut off; the positions stay aligned with the original
    #prepare(text) {
        let original = clean(String(text ?? ''));
        if (!original) return null;
        let folded = fold(original);
        for (let lead = LEAD.exec(folded); lead; lead = LEAD.exec(folded)) { folded = folded.slice(lead[0].length); original = original.slice(lead[0].length); }
        const trail = TRAIL.exec(folded);
        if (trail) { folded = folded.slice(0, trail.index); original = original.slice(0, trail.index); }
        return folded ? { original, folded } : null;
    }

    #match(command, pattern, { original, folded }) {
        const match = pattern.exec(folded);
        if (!match) return null;
        const args = {};
        for (const name of Object.keys(match.groups ?? {})) {
            const value = cut(original, match, name);
            if (value) args[name] = name === 'side' ? SIDE[fold(value)] : value;
        }
        if (command === 'move' && !args.side) args.side = /cima/.test(folded) ? 'top' : 'bottom';
        if (command === 'add') Object.assign(args, placement(args.what));
        if (command === 'run-action') { args.action = 'mostrar como grafo'; delete args.view; }
        if (command === 'duplicate') args.what ??= 'esta janela';
        return args;
    }
}

//Splits "tabela à direita das notas" into { what: 'tabela', side: 'right', near: 'notas' }
function placement(what) {
    const folded = fold(what);
    for (const { pattern, side } of PLACEMENTS) {
        const match = pattern.exec(folded);
        if (!match) continue;
        const head = clean(what.slice(0, match.index));
        if (!head) continue;
        const result = { what: head, side: side(match) };
        const near = match.indices?.groups?.near;
        if (near) result.near = clean(what.slice(near[0], near[1]));
        return result;
    }
    return { what: clean(what) };
}
