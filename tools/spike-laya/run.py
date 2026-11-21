import sys, json, time, statistics, numpy as np, onnxruntime as ort
from tokenizers import Tokenizer
from dataset import DATA, DESC
SHORT = {'add':'adicionar janela nova','remove':'remover fechar apagar','rename':'renomear mudar nome','duplicate':'duplicar copiar','move':'mover para um lado','focus':'ir para mostrar janela','connect':'conectar janelas','disconnect':'desconectar janelas','undo':'desfazer','redo':'refazer','run-action':'mostrar como grafo','note':'anotar nas notas','chat':'mensagem no chat','stop-transcribing':'parar de transcrever','describe':'o que há na tela','help':'ajuda comandos','none':'conversa, não é comando'}

def load(folder, onnx):
    tok = Tokenizer.from_file(f'{folder}/tokenizer.json')
    cfg = json.load(open(f'{folder}/tokenizer_config.json'))
    ids = {k: tok.token_to_id(cfg[k]) for k in ('cls_token','sep_token','mask_token')}
    rl = json.load(open(f'{folder}/rl_agent_config.json'))
    opts = ort.SessionOptions(); opts.intra_op_num_threads = 6
    t = time.time(); sess = ort.InferenceSession(f'{folder}/{onnx}', opts, providers=['CPUExecutionProvider'])
    return tok, ids, rl, sess, time.time() - t

def build(tok, ids, rl, state, instructions, options, lang_head=True):
    enc = lambda s: tok.encode(s, add_special_tokens=False).ids
    head = enc(f'choice question: {instructions}')
    opt_ids = [[ids['mask_token']] + enc(' ' + o)[:48] for o in options]
    budget = rl['head_max_len'] - sum(len(o) for o in opt_ids)
    if budget < 16:
        per = max(4, (rl['head_max_len'] - 16) // len(opt_ids)); opt_ids = [o[:per] for o in opt_ids]
        budget = rl['head_max_len'] - sum(len(o) for o in opt_ids)
    head = head[:max(8, budget)]
    seq = [ids['cls_token']] + head + [ids['sep_token']]
    markers = []
    for o in opt_ids: markers.append(len(seq)); seq += o
    seq.append(ids['sep_token'])
    st = enc(state)[:max(0, rl['max_len'] - len(seq) - 1)]
    seq += st + [ids['sep_token']]
    return seq, markers

def predict(model, state, labels, options, temp):
    tok, ids, rl, sess, _ = model
    seq, markers = build(tok, ids, rl, state, 'Qual comando o usuário deu ao workspace?', options)
    feed = {'input_ids': np.array([seq], dtype=np.int64), 'attention_mask': np.ones((1, len(seq)), dtype=np.int64),
            'marker_pos': np.array([markers], dtype=np.int64), 'marker_mask': np.ones((1, len(markers)), dtype=bool), 'qtype': np.array([0], dtype=np.int64)}
    t = time.time(); logits = sess.run(['logits'], feed)[0][0]; ms = (time.time() - t) * 1000
    z = logits / temp; p = np.exp(z - z.max()); p /= p.sum()
    return p, ms

def evaluate(name, folder, onnx, temp, style):
    model = load(folder, onnx)
    labels = list(DESC)
    options = [f'{k}: {DESC[k]}' if style == 'desc' else k if style == 'key' else f'{k}: {SHORT[k]}' for k in labels]
    rows = [(s, c) for c, ss in DATA.items() for s in ss]
    predict(model, 'teste', labels, options, temp)                         # warm-up
    hit = top2 = 0; lat = []; conf_ok = []; conf_bad = []; wrong = []; per = {}
    for s, c in rows:
        p, ms = predict(model, s, labels, options, temp); lat.append(ms)
        order = np.argsort(-p); guess = labels[order[0]]
        ok = guess == c; hit += ok; top2 += c in (labels[order[0]], labels[order[1]])
        (conf_ok if ok else conf_bad).append(float(p[order[0]]))
        per.setdefault(c, [0, 0]); per[c][0] += ok; per[c][1] += 1
        if not ok: wrong.append((s, c, guess, round(float(p[order[0]]), 2)))
    n = len(rows)
    print(f'\n== {name} [{style}] load {model[4]:.1f}s | {n} frases | top1 {hit/n:.1%} top2 {top2/n:.1%} | latência mediana {statistics.median(lat):.0f} ms p95 {sorted(lat)[int(.95*n)]:.0f} ms')
    print('   confiança média: certas %.2f / erradas %.2f' % (np.mean(conf_ok), np.mean(conf_bad) if conf_bad else 0))
    for thr in (0.5, 0.7, 0.9):
        kept = [(ok) for ok in [True]*len(conf_ok)]; a = sum(1 for x in conf_ok if x >= thr); b = sum(1 for x in conf_bad if x >= thr)
        print(f'   limiar {thr}: executa {a+b}/{n} ({(a+b)/n:.0%}), acerta {a/(a+b) if a+b else 0:.1%}')
    print('   por comando:', ', '.join(f'{c} {v[0]}/{v[1]}' for c, v in per.items()))
    for w in wrong[:25]: print('   ERRO', w)

if __name__ == '__main__':
    which = sys.argv[1:] or ['en', 'ml']
    for style in ('key','short'):
        if 'en' in which: evaluate('laya en int4', 'en', 'model_int4.onnx', 1.0, style)
        if 'ml' in which: evaluate('laya multilingual int8', 'multilingual', 'model_int8.onnx', 1.0, style)
