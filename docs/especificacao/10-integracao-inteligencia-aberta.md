# 10. Integração com o Inteligência Aberta

O Inteligência Aberta (IA) é a primeira aplicação sobre o Agora. Esta seção define o **pacote de domínio** `inteligencia-aberta` e o **adaptador de hospedeiro** que liga o Agora ao portal Django, sem que o núcleo conheça o domínio (princípio 46 da proposta).

## 10.1 Onde cada coisa mora

```text
ultima-agora/                      (este repositório)
├── core/ collaboration/ conference/ components/ ui/ adapters/
│        └── adapters/dev/        hospedeiro de desenvolvimento
└── vendor/ultima/                core do UltimaJS (copiado)

inteligencia-aberta/
├── services/portal/apps/agora/   adaptador de hospedeiro (Django): workspaces, membros, tokens
├── services/agora-sync/          serviço de tempo real (contêiner)  ← decisão D-05
└── frontend/agora/               pacote de domínio (componentes ia-*, tipos, conversores)
    └── components/{entity,organization,person,graph,news,claim,evidence,investigation,…}
```

**R-IA-1.** O repositório `ultima-agora` **não** contém código `ia-*`. O pacote de domínio fica no repositório do IA (como a proposta sugere na seção 55) e é instalado com `Agora.use(iaPack)`. Quando o Agora for estável, `vendor/agora/` no IA recebe uma cópia, no mesmo regime de vendoring do UltimaJS.

## 10.2 Modelo no portal Django

Novo app `apps/agora/` (esboço, para ADR própria):

```text
Workspace      id(uuid) · title · organization(FK) · owner(FK) · classification · space(FK nulo)
               template_of(FK nulo) · created_at · updated_at · archived_at
WorkspaceMember workspace · user_or_agent · role(owner|editor|participant|viewer) · expires_at
WorkspaceInvite workspace · role · token_hash · expires_at · created_by
ChatMessage    workspace · author · body · refs(JSON) · created_at · edited_at · deleted_at
```

- **R-IA-2.** O isolamento por **organização** do IA vale para workspaces: um workspace pertence a uma organização, e a listagem é restrita aos membros dela, com papéis adicionais por workspace.
- **R-IA-3.** `Workspace.space` liga ao `Space` do IA (ADR 010). Ver 10.3.
- **R-IA-4.** O app emite eventos pelo `emit()` do `apps/events` (R-AUD-*). Eventos do Agora entram no painel `/eventos/` como uma categoria própria.
- **R-IA-5.** Papéis em `apps/accounts/permissoes.py` são a fonte da autorização global (`exige_admin`). Papéis de workspace são ortogonais e **nunca ampliam** o papel na organização.

## 10.3 `Space` × `Workspace`

| | `Space` (IA, ADR 010) | `Workspace` (Agora) |
|---|---|---|
| O que agrupa | Artefatos/objetos de domínio | Componentes (UI) e conteúdo autoral |
| Carrega política | Sim (replicação/exportação) | Classificação do conteúdo autoral |
| Membros | Planejados | Sim (papéis) |
| Replicável/federável | Sim, por espaço | Não no MVP |

Regras:

- Um workspace pode apontar para **um** `Space` (`spaceRef`). Os componentes de domínio usam esse espaço como **escopo padrão** das consultas e como destino padrão para o que criarem.
- O espaço padrão implícito da organização (sem linha no banco) é o valor quando `spaceRef` for nulo.
- O `Space` **não** concede acesso ao workspace nem o contrário. Acessos são independentes (como o `Space` hoje não concede acesso, "segue por organização").
- A federação de workspaces (compartilhar um workspace entre instâncias) é **fora do escopo** até haver decisão (D-33). Se vier, precisará respeitar R-DOC-3: o documento carrega só referências, e cada instância resolve o acesso a objetos conforme a política de replicação (ADR 011).

## 10.4 Catálogo `ia-*`

Cada componente declara tipos e ações em manifesto. Esboço do MVP e da sequência:

| Componente | Entradas | Saídas | Ações principais | Fase |
|---|---|---|---|---|
| `ia-search` | — | `results: Entity[]`, `selected: Entity` | Buscar | MVP |
| `ia-entity` | `entity: Ref` | `entity: Entity` | Mostrar conexões, Buscar notícias, Ver alegações/evidências, Abrir linha do tempo, Perguntar ao agente | MVP |
| `ia-table` (especializa `ultima-table`) | `rows: Table` / `entities: Entity[]` | `selected: Entity` | Ordenar, filtrar, exportar | MVP |
| `ia-graph` | `entities`, `relationships` | `selectedEntity`, `selectedRelationship` | Expandir, Filtrar, Centralizar | MVP |
| `ia-news` | `query` / `entity` | `selectedNews: Artifact` | Abrir fonte, Extrair entidades | MVP |
| `ia-person` / `ia-organization` | `entity: Ref` | `entity` | Variantes de `ia-entity` por tipo | MVP |
| `ia-claim` / `ia-evidence` / `ia-provenance` | `entity`/`claim` | `claim`/`evidence` | Ver proveniência, ir à fonte | F2 |
| `ia-relations` | `entity` | `relationships: Relationship[]` | Expandir, filtrar por tipo | F2 |
| `ia-timeline` (especializa `ultima-timeline`) | `events` | `selectedEvent` | Ampliar período | F2 |
| `ia-investigation` | — | `investigation` | Criar/ligar investigação ao workspace | F2 |
| `ia-agent` | contexto | — | Conversar; propor componentes | F2 |
| `ia-artifact` / `ia-source` | `artifact: Ref` | — | Visualizador do artefato (MHTML, texto) | F2 |

