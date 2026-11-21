//The built-in commands (v1). Arguments arrive as the words the person said ("a tabela de notícias"); the commands resolve them
//against what is on screen (resolve.js), so an interpreter only has to pick the command and cut the phrases out.
//Generic on purpose: no domain terms (the application's own actions come in through the components' manifests, `run-action`).
import { CommandRegistry } from './registry.js';
import { normalize, resolveInstance, resolveType } from './resolve.js';

const SIDES = ['left', 'right', 'top', 'bottom'];
const SIDE_WORDS = { left: 'à esquerda', right: 'à direita', top: 'em cima', bottom: 'embaixo' };
const VIA = 'voice';

//Finds the one instance a phrase names, or throws a sentence the person can answer ("qual delas?")
function pick(workspace, phrase, what = 'janela') {
    const found = resolveInstance(workspace.describe(), workspace.registry, phrase);
    if (found.id) return found.id;
    if (found.ambiguous) throw new Error(`Qual ${what}? ${found.ambiguous.map(item => `"${item.label}"`).join(' ou ')}.`);
    throw new Error(`Não achei ${what} "${phrase}".`);
}
const labelOf = (workspace, id) => workspace.instance(id)?.label ?? id;

export function createCommandRegistry() {
    const registry = new CommandRegistry();

    registry.register({
        name: 'add', title: 'Adicionar janela', access: 'compose', phrases: ['adiciona uma tabela', 'adiciona notas à direita da tabela'],
        params: { what: { required: true, title: 'o que adicionar' } },
        run(workspace, { what, near, side }) {
            const [manifest] = resolveType(workspace.registry, what);
            if (!manifest) throw new Error(`Não conheço "${what}" para adicionar.`);
            if (side && !SIDES.includes(side)) throw new Error(`Lado desconhecido: ${side}`);
            const target = {};
            if (near) { target.panelId = workspace.layout.findPanelOf(pick(workspace, near)); target.side = side ?? 'right'; }
            else if (side) { target.root = true; target.side = side; }
            const id = workspace.addInstance(manifest.name, { target, createdVia: VIA });
            workspace.setFocus(id);
            return { message: `Adicionei ${manifest.title}.`, id };
        },
    });

    registry.register({
        name: 'remove', title: 'Remover janela', access: 'compose', destructive: true, phrases: ['remove as notas'],
        params: { what: { required: true, title: 'qual janela remover' } },
        confirm: (args, workspace) => `Remover "${labelOf(workspace, pick(workspace, args.what))}"?`,
        run(workspace, { what }) {
            const id = pick(workspace, what);
            const label = labelOf(workspace, id);
            workspace.removeInstance(id);
            return `Removi "${label}". Diga "desfaz" para voltar.`;
        },
    });

    registry.register({
        name: 'rename', title: 'Renomear janela', access: 'compose', phrases: ['renomeia a tabela para Clientes'],
        params: { what: { required: true, title: 'qual janela' }, name: { required: true, title: 'o novo nome' } },
        run(workspace, { what, name }) {
            const id = pick(workspace, what);
            workspace.setLabel(id, String(name).trim());
            return `Agora se chama "${String(name).trim()}".`;
        },
    });

    registry.register({
        name: 'duplicate', title: 'Duplicar janela', access: 'compose', phrases: ['duplica esta janela'],
        params: { what: { required: true, title: 'qual janela' } },
        run(workspace, { what }) {
            const id = workspace.duplicateInstance(pick(workspace, what), { createdVia: VIA });
            workspace.setFocus(id);
            return { message: 'Duplicado.', id };
        },
    });

    registry.register({
        name: 'focus', title: 'Ir para a janela', access: 'any', phrases: ['foca nas notas', 'vai para a tabela'],
        params: { what: { required: true, title: 'qual janela' } },
        run(workspace, { what }) {
            const id = pick(workspace, what);
            workspace.setFocus(id);
            return `Em "${labelOf(workspace, id)}".`;
        },
    });

    registry.register({
        name: 'move', title: 'Mover janela', access: 'compose', phrases: ['move a tabela para a esquerda', 'põe as notas embaixo'],
        params: { what: { required: true, title: 'qual janela' }, side: { required: true, title: 'para que lado' } },
        run(workspace, { what, side, near }) {
            if (!SIDES.includes(side)) throw new Error(`Lado desconhecido: ${side}`);
            const id = pick(workspace, what);
            const target = near ? { panelId: workspace.layout.findPanelOf(pick(workspace, near)), side } : { root: true, side };
            if (target.panelId && target.panelId === workspace.layout.findPanelOf(id) && workspace.layout.panel(target.panelId).tabs.length === 1) throw new Error('Ela já é a única nesse painel.');
            workspace.moveInstance(id, target);
            return `Movi "${labelOf(workspace, id)}" ${SIDE_WORDS[side]}.`;
        },
    });

    //Connects what `from` emits to what `to` accepts: the first output/input pair the types allow (R-CONN-1)
    const pairOf = (workspace, from, to) => {
        const source = workspace.registry.getManifest(workspace.instance(from).type);
        const target = workspace.registry.getManifest(workspace.instance(to).type);
        for (const output of Object.keys(source.outputs ?? {})) for (const input of Object.keys(target.inputs ?? {})) {
            if (!workspace.bus.check({ instance: from, port: output }, { instance: to, port: input }).reason) return { output, input };
        }
        return null;
    };

    registry.register({
        name: 'connect', title: 'Conectar janelas', access: 'compose', phrases: ['conecta a busca na tabela'],
        params: { from: { required: true, title: 'a origem' }, to: { required: true, title: 'o destino' } },
        run(workspace, { from, to }) {
            const source = pick(workspace, from, 'origem'); const target = pick(workspace, to, 'destino');
            const pair = pairOf(workspace, source, target);
            if (!pair) throw new Error(`"${labelOf(workspace, source)}" não tem nada que "${labelOf(workspace, target)}" aceite.`);
            workspace.bus.connect({ instance: source, port: pair.output }, { instance: target, port: pair.input }, { createdVia: VIA, replace: true });
            return `Conectei "${labelOf(workspace, source)}" em "${labelOf(workspace, target)}".`;
        },
    });

    //Disconnects two windows (either direction), or every connection of one window when only it is named
    const connectionsBetween = (workspace, a, b) => workspace.bus.list().filter(c => b
        ? (c.from.instance === a && c.to.instance === b) || (c.from.instance === b && c.to.instance === a)
        : c.from.instance === a || c.to.instance === a);

    registry.register({
        name: 'disconnect', title: 'Desconectar janelas', access: 'compose', destructive: true, phrases: ['desconecta a busca da tabela'],
        params: { from: { required: true, title: 'a origem' } },
        confirm: (args, workspace) => `Desconectar "${labelOf(workspace, pick(workspace, args.from, 'origem'))}"${args.to ? ` de "${labelOf(workspace, pick(workspace, args.to, 'destino'))}"` : ''}?`,
        run(workspace, { from, to }) {
            const found = connectionsBetween(workspace, pick(workspace, from, 'origem'), to ? pick(workspace, to, 'destino') : null);
            if (!found.length) throw new Error(to ? 'Elas não estão conectadas.' : 'Essa janela não tem conexões.');
            for (const connection of found) workspace.bus.disconnect(connection.id);
            return found.length === 1 ? 'Desconectei.' : `Desfiz ${found.length} conexões.`;
        },
    });

    registry.register({
        name: 'undo', title: 'Desfazer', access: 'compose', phrases: ['desfaz'],
        run(workspace) { if (!workspace.canUndo) throw new Error('Não há o que desfazer.'); workspace.undo(); return 'Desfeito.'; },
    });
    registry.register({
        name: 'redo', title: 'Refazer', access: 'compose', phrases: ['refaz'],
        run(workspace) { if (!workspace.canRedo) throw new Error('Não há o que refazer.'); workspace.redo(); return 'Refeito.'; },
    });

    //An action a component declares in its manifest, by its title or an alias ("mostra como grafo" -> ultima-table showGraph)
    registry.register({
        name: 'run-action', title: 'Executar ação de uma janela', access: 'compose', phrases: ['mostra como grafo'],
        params: { action: { required: true, title: 'qual ação' } },
        async run(workspace, { action, what }) {
            const wanted = normalize(action);
            const description = workspace.describe();
            const hosts = what ? [pick(workspace, what)] : [description.focus, ...description.instances.map(item => item.id)].filter(Boolean);
            for (const id of hosts) {
                const actions = workspace.registry.getManifest(workspace.instance(id).type)?.actions ?? {};
                const name = Object.keys(actions).find(key => normalize(key) === wanted || normalize(actions[key].title) === wanted || (actions[key].aliases ?? []).some(alias => normalize(alias) === wanted));
                if (!name) continue;
                const outcome = await workspace.invokeAction(id, name, {});
                return { message: `${actions[name].title}.`, ...outcome };
            }
            throw new Error(`Nenhuma janela tem a ação "${action}".`);
        },
    });

    registry.register({
        name: 'note', title: 'Anotar', access: 'content', phrases: ['anota: comprar passagens'],
        params: { text: { required: true, title: 'o que anotar' } },
        run(workspace, { text, what }) {
            const description = workspace.describe();
            const isNotes = id => workspace.instance(id)?.type === 'ultima-notes';
            const id = what ? pick(workspace, what) : isNotes(description.focus) ? description.focus : description.instances.find(item => item.type === 'ultima-notes')?.id;
            if (!id || !isNotes(id)) throw new Error('Não há janela de notas aberta. Diga "adiciona notas".');
            const shared = workspace.sharedText(id);
            const current = shared.getText();
            shared.setText(`${current}${current && !current.endsWith('\n') ? '\n' : ''}${String(text).trim()}\n`);
            return `Anotei em "${labelOf(workspace, id)}".`;
        },
    });

    registry.register({
        name: 'chat', title: 'Escrever no chat', access: 'content', phrases: ['escreve no chat: já volto'],
        params: { text: { required: true, title: 'a mensagem' } },
        run(workspace, { text }) {
            if (!workspace.chat) throw new Error('Este workspace não tem chat.');
            workspace.chat.send(String(text).trim());
            return 'Enviei no chat.';
        },
    });

    registry.register({
        name: 'stop-transcribing', title: 'Parar de transcrever', access: 'any', phrases: ['para de transcrever'],
        run(workspace) { workspace.transcriber?.disable(); return 'Parei de transcrever.'; },
    });

    registry.register({
        name: 'describe', title: 'O que há na tela', access: 'any', phrases: ['o que tem na tela?'],
        run(workspace) {
            const { instances } = workspace.describe();
            if (!instances.length) return 'O workspace está vazio.';
            return `Na tela: ${instances.map(item => item.label).join(', ')}.`;
        },
    });

    registry.register({
        name: 'help', title: 'Quais comandos', access: 'any', phrases: ['quais comandos?'],
        run() { return { message: 'Comandos disponíveis.', commands: registry.list().filter(c => c.phrases.length).map(c => ({ name: c.name, title: c.title, example: c.phrases[0] })) }; },
    });

    return registry;
}
