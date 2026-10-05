# 11. Roadmap, MVP e critérios de aceite

O objetivo do MVP é **validar o paradigma**: componentes reutilizáveis formando um workspace compartilhado e persistente. Nada além disso.

## 11.1 Estratégia: fatias verticais, e não camadas

Em vez de construir "todo o core, depois toda a colaboração, depois o domínio", cada marco entrega uma fatia **utilizável** e valida uma hipótese de arquitetura.

| Marco | Entrega | Hipótese validada |
|---|---|---|
| **M0 — Fundação** | Repositório, `vendor/ultima`, **protótipo do mecanismo de mixins no UltimaJS (D-02)**, harness de testes no padrão UltimaJS, `AgoraComponent` mínimo, `MemoryStateStore`, hospedeiro dev | O Agora roda sem build sobre o UltimaJS sem alterá-lo |
| **M1 — Workspace local** | Shell, paleta, registro de manifestos, layout (docking+abas), instâncias, inspetor, `ultima-text`, `ultima-notes` (local), persistência IndexedDB | Compor e reabrir um workspace |
| **M2 — Barramento** | Tipos, portas, conexões automáticas e manuais, ações com `create`, sugestão de visualizações; `ultima-table`, `ultima-graph` | Interoperabilidade tipada entre componentes |
| **M3 — Colaboração** | `agora-sync`, `YjsStateStore`, presença, notas compartilhadas, papéis, undo | Dois usuários no mesmo workspace |
| **M4 — Domínio IA** | Adaptador de hospedeiro, `ia-search/entity/table/graph/news`, classificação, eventos | O IA funciona como aplicação sobre o Agora |
| **M5 — Comunicação e fecho** | Chat básico, workspace de referência, testes de aceite, documentação, ADRs no IA | MVP completo |

M3 pode começar em paralelo a M2 depois de M1, pois depende só do `StateStore`.

## 11.2 Escopo do MVP (proposta, seção 52)

**Núcleo:** `Workspace`, `ComponentRegistry`, `ComponentInstance`, `Palette`, `Layout`, `Inspector`, `Component Bus` (tipado), persistência.
**Colaboração:** sincronização do workspace, presença, notas colaborativas.
**Inteligência Aberta:** `ia-entity`, `ia-search`, `ia-table`, `ia-graph`, `ia-news`.
**Comunicação:** chat básico.

Adicionados por esta especificação como parte do MVP, por serem pré-requisitos e não extras:
manifestos validados, papéis no servidor, limites de tamanho, undo/redo por usuário, suíte de contrato, classificação do workspace, auditoria mínima.

**Explicitamente fora do MVP:** conexões visuais, áudio/vídeo, whiteboard, cursores no canvas, templates, histórico de versões, canvas infinito, agentes manipulando o workspace, componentes remotos.

## 11.3 Fase 2 (proposta, seção 53)

Conexões visuais, ações tipadas avançadas (streaming/cancelamento), `ultima-conference` + LiveKit, `ultima-whiteboard`, cursores colaborativos, templates, histórico (linha do tempo/snapshots), `ultima-agent` / `ia-agent` em modo proposta, `ia-timeline`, `ia-claim/evidence/provenance`, visões salvas, chat de componente/entidade, mensagens privadas, `file-store`.

## 11.4 Fase 3 (proposta, seção 54)

Canvas infinito, agentes autônomos, modo apresentação/dashboard, catálogo/marketplace e componentes remotos, versionamento/fork/merge, automação visual, P2P (`WebRtcProvider`), permissões por componente (sub-documentos), `ultima-browser`, voz no workspace.

## 11.5 Critérios de aceite do MVP

Cada critério é testável.

**A. Composição**
1. Criar workspace vazio; adicionar `ultima-notes`, `ia-search`, `ia-table` por arrasto e por teclado; mover, redimensionar, abrir em abas.
2. Fechar o navegador e reabrir: composição, config e notas idênticas (R-WS-3).
3. Remover uma instância desfaz-se com *undo*.

**B. Interoperabilidade**
4. Selecionar uma empresa em `ia-search`, aplicar **Mostrar conexões**: surge `ia-graph` conectado, posicionado ao lado, numa única operação desfazível.
5. Selecionar uma pessoa no grafo: `ia-news` (conectado) mostra notícias dela.
6. Tentar conectar saída incompatível a uma entrada: recusa com motivo legível.
7. Manifesto inválido faz `register()` falhar citando o campo.

**C. Colaboração**
8. Dois usuários (navegadores distintos) veem criação, movimento e configuração em < 1 s numa rede local.
9. Edição simultânea de `ultima-notes` converge sem perda.
10. Presença: avatar, componente em foco, "Carlos selecionou…" (sem vazar rótulo a quem não tem acesso).
11. Offline: editar localmente, reconectar, mesclar sem perda.
12. `viewer` não consegue alterar o documento, **mesmo adulterando o cliente** (teste contra o servidor).
13. Mudar o papel de um usuário em sessão aplica-se sem recarregar.

**D. Domínio e segurança**
14. Usuário sem acesso a um objeto referenciado vê "sem acesso", e a referência não vaza no documento, presença ou chat.
15. Dado `confidencial` não é gravado no IndexedDB do cliente (R-LF-4).
16. Eventos operacionais aparecem no painel de eventos do IA, sem conteúdo.
17. O workspace pode ser duplicado: copia composição e notas, e não copia dados de domínio.

**E. Chat**
18. Mensagem no chat chega aos outros em tempo real e persiste; menção `@` notifica.