**R-IA-6.** Os tipos de domínio mapeiam para os modelos do IA (`Entity`, `Relationship`, `Claim`, `Evidence`, `Artifact`, `Provenance`), mas o pacote usa **DTOs** versionados (`IAEntity`, etc.) e não expõe os modelos Django diretamente. A API de domínio é a fronteira.
**R-IA-7.** Cada componente `ia-*` usa a API do portal por `this.domain`, sempre com o usuário atual (nunca uma credencial de serviço).
**R-IA-8.** `ia-entity` **não** mostra dados que o usuário não pode ver. Ao receber uma `Ref` que o servidor recusa, mostra "sem acesso" (sem vazar o rótulo).

### Alegações e evidências

O IA separa o que uma fonte **diz** (`Claim`) do que o sistema **sabe**, e toda alegação nasce com `Evidence`. O Agora deve preservar essa distinção na UI:

- **R-IA-9.** Componentes que exibem alegações mostram **fonte e grau de confiança** junto ao texto, e tipo da informação (`fato | opinião | inferência`), em vez de apresentar como fato.
- **R-IA-10.** Arrastar uma `Claim` para as notas cria um *chip* que mantém o vínculo à evidência e à proveniência (R-DND-2), mas **não** copia o conteúdo da fonte para o documento (R-DOC-3). Citação literal que o usuário digitar é conteúdo autoral e tem a classificação do workspace.

## 10.5 Fluxo de dados e autorização

```text
ia-entity ── this.domain.get("/artifacts/api/v1/…")  ← Django (usuário atual, org, classificação)
     │ emit(Entity.ref)
     ▼
ia-graph ── this.domain.get(relationships)           ← idem
```

- O **barramento** carrega `Ref` e resumos (id, tipo, rótulo permitido). Cada componente busca o detalhe com a permissão de quem vê.
- Os dados volumosos usam paginação/streaming na API do portal. O Agora não guarda cache de domínio acima do nível permitido (R-LF-4).

## 10.6 Agente `ia-agent`

- O contexto do workspace é montado no servidor pelo adaptador (R-CTX-6) e passa pelo `policy_engine` (R-CTX-4) antes de qualquer chamada a LLM. Para dados `restrito`/`confidencial`, usa-se LLM local (ADR 003).
- O agente usa as ferramentas do Agora (08.4) e as ferramentas de domínio do MCP/orquestrador.
- As respostas citam a evidência/proveniência das alegações usadas.

## 10.7 Voz

Como o IA trata voz como canal de primeira classe (ADR 004), os comandos de workspace devem ser alcançáveis pelo agente (R-VOICE-1). O contêiner de voz fala com o mesmo gateway de agentes. A resposta falada deve ser a versão **resumida**; o resultado completo aparece no workspace como componente.

## 10.8 Telas tradicionais

O portal Django continua oferecendo formulários, administração e relatórios (proposta, seção 50). O Agora é servido como aplicação em `/agora/` (e, no IA, linkado como "Investigação"), com autenticação pela sessão do portal. As páginas Django de listagem de artefatos ganham ação "Abrir no workspace".

## 10.9 Implantação

- Novo serviço `agora-sync` em `docker-compose.yml` / `docker-compose.prod.yml`, com `restart`, porta presa a `BIND_ADDR` e proxy no Caddy para o WSS. Segredos validados na subida (`config/segredos.py`).
- Perfis de implantação (`docs/visao/perfis-de-implantacao.md` do IA): o Agora deve rodar nos perfis com **uma máquina** e em **ambiente isolado**. O LiveKit é opcional (profile próprio), e o chat, as notas e o workspace funcionam sem ele.
- O livro de decisões do IA (`docs/arquitetura/decisoes/`) recebe ADRs para: adoção do Agora, serviço de sincronização, modelo de workspace, política de classificação do workspace e agentes que operam o workspace.

## 10.10 O que o IA ganha primeiro (critério de sucesso)

O cenário completo da proposta (seção 60) executado de ponta a ponta, em um ambiente único, com dois usuários simultâneos, sem escrever nenhuma tela dedicada. Ver 11.5.
