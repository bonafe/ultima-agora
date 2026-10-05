# 09. Backend, persistência e permissões

O núcleo trabalha com **contratos**. Cada dependência de infraestrutura entra por um adaptador substituível. Esta seção define os contratos e as implementações de referência para o Inteligência Aberta.

## 9.1 Visão de serviços

```text
Navegador (Ultima Agora)
   │  HTTPS (REST)                │  WSS (sync + presença + chat)       │ WebRTC (LiveKit)
   ▼                              ▼                                     ▼
Portal/Django (hospedeiro)   agora-sync (tempo real)                 LiveKit (F2)
 • autenticação                • documentos abertos                    
 • metadados de workspace      • persistência de updates
 • papéis                      • valida token curto
 • emite tokens (sync/conf)    • presença, chat (entrega)
 • domínio (APIs)
        │
   PostgreSQL · Object Storage (Garage/S3) · Qdrant · Orquestrador (agentes)
```

**R-BE-1.** `agora-sync` é um **serviço próprio** (contêiner), alinhado à ADR 002 do Inteligência Aberta (contêiner como unidade fundamental). O Django roda sob ASGI e poderia hospedar WebSocket, mas a sincronização CRDT tem perfil de carga distinto (conexões longas, memória por documento) e deve escalar à parte (D-05).
**R-BE-2.** O hospedeiro (Django) continua dono de **autenticação, autorização, usuários, organizações e domínio**. O Agora não duplica usuários.
**R-BE-3.** `agora-sync` não acessa o banco de domínio.

## 9.2 Contratos do hospedeiro (`HostAdapter`)

O Agora pede ao hospedeiro apenas o que segue. Cada item tem uma implementação de referência para o Inteligência Aberta (seção 10) e uma para desenvolvimento local.

| Contrato | Responsabilidade |
|---|---|
| `IdentityProvider` | Quem é o usuário atual (`id`, nome, avatar, papéis globais) |
| `WorkspaceCatalog` | Listar/criar/abrir/renomear/arquivar workspaces; metadados; URL |
| `AccessPolicy` | `can(user, action, resource)`; papel do usuário num workspace |
| `TokenIssuer` | Token curto para `agora-sync`, chat e conferência (escopo: workspace + papel) |
| `DomainClient` | Cliente HTTP autenticado da API de domínio (injetado em `this.domain`) |
| `PolicyProvider` | Decisões de classificação para agentes e dados (no IA: `policy_engine`) |
| `FileStore` | Upload/download assinado de arquivos |
| `EventSink` | Recebe eventos operacionais (no IA: `emit()` do app `events`) |
| `AgentGateway` | Rota para o(s) agente(s) (no IA: orquestrador) |

**R-HOST-1.** Para desenvolvimento e testes, o Agora inclui um hospedeiro **mínimo local** (`adapters/dev/`): usuários simulados, workspaces em IndexedDB/arquivo, sem backend. Os componentes genéricos devem funcionar nele.

## 9.3 Armazenamento

| Dado | Armazenamento | Observação |
|---|---|---|
| Usuários, organizações, papéis | PostgreSQL (hospedeiro) | Já existe no IA |
| Metadados do workspace e `Membership` | PostgreSQL | Tabelas novas no hospedeiro (ver 10.2) |
| Documento colaborativo (CRDT) | Store de updates em PostgreSQL (tabela de updates + snapshots) ou arquivo/Garage | Escolha em D-29; nenhum dado de domínio |
| Chat | PostgreSQL (tabela própria) | Retenção configurável |
| Arquivos, imagens, capturas | Object Storage (Garage/S3) | Referenciados por id |
| Embeddings / busca semântica | Vector Store (Qdrant) | Usado pelo domínio e agentes, não pelo núcleo |
| Cache local do cliente | IndexedDB | Ver R-LF-4 |

**R-STO-1.** Cada tipo é acessado por interface; o núcleo não conhece PostgreSQL nem S3.
**R-STO-2.** Backups: documento CRDT + metadados formam o backup mínimo do workspace. Restaurar deve ser possível a partir de snapshot, ainda que sem o histórico fino.

## 9.4 Papéis e permissões

Papéis: `owner`, `editor`, `participant`, `viewer` (proposta, seção 42).

| Capacidade | owner | editor | participant | viewer |
|---|---|---|---|---|
| Ver workspace e componentes | ✓ | ✓ | ✓ | ✓ |
| Alterar composição (adicionar/mover/remover/configurar/conectar) | ✓ | ✓ | – | – |
| Editar conteúdo colaborativo (notas, quadro) | ✓ | ✓ | ✓ | – |
| Chat (escrever) | ✓ | ✓ | ✓ | leitura (D-30) |
| Executar ações de componentes | ✓ | ✓ | ✓ (apenas ações marcadas como "leitura") | – |
| Áudio/vídeo (publicar) | ✓ | ✓ | ✓ | escuta |
| Convidar e gerir membros | ✓ | – | – | – |
| Alterar classificação, compartilhar, excluir | ✓ | – | – | – |
| Invocar agente | ✓ | ✓ | ✓ | – |

