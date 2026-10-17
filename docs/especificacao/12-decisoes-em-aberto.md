# 12. Decisões

Decididas em 2026-10-04: **D-02, D-06, D-07, D-23**. Decididas em 2026-10-16: **D-36, D-37, D-38**. Decididas em 2026-10-17: **D-39**.

Cada item traz **recomendação** da especificação. As marcadas com ★ bloqueiam M0/M1.

| # | Decisão | Opções | Recomendação |
|---|---|---|---|
| ★ **D-01** | Nome/escopo do repositório e do pacote | `ultima-agora` com `vendor/ultima`; ou monorepo com o UltimaJS | Repositório próprio, UltimaJS **vendorizado** (como o `espaco`) |
| ★ **D-02** ✅ | Como estender o UltimaJS | (a) Agora sozinho; (b) mixins no UltimaJS | **DECIDIDO (b):** o UltimaJS ganha um mecanismo genérico e retrocompatível de mixins; as mixins concretas ficam no Agora (ver 03.1) |
| **D-03** | Formato do manifesto | JSON; YAML; objeto JS | JSON em arquivo `.manifest.json` (sem build, lido sem executar código) |
| ★ **D-04** | Congelamento do contrato `AgoraComponent` | Congelar já; congelar após componentes reais | Contrato versionado, congelar ao fim do M2 |
| **D-05** | Onde roda o tempo real | Django Channels (ASGI) existente; serviço próprio `agora-sync` | Serviço próprio (escala e ciclo de vida distintos) |
| ★ **D-06** ✅ | Bibliotecas sem build (Yjs, LiveKit client, whiteboard) | Bundle ESM copiado para `vendor/`; usar bundler só para gerar o vendor | **DECIDIDO:** bundle ESM gerado uma vez e copiado para `vendor/` com versão+hash; runtime sem build |
| ★ **D-07** ✅ | Editor de notas | Editor mínimo próprio (`Y.Text` + contenteditable); biblioteca rica com bundle ESM | **DECIDIDO:** mínimo próprio sobre `Y.Text` no MVP; troca futura via `SharedText` |
| **D-08** | Modelo de layout do MVP | Grid; docking em árvore com abas | Docking em árvore com abas (ver D-23) |
| **D-09** | Migração de esquema do documento | `schemaVersion` + migrações no cliente; no servidor | Migração no servidor em versão MAJOR; clientes antigos entram em leitura |
| **D-10** | Limites do documento | tamanho total, por instância, nº de instâncias | Definir após o protótipo; começar com 5 MB total, 200 instâncias |
| **D-11** | Retenção do chat | Indefinida; configurável | Configurável por workspace; padrão indefinido |
| **D-12** | Importar do `espaco` | Importador; ignorar | Fase posterior, sob demanda |
| **D-13** | Componentes remotos/de terceiros | SRI+sandbox; fora de escopo | Fora do MVP e da F2 |
| **D-14** | Seleção compartilhada | Local; compartilhada; fixada | Local + presença como padrão; "fixada" por opção |
| **D-15** | Ciclos no grafo de conexões | Proibir; permitir com guarda | Proibir no MVP |
| **D-16** | Cache de dados classificados no cliente | Nunca; por política | Nunca para `restrito`+; por política abaixo disso |
| **D-17** | Cifra do documento local | Sem cifra; cifra com chave do usuário | Fora do MVP; decidir com os perfis de implantação isolados |
| **D-18** | Autoria confiável | Por conexão (servidor carimba); assinatura por operação | Por conexão no MVP. Assinatura por operação só se vier federação |
| **D-19** | Permissão por componente | Sub-documentos por instância sensível | Pós-MVP; a estrutura `content[instanceId]` já permite |
| **D-20** | Emissão de credenciais de conferência | Token do hospedeiro; do `agora-sync` | Hospedeiro, após verificar papel |
| **D-21** | `ultima-browser` | Iframe sandbox; fora | Fora do MVP; avaliar segurança antes |
| **D-22** | Quem pode adicionar componentes | Só `editor`+; também `participant` | Só `editor`+ (configurável depois) |
| **D-23** ✅ | Layout: grid × árvore | — | **DECIDIDO:** árvore de painéis + abas no MVP; grid para dashboard em F3 |
| **D-24** | Agente lê notas/chat? | Sempre; opt-in por instância | Opt-in por instância |
| **D-25** | Quem monta o contexto do agente | Cliente; servidor | Servidor (a partir de snapshot autenticado) |
| **D-26** | Onde executam as ferramentas do agente | Servidor; cliente do humano | Servidor via camada de operações; o cliente apenas apresenta |
| **D-27** | Modo de autonomia do agente | Proposta; automático | Proposta por padrão; automático opt-in por workspace |
| **D-28** | Agente com participantes de permissões distintas | Interseção; resposta por pessoa | Interseção por padrão; aprofundar no M4/F2 |
| **D-29** | Persistência do documento CRDT | Tabela Postgres de updates; arquivo/Garage | Postgres (updates + snapshots), reaproveita backup do IA |
| **D-30** | Chat para `viewer` | Leitura; escrita | Leitura |
| **D-31** | Links anônimos | Permitir; proibir | Proibir no MVP |
| **D-32** | Rebaixar classificação do workspace | Livre; exige confirmação e varredura | Exigir confirmação e auditar; só o dono |
| **D-33** | Federação de workspaces | Fora; usando eventos assinados (ADR 010) | Fora até haver caso de uso |
| **D-34** | Licença | MIT; Apache-2.0; igual ao UltimaJS | Alinhar à licença do UltimaJS (`LICENSE` do `ultima`) |
| **D-35** | Localização dos ADRs do Agora | Neste repositório; no IA | ADRs do Agora **aqui** (`docs/decisoes/`); ADRs de integração no IA |
| **D-36** ✅ | Provider de conferência inicial | LiveKit (SFU) já; WebRTC em malha (P2P) primeiro | **DECIDIDO:** `MeshProvider` com `RTCPeerConnection` nativo e sinalização pelo `agora-sync`, atrás do `ConferenceProvider`; LiveKit entra depois pelo mesmo contrato quando os grupos crescerem. Tela compartilhada: segunda etapa |
| **D-37** ✅ | Motor da transcrição da chamada | Web Speech API (nuvem do navegador); Whisper no navegador; STT no servidor (faster-whisper) | **DECIDIDO:** Whisper no navegador (transformers.js + ONNX Runtime Web, CPU/WASM), vendorizado em `vendor/whisper/`; pesos em `models/` servidos pela própria origem. Cada pessoa é transcrita no próprio dispositivo e só o texto vai ao workspace (6.2.1). STT no servidor fica como provider futuro, atrás do mesmo contrato |
| **D-38** ✅ | Site público do Ultima: Ágora Digital | Site separado (outro repositório/gerador); páginas estáticas no próprio repositório; o próprio app como site | **DECIDIDO:** páginas estáticas no próprio repositório, publicáveis no GitHub Pages, sem build: `index.html` (apresentação em atos, fundo de canvas guiado pela rolagem) e `hospedar.html` (guia para quem não programa). O app passa a `/app.html`. Fase seguinte: o site termina num workspace de boas-vindas montado com os componentes reais (o site usa o próprio framework), e as vistas flutuantes/multi-janela/multi-dispositivo entram como evolução da UI (07) |
| **D-39** ✅ | Janelas destacadas: como o binding sobrevive em outra janela do navegador | (a) a outra janela carrega o app e sincroniza pelo documento/BroadcastChannel; (b) o mesmo elemento vivo é movido para o DOM da outra janela | **DECIDIDO (b):** o componente roda no mesmo contexto JS e só é desenhado noutro documento, então portas, barramento e serviços continuam ligados sem protocolo. Limite: a janela principal precisa ficar aberta. Destacar é visão local (R-LAY-9). **Próximo passo (celular como controle):** não cabe em (b); exigirá um canal entre dispositivos do mesmo usuário (a especificar) |
