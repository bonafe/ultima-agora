import numpy as np
from run import load, build
for folder, onnx in (('en','model_int4.onnx'),('multilingual','model_int8.onnx')):
    tok, ids, rl, sess, _ = load(folder, onnx)
    cases = [("Hi, we were billed twice for March. Please refund the duplicate today.", 'billing'),
             ("The server is down and I get error 500 on every page.", 'technical'),
             ("Do you have a favorite color?", 'other'),
             ("Fui cobrado duas vezes em março, preciso do reembolso.", 'billing'),
             ("O sistema caiu e aparece erro 500.", 'technical')]
    opts = ['billing: invoices, payments, refunds', 'technical: bugs, outages, system errors', 'other: everything else']
    for state, want in cases:
        seq, markers = build(tok, ids, rl, state, 'Which department should handle this?', opts)
        feed = {'input_ids': np.array([seq]), 'attention_mask': np.ones((1,len(seq)),dtype=np.int64), 'marker_pos': np.array([markers]), 'marker_mask': np.ones((1,len(markers)),dtype=bool), 'qtype': np.array([0])}
        lg = sess.run(['logits'], feed)[0][0]; p = np.exp(lg-lg.max()); p/=p.sum()
        print(folder, want, '->', ['billing','technical','other'][p.argmax()], np.round(p,2))