**R-PERM-1.** No MVP as permissões valem para o **workspace inteiro**. Permissões por componente, ação, dado e conferência (proposta, seção 42) entram nas fases seguintes (D-19).
**R-PERM-2.** Ações têm um atributo `access: "read" | "write"` no manifesto, que mapeia para o papel necessário.
**R-PERM-3. Aplicação dupla.** As permissões são aplicadas (a) **na UI** (para clareza) e (b) **no servidor** (`agora-sync`, API do hospedeiro, API de domínio), sendo esta a que vale.
**R-PERM-4. Mudança de papel em tempo real.** Se o papel de alguém mudar durante uma sessão, o servidor corta/ajusta a conexão e o cliente recebe `onRole(role)` e atualiza a UI.
**R-PERM-5.** Acesso por link: um workspace pode ter **link de convite** com papel e expiração. Link com acesso anônimo fica fora do MVP (D-31), sobretudo no IA, onde o compartilhamento é auditado.
**R-PERM-6. Dados de domínio** são governados pelo domínio. Ter acesso ao workspace não concede acesso aos objetos referenciados (R-CONN-7).

## 9.5 Classificação do workspace

O Inteligência Aberta classifica artefatos por nível e tenant. O workspace precisa de política análoga:

- **R-CLS-1.** Todo workspace tem uma `classification` (valor do conjunto do hospedeiro; no IA, `público`…`confidencial`). O padrão é o mais restritivo do contexto (a organização), e o dono pode alterá-lo explicitamente.
- **R-CLS-2.** A classificação do workspace é o **piso** para seu conteúdo autoral (notas, chat, quadro) e condiciona: compartilhamento externo, exportação, uso de LLM externo no contexto de agente e conferências gravadas.
- **R-CLS-3.** Ao referenciar um objeto de domínio de nível mais alto que o workspace, o Agora **avisa** (sem copiar o dado): a referência é permitida, mas o workspace é sinalizado como "contém referências a conteúdo X". A política de bloquear ou apenas avisar é do hospedeiro (`PolicyProvider`).
- **R-CLS-4.** Reclassificar um workspace é operação explícita e auditada (contraste com artefatos, em que o nível é imutável, e por isso a decisão de nível no workspace deve evitar "rebaixar" depois de conteúdo sensível ter sido escrito; ver D-32).

## 9.6 Auditoria e observabilidade

Segue o padrão do app `events` do IA: eventos de domínio operacional, append-only, sem conteúdo.

Eventos mínimos: `WorkspaceCreated/Opened/Archived`, `MemberAdded/Removed/RoleChanged`, `ComponentCreated/Removed/Configured`, `ConnectionCreated/Removed`, `ActionInvoked`, `AgentToolInvoked`, `SyncConnected/Disconnected`, `ClassificationChanged`, `ShareCreated/Revoked`.

- **R-AUD-1.** Emissão **nunca levanta exceção** e **nunca** carrega conteúdo de notas, chat ou dados de domínio (apenas ids, tipos, tamanhos).
- **R-AUD-2.** Eventos de segurança (mudança de papel, compartilhamento, reclassificação, exportação) são sempre registrados e não podem ser desligados.
- **R-AUD-3.** Correlação ponta a ponta (workspace → ação → chamada de domínio → agente) via id de correlação propagado, como no IA.

## 9.7 APIs (esboço)

REST sobre o hospedeiro (nomes ilustrativos; a forma exata é decidida na implementação do adaptador de referência):

```text
GET    /agora/api/v1/workspaces                      lista (do usuário)
POST   /agora/api/v1/workspaces                      cria (a partir de template ou vazio)
GET    /agora/api/v1/workspaces/{id}                 metadados + papel do usuário
PATCH  /agora/api/v1/workspaces/{id}                 título, classificação, spaceRef
POST   /agora/api/v1/workspaces/{id}/duplicate
POST   /agora/api/v1/workspaces/{id}/archive
GET    /agora/api/v1/workspaces/{id}/members         |  POST/PATCH/DELETE
POST   /agora/api/v1/workspaces/{id}/token           token curto p/ sync/chat/conferência
GET    /agora/api/v1/workspaces/{id}/export          exportação (política)
POST   /agora/api/v1/workspaces/{id}/agent/messages  conversa com agente (servidor monta contexto)
```

WebSocket (`agora-sync`): `wss://…/agora-sync/{workspaceId}?token=…` — protocolo do provider (Yjs: `y-websocket`-compatível) mais canal de presença; o canal de chat usa o mesmo transporte com mensagens próprias.

**R-API-1.** Versionamento explícito (`/v1`). **R-API-2.** Erros num formato único com código estável.
**R-API-3.** O token de sync tem vida curta, escopo `{workspace, role, user}`, e é renovado em segundo plano.

## 9.8 Segurança (resumo)

- Origem e CORS restritos. Sem credenciais em query string além do token curto do WebSocket.
- Limite de tamanho/taxa por conexão e por update (R-SYNC-3).
- Sanitização de qualquer HTML renderizado (chat, notas, markdown). Conteúdo de terceiros em componentes como `ultima-browser` isolado por `sandbox`.
- Componentes carregados de fontes não confiáveis são **fora do MVP** (R-REG-5).
- Bibliotecas copiadas para `vendor/` com versão e hash (SRI), seguindo o padrão do UltimaJS.
- Para ambientes isolados: nenhum recurso externo em tempo de execução (fontes, CDNs, conferência de terceiros).
