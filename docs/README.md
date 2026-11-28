# Documentação do Ultima Ágora

Tudo aqui está em português; o código e seus comentários estão em inglês. Esta página é o mapa: escolha o caminho pelo que você
quer fazer.

## Quero entender o projeto

| Comece por | O que você encontra |
|---|---|
| [`../README.md`](../README.md) | O que é, como experimentar em 30 segundos, o que já funciona, como as peças se encaixam |
| [Visão e princípios](especificacao/01-visao-e-principios.md) | O problema, o posicionamento e o que o projeto **não** é |
| [Modelo conceitual](especificacao/02-modelo-conceitual.md) | Workspace, componente, instância, o documento |
| [Glossário](especificacao/13-glossario.md) | Os termos, um a um |

## Quero usar ou hospedar

| Documento | Para quê |
|---|---|
| Site: *Rodar em casa* (`../hospedar.html`) | Passo a passo, para quem não programa |
| Site: *Falar com a Ágora* (`../comandos.html`) | Os comandos de voz, com exemplos |
| [`../server/agora-sync/README.md`](../server/agora-sync/README.md) | O servidor de tempo real em produção: variáveis, limites, garantias |
| [`../server/agora-model/README.md`](../server/agora-model/README.md) | O serviço do modelo de decisão: CPU, GPU, apontar para outro lugar |
| [`../models/README.md`](../models/README.md) | Os pesos dos modelos (fora do git) e como baixá-los |

## Quero criar componentes ou mexer no código

| Documento | Para quê |
|---|---|
| [`contrato-agoracomponent.md`](contrato-agoracomponent.md) | O contrato do componente (versão 1, congelado): manifesto, portas, ações, ciclo de vida |
| [Componentes e contrato](especificacao/03-componentes-e-contrato.md) e [Barramento](especificacao/04-barramento-conexoes-acoes.md) | A teoria por trás: capabilities, tipos, conexões |
| [`../CLAUDE.md`](../CLAUDE.md) | Convenções do código, camadas e regras que importam (por exemplo: o Yjs só aparece em `collaboration/`) |
| [`../CHANGELOG.md`](../CHANGELOG.md) | O que mudou, em ordem |

## Quero conferir o que está provado

| Documento | Para quê |
|---|---|
| [`aceite-mvp.md`](aceite-mvp.md) | Os 23 critérios do MVP, um a um: qual teste cobre e **o que ainda falta provar** |
| [`spike-laya.md`](spike-laya.md) | As medições do modelo de decisão (Python, navegador e servidor) e a conclusão |
| [Roadmap e critérios](especificacao/11-roadmap-mvp.md) | Marcos, riscos e o registro de implementação |

## A especificação, por assunto

A especificação tem 15 capítulos; o [índice](especificacao/00-indice.md) lista todos. Para as perguntas mais comuns:

| Pergunta | Capítulo |
|---|---|
| Como duas pessoas editam ao mesmo tempo? Como funciona offline? | [05 Colaboração e estado](especificacao/05-colaboracao-e-estado.md) |
| Chat, chamada, transcrição | [06 Comunicação](especificacao/06-comunicacao.md) |
| Janelas, paleta, celular, acessibilidade | [07 Shell, layout e UI](especificacao/07-shell-layout-ui.md) |
| O que um agente ou um comando de voz pode fazer? | [08 Agentes](especificacao/08-agentes.md) e [15 Comandos por voz](especificacao/15-comandos-por-voz.md) |
| Papéis, permissões, API, armazenamento | [09 Backend e permissões](especificacao/09-backend-persistencia-permissoes.md) |
| Gravação, webhooks, escala | [14 Mídia e integração](especificacao/14-midia-e-integracao.md) |
| Por que foi decidido assim? | [12 Decisões](especificacao/12-decisoes-em-aberto.md): cada `D-nn`, com as alternativas |

## Convenções

- **`R-<área>-<n>`** é um requisito; **`D-<n>`** é uma decisão (em [12](especificacao/12-decisoes-em-aberto.md)). Ambos são citados nos comentários do código e nos commits.
- ✅ nas decisões quer dizer *decidida*; nos critérios de aceite, *coberta por teste automatizado*; ◐, *coberta em parte, com a lacuna escrita*.
- Medições dizem **onde** foram feitas (máquina, núcleos, navegador). Um número sem essa informação não vale.
