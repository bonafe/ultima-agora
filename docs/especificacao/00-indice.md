# Especificação do Ultima Agora

**Status:** rascunho 1 — 2026-10-04
**Base tecnológica:** UltimaJS (`../ultima`)
**Aplicação de referência:** Inteligência Aberta (`../inteligencia-aberta`)
**Predecessor conceitual:** `espaco` (`../spacejs`) — "Workspace" local em IndexedDB

Este conjunto de documentos detalha a proposta de produto do Ultima Agora. Ele separa três coisas:

- **Requisitos normativos**, identificados como `R-<área>-<n>`. "Deve" é obrigatório no MVP ou na fase indicada, "deveria" é desejável.
- **Decisões em aberto**, identificadas como `D-<n>`. Estão consolidadas em [12-decisoes-em-aberto.md](12-decisoes-em-aberto.md), cada uma com recomendação.
- **Fases**: `MVP`, `F2`, `F3`, conforme a proposta original.

## Sumário

| # | Documento | Conteúdo |
|---|---|---|
| 01 | [Visão e princípios](01-visao-e-principios.md) | Problema, posicionamento, não objetivos, princípios, convenções herdadas |
| 02 | [Modelo conceitual](02-modelo-conceitual.md) | Workspace, componente, instância, sessão, o documento do workspace |
| 03 | [Componentes e contrato](03-componentes-e-contrato.md) | Manifesto, ciclo de vida, base class, registro, capabilities |
| 04 | [Barramento, conexões e ações](04-barramento-conexoes-acoes.md) | Portas tipadas, tipos de dados, conexões, ações, sugestão de visualizações |
| 05 | [Colaboração e estado](05-colaboracao-e-estado.md) | Persistente × efêmero, CRDT abstrato, local-first, presença, histórico |
| 06 | [Comunicação](06-comunicacao.md) | Chat, conferência, notas, whiteboard |
| 07 | [Shell, layout e UI](07-shell-layout-ui.md) | Paleta, canvas de layout, inspetor, modos, acessibilidade |
| 08 | [Agentes](08-agentes.md) | Contexto, ferramentas, manipulação do workspace, governança |
| 09 | [Backend, persistência e permissões](09-backend-persistencia-permissoes.md) | APIs, serviços, papéis, armazenamento |
| 10 | [Integração com o Inteligência Aberta](10-integracao-inteligencia-aberta.md) | Catálogo `ia-*`, `Space`, classificação, alegações, federação |
| 11 | [Roadmap, MVP e critérios de aceite](11-roadmap-mvp.md) | Entregas por fase, testes, riscos |
| 12 | [Decisões em aberto](12-decisoes-em-aberto.md) | D-01 a D-NN, com recomendação |
| 13 | [Glossário](13-glossario.md) | Termos |
| 14 | [Mídia, gravação e integração](14-midia-e-integracao.md) | O que a chamada guarda, gravação por pessoa, eventos de saída, `FileStore`, escala |

## Resumo em uma página

O Ultima Agora é uma camada sobre o UltimaJS. Seu elemento central é o **workspace**, um documento persistente e colaborativo formado por **instâncias de componentes**.

- Um componente declara um **manifesto**: portas de entrada e saída tipadas, ações, configuração e capabilities.
- O Agora conecta as instâncias por um **barramento tipado**, conexões automáticas ou explícitas, e ações que podem criar novos componentes.
- O documento do workspace guarda **composição, layout, conexões, configuração e conteúdo colaborativo**. Os **dados de domínio ficam fora dele**, na API da aplicação. O documento guarda apenas **referências** a eles.
- O estado colaborativo passa por uma interface própria (`StateStore`), que o Yjs implementa. A conferência passa por outra (`ConferenceProvider`), que o LiveKit implementa.
- A aplicação funciona **local-first**: IndexedDB no navegador, depois sincronização com o servidor.
- Os agentes são componentes com **contexto estruturado** e **ferramentas** que operam o workspace como um participante, sob a mesma política de acesso dos humanos.

## Decisões que esta especificação toma em relação à proposta original

A proposta original deixa alguns pontos abertos ou ambíguos. A especificação fixa os seguintes, e cada um pode ser revertido na revisão:

1. **Idioma.** Seguindo o UltimaJS, os identificadores, o código e os comentários ficam em inglês. A documentação e os textos de interface ficam em português. Isso é consistente com a regra do Inteligência Aberta ("domínio em português, técnica em inglês"), com uma diferença: as tags dos componentes são técnicas, então ficam em inglês (`ia-graph`, `ultima-notes`).
2. **O UltimaJS evolui só com o mecanismo genérico de mixins** (retrocompatível, com testes). As capacidades concretas (portas, conteúdo colaborativo, presença) ficam no Agora como mixins, compostas em `AgoraComponent` (ver [03](03-componentes-e-contrato.md); D-02 decidida).
3. **Sem build.** Como no UltimaJS, os módulos são ES nativos e as bibliotecas de terceiros (Yjs, LiveKit client, tldraw ou alternativa) são **copiadas** para `vendor/`, com versão e hash registrados. Isso tem consequências para a escolha do whiteboard e do editor de notas (D-06, D-07).
4. **O documento colaborativo guarda referências, não cópias, de dados classificados.** Isso é necessário para respeitar o `policy_engine` e a classificação do Inteligência Aberta, e para a futura federação (ver [10](10-integracao-inteligencia-aberta.md)).
5. **Workspace ≠ `Space` do Inteligência Aberta.** Um `Space` agrupa artefatos e carrega política, e um workspace é uma composição de UI. O workspace pode apontar para um `Space`.
6. **Servidor de sincronização separado do Django.** O Django permanece responsável por autenticação e autorização. O tempo real fica num contêiner próprio, que valida tokens emitidos pelo Django (D-05).
