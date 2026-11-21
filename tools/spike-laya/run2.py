import sys, time, statistics, numpy as np
from run import load, build, DATA
G = {
 'composition': ({'add':'add a new window (table, notes, graph, chat)','remove':'remove, close or delete a window','rename':'rename a window','duplicate':'duplicate or copy a window','connect':'connect two windows','disconnect':'disconnect two windows'}),
 'layout': ({'move':'move a window to the left, right, top or bottom','focus':'go to or show an existing window','describe':'say what is on screen','help':'help, list commands'}),
 'history': ({'undo':'undo the last change','redo':'redo what was undone','run-action':'show data as a graph'}),
 'content': ({'note':'write a note in the notes window','chat':'send a message in the chat','stop-transcribing':'stop transcribing speech'}),
}
GROUP_OPTS = {'composition':'composition: add, remove, rename, duplicate, connect windows','layout':'layout: move, go to, show or list windows, help','history':'history: undo, redo, show as graph','content':'content: write a note, send a chat message, stop transcription','none':'none: ordinary conversation, not a command'}
OF = {c: g for g, cs in G.items() for c in cs}; OF['none'] = 'none'
def ask(model, state, ins, opts):
    tok, ids, rl, sess, _ = model
    seq, mk = build(tok, ids, rl, state, ins, opts)
    feed = {'input_ids': np.array([seq]), 'attention_mask': np.ones((1,len(seq)),dtype=np.int64), 'marker_pos': np.array([mk]), 'marker_mask': np.ones((1,len(mk)),dtype=bool), 'qtype': np.array([0])}
    t = time.time(); lg = sess.run(['logits'], feed)[0][0]; ms = (time.time()-t)*1000
    z = lg/1.76; p = np.exp(z-z.max()); return p/p.sum(), ms
model = load('en', 'model_int4.onnx')
gkeys = list(GROUP_OPTS); hit_g = hit = 0; lat = []; n = 0; wrong = []; confs = []
for c, ss in DATA.items():
    for s in ss:
        n += 1
        p, m1 = ask(model, s, 'What kind of request is this?', [GROUP_OPTS[k] for k in gkeys]); g = gkeys[p.argmax()]
        tot = m1; guess = 'none'; conf = float(p.max())
        if g != 'none':
            ck = list(G[g]); q, m2 = ask(model, s, f'Which {g} command?', [f'{k}: {G[g][k]}' for k in ck]); guess = ck[q.argmax()]; tot += m2; conf *= float(q.max())
        lat.append(tot); hit_g += g == OF[c]; ok = guess == c; hit += ok; confs.append((conf, ok))
        if not ok: wrong.append((s, c, guess, round(conf, 2)))
print(f'2 estágios: grupo certo {hit_g/n:.1%} | comando certo {hit/n:.1%} | latência mediana {statistics.median(lat):.0f} ms')
for thr in (0.3, 0.5, 0.7):
    k = [ok for cf, ok in confs if cf >= thr]; print(f'  limiar {thr}: executa {len(k)}/{n}, acerta {sum(k)/max(1,len(k)):.1%}')
for w in wrong[:40]: print('  ERRO', w)
