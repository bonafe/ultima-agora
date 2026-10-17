# models/

Pesos dos modelos de transcrição (Whisper, rodando no navegador). **Fora do git** (dezenas de MB): baixe com

```
tools/baixar_modelo_whisper.py            # whisper-base (padrão, ~77 MB)
tools/baixar_modelo_whisper.py tiny       # ~41 MB, mais rápido e menos preciso
tools/baixar_modelo_whisper.py small      # ~250 MB, mais preciso, pesado
```

O app lê de `/models/whisper-<tamanho>/` na própria origem (nada de CDN: funciona sem internet, D-37).
