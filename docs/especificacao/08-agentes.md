# 08. Agentes

Agentes são **participantes** do workspace, e não apenas um chatbot. O Agora define o **contrato** entre o workspace e o agente (contexto, ferramentas, governança). Ele não define o framework de IA, que fica no backend da aplicação. No Inteligência Aberta é o orquestrador (FastAPI + LangGraph).

## 8.1 Tipos

| Componente | Pertence a | Função |
|---|---|---|
| `ultima-agent` | Agora | Painel de conversa com um agente genérico; usa o contrato abaixo |
| `ia-agent` | Inteligência Aberta | Agente especializado (investigação), com ferramentas de domínio |

Ambos usam a mesma interface do Agora. A diferença está nas ferramentas e no backend.

## 8.2 Identidade e transparência

- **R-AG-1.** O agente aparece na presença e no chat como participante `kind: "agent"`, com nome e ícone distintos. Nunca se passa por humano.
- **R-AG-2.** Toda alteração feita por agente carrega `createdBy` com a identidade do agente **e** a identidade do humano em cujo nome atua (`onBehalfOf`).
- **R-AG-3.** O agente atua com as **permissões do humano que o aciona**, e nunca com mais (R-AG-9). Se atuar de forma autônoma (monitoramento), tem identidade de serviço própria com política explícita (F3).

## 8.3 Contexto

O agente não recebe todos os dados da aplicação. O Agora monta um **contexto estruturado**, compacto e filtrado.

```json
{
  "workspace": { "id": "…", "title": "Investigação — Empresa Alfa", "classification": "interno" },
  "participants": [{ "id": "…", "name": "Maria", "kind": "human" }],
  "instances": [
    { "id": "cmp-17", "type": "ia-organization", "label": "Empresa Alfa",
      "focus": true,
      "context": { "selected": { "ref": "urn:ia:entity:123", "label": "Empresa Alfa" } } },
    { "id": "cmp-32", "type": "ia-graph",
      "context": { "nodes": 14, "edges": 21, "selected": { "ref": "urn:ia:entity:456" } } }
  ],
  "connections": [{ "from": "cmp-17.organization", "to": "cmp-32.entities" }],
  "selection": [{ "ref": "urn:ia:entity:456", "type": "Person" }],
  "availableComponents": ["ia-timeline", "ia-table", "ultima-notes"],
  "visibleTypes": ["Entity", "Relationship"]
}
```

- **R-CTX-1.** O contexto é montado a partir de: documento (instâncias, conexões, config), `describeContext()` de cada instância com `context-provider`, e o foco/seleção.
- **R-CTX-2.** `describeContext()` devolve **resumos e referências**, e não conjuntos completos. O agente obtém o detalhe por **ferramentas de domínio**, com autorização (como qualquer cliente).
- **R-CTX-3.** O contexto tem **limite de tamanho** e prioridade (o que está em foco primeiro). Excedendo, é truncado de forma determinística, com indicação do que ficou de fora.
- **R-CTX-4. Classificação.** O contexto herda o maior nível dos dados nele incluídos. Se o nível exigir restrição de LLM externo, o contexto **não pode ser enviado a modelo externo**. A decisão é do `policy_engine` do Inteligência Aberta (ou do `PolicyProvider` do hospedeiro, ver 09.5), e **nunca do cliente**.
- **R-CTX-5.** O conteúdo autoral (notas, chat) só entra no contexto se o participante o incluiu ou o workspace permite ("o agente pode ler as notas"). Configurável por instância (D-24).
- **R-CTX-6.** O contexto é **montado no servidor** a partir de um snapshot autenticado do documento, e não enviado pelo cliente, para impedir contexto forjado e decidir classificação corretamente (D-25).

## 8.4 Ferramentas do agente para operar o workspace

O agente age sobre o workspace por **ferramentas** definidas no Agora (e expostas a ele, por exemplo, como ferramentas MCP, alinhado com a ADR 001 do Inteligência Aberta, que escolheu o MCP como camada de integração):

