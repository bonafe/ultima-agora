//How a "choice" question becomes the tensors Laya expects (a port of laya.common.build_sequence, see the model card):
//
//  [CLS] choice question: <question> [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] <state> [SEP]
//
//Pure functions (no ONNX, no DOM): testable on their own. `config` is the checkpoint's rl_agent_config.json.

//option: text; the head (question + options) has its own token budget (config.head_max_len): options are trimmed to fit it.
export function buildChoiceInput({ encode, special, config, question, options, state }) {
    const maxOption = 48;
    let optionIds = options.map(text => [special.mask, ...encode(` ${text}`).slice(0, maxOption)]);
    let budget = config.head_max_len - optionIds.reduce((sum, ids) => sum + ids.length, 0);
    if (budget < 16) {                                                    // too many options for the budget: shorten each one
        const each = Math.max(4, Math.floor((config.head_max_len - 16) / optionIds.length));
        optionIds = optionIds.map(ids => ids.slice(0, each));
        budget = config.head_max_len - optionIds.reduce((sum, ids) => sum + ids.length, 0);
    }
    const head = encode(`choice question: ${question}`).slice(0, Math.max(8, budget));
    const sequence = [special.cls, ...head, special.sep];
    const markerPos = [];
    for (const ids of optionIds) { markerPos.push(sequence.length); sequence.push(...ids); }
    sequence.push(special.sep);
    sequence.push(...encode(state).slice(0, Math.max(0, config.max_len - sequence.length - 1)), special.sep);
    return { inputIds: sequence, markerPos };
}

//The checkpoint ships fitted temperatures per (type, number of options); clamped to [0.5, 5] as its model card says
export function temperatureFor(config, optionCount) {
    const bucket = optionCount <= 2 ? 'choice:2' : optionCount <= 5 ? 'choice:3-5' : optionCount <= 10 ? 'choice:6-10' : 'choice:11+';
    const fitted = config.temperature_by_options?.[bucket] ?? config.temperature?.[0] ?? 1;
    return Math.min(5, Math.max(0.5, fitted));
}

export function softmax(logits, temperature = 1) {
    const scaled = Array.from(logits, value => value / temperature);
    const top = Math.max(...scaled);
    const exp = scaled.map(value => Math.exp(value - top));
    const sum = exp.reduce((a, b) => a + b, 0);
    return exp.map(value => value / sum);
}
