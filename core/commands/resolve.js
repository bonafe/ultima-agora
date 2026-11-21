//Turns the words of a command into things of the workspace: "a tabela de notícias" -> an instance, "notas" -> a component type.
//Pure functions over `workspace.describe()` and the registry: no DOM, no domain terms.

//Lowercase, no accents, no punctuation, single spaces: what the person said and what the label says compare equal
export const normalize = text => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const ARTICLES = new Set(['a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'do', 'das', 'dos', 'essa', 'esse', 'esta', 'este', 'aquela', 'aquele', 'janela', 'painel', 'componente']);
const ORDINALS = { primeira: 0, primeiro: 0, segunda: 1, segundo: 1, terceira: 2, terceiro: 2, quarta: 3, quarto: 3, quinta: 4, quinto: 4, ultima: -1, ultimo: -1 };
const HERE = new Set(['esta', 'este', 'essa', 'esse', 'atual', 'aqui', 'foco']);

const words = text => normalize(text).split(' ').filter(Boolean);
const content = text => words(text).filter(word => !ARTICLES.has(word));
const singular = word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);

//Words people use for each component of the generic catalog, besides its title and name (manifest `aliases` add more)
const TYPE_WORDS = {
    'ultima-text': ['texto'], 'ultima-notes': ['nota', 'anotacao', 'anotacoes', 'caderno'], 'ultima-table': ['tabela', 'planilha'],
    'ultima-graph': ['grafo', 'grafico', 'rede'], 'ultima-chat': ['chat', 'conversa', 'mensagens'], 'ultima-conference': ['chamada', 'conferencia', 'video'],
    'ultima-transcript': ['transcricao', 'legenda'], 'ultima-recordings': ['gravacao', 'gravacoes'],
};

//The component types a phrase may mean, best first. Empty when nothing matches.
export function resolveType(registry, phrase) {
    const wanted = content(phrase).map(singular);
    if (!wanted.length) return [];
    const scored = registry.list().map(manifest => {
        const names = [...content(manifest.title), ...content(manifest.name.replace(/^ultima-/, '')), ...(TYPE_WORDS[manifest.name] ?? []), ...(manifest.aliases ?? []).flatMap(content)].map(singular);
        const hits = wanted.filter(word => names.includes(word)).length;
        return { manifest, hits };
    }).filter(item => item.hits > 0);
    return scored.sort((a, b) => b.hits - a.hits || a.manifest.title.localeCompare(b.manifest.title)).map(item => item.manifest);
}

//One instance of `description` (workspace.describe()) that the phrase names.
//  -> { id }                      found
//  -> { ambiguous: [{id,label}] } several fit; the caller asks
//  -> { missing: true }           none fit
export function resolveInstance(description, registry, phrase) {
    const all = description.instances;
    if (!all.length) return { missing: true };
    const spoken = words(phrase);
    const rest = content(phrase);
    if (spoken.some(word => HERE.has(word)) && !rest.length && description.focus) return { id: description.focus };
    if (!rest.length && description.focus) return { id: description.focus };

    const ordinal = spoken.find(word => word in ORDINALS);
    const wanted = rest.filter(word => !(word in ORDINALS)).map(singular);
    let candidates = all.filter(item => {
        const manifest = registry.getManifest(item.type);
        const names = [...content(item.label), ...content(manifest?.title ?? ''), ...content(item.type.replace(/^ultima-/, '')), ...(TYPE_WORDS[item.type] ?? []), ...(manifest?.aliases ?? []).flatMap(content)].map(singular);
        return wanted.every(word => names.includes(word));
    });
    if (ordinal !== undefined) {
        const index = ORDINALS[ordinal];
        const pool = candidates.length || wanted.length ? candidates : all;
        const pick = index < 0 ? pool.at(-1) : pool[index];
        return pick ? { id: pick.id } : { missing: true };
    }
    if (candidates.length === 1) return { id: candidates[0].id };
    if (!candidates.length) return { missing: true };
    const exact = candidates.filter(item => normalize(item.label) === normalize(phrase));       //a full label beats a partial one
    if (exact.length === 1) return { id: exact[0].id };
    return { ambiguous: candidates.map(({ id, label }) => ({ id, label })) };
}