| Ferramenta | Efeito |
|---|---|
| `workspace.describe()` | Contexto atual (8.3) |
| `components.list(filter)` | Catálogo (manifestos) |
| `components.create(type, config, placementHint)` | Cria instância |
| `components.configure(instanceId, patch)` | Altera config (validada pelo esquema) |
| `components.remove(instanceId)` | Remove (exige confirmação humana) |
| `connections.create(from, to)` / `remove` | Conecta/desconecta (validação de tipos) |
| `actions.list(instanceId)` / `actions.invoke(instanceId, action, args)` | Dispara ações (4.6) com `agent-callable` |
| `suggest.visualizations(type)` | Mesmo mecanismo determinístico de 4.7 |
| `notes.append(instanceId, text, refs)` | Escreve em notas, marcado como autoria do agente |
| `chat.post(text, refs)` | Mensagem no chat |
| `focus.set(instanceId)` | Destaca algo ao usuário (não muda estado persistente) |

As ferramentas de **dados** (consultar entidades, relacionamentos, notícias) pertencem ao **domínio** e ficam fora do Agora. O agente do Inteligência Aberta as recebe do MCP e do orquestrador.

- **R-AGT-1.** Toda ferramenta tem esquema de entrada/saída em JSON Schema (derivado dos manifestos e dos tipos), para que qualquer framework de agente possa usá-las.
- **R-AGT-2.** As ferramentas executam **no servidor do Agora** (ou no cliente do humano que acionou, ver D-26) através da mesma camada de operações do documento que a UI. Não há "porta dos fundos" para mexer no estado.

## 8.5 Governança

- **R-AG-4. Confirmação.** Operações destrutivas (`remove`, `disconnect` de conexão de outro usuário, ação `idempotent: false` com efeito externo) exigem **confirmação do humano**, a menos que o workspace tenha política explícita de autonomia.
- **R-AG-5. Proposta antes de execução (modo padrão).** No modo padrão, mudanças de composição propostas pelo agente aparecem como **proposta** ("Criar linha do tempo com 34 contratos?" [Aceitar][Rejeitar]). O modo "automático" é opt-in por workspace (D-27). Esse padrão cumpre o princípio "Usuário controla o espaço".
- **R-AG-6. Rastreabilidade.** Cada ação de agente gera evento no log operacional: agente, `onBehalfOf`, ferramenta, argumentos resumidos, resultado.
- **R-AG-7. Reversibilidade.** Todas as mudanças de composição feitas por agente são desfazíveis (R-HIST-2).
- **R-AG-8. Limites.** Taxa e orçamento de operações por agente e por sessão para impedir laços e criação em massa de componentes.
- **R-AG-9. Sem escalada.** O agente nunca ganha acesso a dado de domínio a que o humano acionador não tem acesso, mesmo que outro participante tenha. Se dois humanos com permissões distintas conversam com o mesmo agente, o contexto e as respostas visíveis a todos são calculados pela **interseção** de permissões (ou o agente responde a cada um separadamente). Esta regra é a mais difícil de acertar e requer decisão (D-28).
- **R-AG-10. Injeção de prompt.** Todo conteúdo vindo de fontes externas (notícias, páginas, documentos) é dado, e nunca instrução. Os agentes devem tratar esse conteúdo como não confiável, e ferramentas de alto impacto não podem ser acionadas exclusivamente a partir de conteúdo recuperado. Esta é uma responsabilidade compartilhada com o backend do agente e relevante para o Inteligência Aberta, cujo trabalho é justamente ler conteúdo de terceiros.

## 8.6 Fluxo de exemplo (proposta, seção 36)

1. O usuário pede, no `ia-agent`: "Mostre os contratos envolvendo essas empresas entre 2023 e 2025."
2. O servidor monta o contexto (empresas selecionadas e filtros ativos) e aplica a política de classificação.
3. O agente usa a ferramenta de domínio (MCP/IA) e obtém 34 contratos.
4. Responde no chat e usa `suggest.visualizations("Contract[]")` → [Tabela, Grafo, Linha do tempo].
5. O usuário escolhe "Linha do tempo". O agente chama `components.create("ia-timeline", …)` + `connections.create(…)` (como proposta, se o modo for o padrão).
6. Todos os participantes veem a nova instância. A criação aparece no histórico como `createdBy: agent, onBehalfOf: usuário`.
7. O usuário desfaz, se quiser.

## 8.7 Fora do escopo

- Escolha de modelos, prompts, embeddings e RAG: responsabilidade do backend (orquestrador, MCP).
- Agentes que rodam no navegador sem backend: não previstos.