**F. Qualidade**
19. A suíte de contrato passa em todos os componentes do MVP.
20. Sem build: `python3 -m http.server` + abrir o navegador executa o hospedeiro dev (M0–M3) com tudo funcionando.
21. Verificação de acoplamento: busca de texto em CI não encontra `import … yjs|livekit` fora de `adapters/` e `collaboration/providers/`, nem termos de domínio fora do pacote do IA.
22. Workspace de referência (≈ 20 instâncias, 5 participantes) mantém interação fluida (R-PERF-1) em hardware modesto.
23. Teclado e leitor de tela: criar workspace, adicionar componente, conectar e abrir o chat sem mouse.

## 11.6 Estratégia de testes

- **Unitários/contrato** no padrão UltimaJS (sem dependências, no navegador + `tests/run.sh` headless para CI).
- **Colaboração:** testes com dois `StateStore` em memória ligados por um canal simulado (rede com atraso, perda e reordenação), e testes de integração com `agora-sync` real em contêiner.
- **Segurança:** testes de autorização no servidor com cliente adulterado (critério C12/D14).
- **Aceite ponta a ponta:** o cenário da proposta (seção 60) automatizado em navegador headless com dois contextos.
- **Regra herdada:** toda correção de bug ganha teste.

## 11.7 Riscos principais

| Risco | Impacto | Mitigação |
|---|---|---|
| Bibliotecas (tldraw, editores ricos) assumem bundler/React | Atrasa notas/quadro | Decidir cedo (D-06, D-07); notas com editor mínimo próprio no MVP; quadro só na F2 |
| Contrato de componentes errado e caro de mudar | Retrabalho em todos os componentes | Congelar só depois de 4–5 componentes reais (M2); `contract` versionado |
| Segurança de sincronização (CRDT + autorização) | Vazamento de dados | Servidor valida papel; só referências no documento; testes adversariais |
| Vazamento de dados classificados via presença, chat e contexto de agente | Violação de política | Regras R-PRES-3, R-CTX-4/6, R-CHAT-3; revisão de segurança antes do M4 |
| Crescimento do documento CRDT | Lentidão | Limites, GC, conteúdo pesado fora do documento |
| Escopo (a proposta é grande) | Não terminar | Fatias verticais; M0–M3 antes de qualquer F2 |
| Divergência com o UltimaJS | Fork acidental | Core vendorizado e não alterado; contribuições pequenas ao UltimaJS, com testes |
| Dependência de um único mantenedor | Continuidade | Código legível, ADRs, specs, testes |

## 11.8 Primeiras tarefas concretas (após aprovação desta especificação)

1. Resolver D-01…D-08 (decisões que bloqueiam M0/M1).
2. Criar `CLAUDE.md`, `README.md`, `CHANGELOG.md` e a estrutura de diretórios de 55 da proposta, com `vendor/ultima` copiado.
3. M0: harness de testes, `AgoraComponent` mínimo, `ComponentRegistry` com validação de manifesto, `MemoryStateStore`.
4. Protótipo "tracer bullet": `ultima-text` + `ultima-table` conectados por uma porta tipada, num shell mínimo, salvo em IndexedDB.
5. Redigir ADRs no IA (adoção, sync, modelo de workspace).

## 11.9 Registro de implementação

### M1 (2026-10-04) — desvios e decisões tomadas na implementação

- **Layout em árvore binária** (`split` com duas filhas e `ratio`; `tabs` com lista de instâncias), gravado em `layout.root` / `layout.panels.<id>`. A aba ativa e a instância selecionada são estado local do usuário (R-LAY-5) e **não** estão no documento. Árvore e `children` são gravados como valor único por painel, e não por campo (R-CONF-1 vale para `config`; o layout será revisto na troca para Yjs).
- **Notas (D-07):** o editor é um `<textarea>` com Markdown e botão "Ver" (renderizador próprio, seguro, sem HTML), em vez de `contenteditable`. A ligação textarea ↔ texto compartilhado é bem mais simples e robusta; a interface `SharedText` (`getText/setText/onChange`) permanece, então trocar o editor continua barato. Negrito/listas/links são escritos em Markdown.
- **Digitação nas notas** é agrupada (400 ms) para que um passo de desfazer seja uma rajada de texto e não uma letra.
- **Conteúdo de instância removida fica no documento** (para o desfazer devolvê-lo); a limpeza de conteúdo órfão fica para o GC (5.8).
- **Montagem preguiçosa (R-LIFE-2):** uma aba só cria o componente quando fica ativa pela primeira vez; depois ele permanece montado. Mover entre painéis reaproveita o mesmo elemento e **não** chama `onDispose` (por isso `dispose()` explícito em vez de `disconnectedCallback`).
- **Alterações de `config` e de conteúdo não repintam os painéis** (mover um `textarea` com foco o desfocaria).
- **Dev host:** `DevHost` cobre `IdentityProvider` + `WorkspaceCatalog` + store local. `AccessPolicy`/`TokenIssuer` ainda não existem (um único dono local).
- **Rota:** `#/workspace/<id>` no hospedeiro de desenvolvimento (R-WS-2 prevê `/agora/workspace/<id>` no hospedeiro real).
- **Testes:** `tests/run.sh` acompanha o título da página (o `--virtual-time-budget` não espera o IndexedDB).
- **Fora do M1:** barra de ferramentas própria (`ui/toolbar`) — está dentro do shell; atribuição de papéis; `ultima-markdown` como componente (existe só o renderizador); `visibleIf` no inspetor; seleção compartilhada e presença (M3).
