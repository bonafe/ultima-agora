# 02. Modelo conceitual

## 2.1 Entidades

```text
Application (ex.: Inteligência Aberta)
   └── instala → ComponentDefinition[]  (via registro)

Workspace  ── 1..n → Session (atividade colaborativa)
   │
   ├── WorkspaceDocument  (CRDT)
   │      ├── meta
   │      ├── instances   : ComponentInstance[]
   │      ├── layout
   │      ├── connections : Connection[]
   │      ├── notes / whiteboard (conteúdo colaborativo)
   │      └── savedViews  (filtros e visões salvas)
   │
   ├── Membership (papel de cada pessoa ou agente)
   └── ref → Space (opcional, do domínio)
```

| Entidade | Natureza | Onde vive |
|---|---|---|
| `ComponentDefinition` | Implementação disponível (classe + manifesto) | Código e registro (`ComponentRegistry`) |
| `ComponentInstance` | Uso de um componente num workspace | `WorkspaceDocument` |
| `Workspace` | Identidade, título, dono, política, ligação com `Space` | Backend (metadados) + documento |
| `WorkspaceDocument` | Composição e conteúdo colaborativo | Store colaborativo (CRDT) |
| `Session` | Atividade ao vivo: participantes, presença, chat, conferência | Efêmera (o chat pode ser persistido, ver 06) |
| `Connection` | Ligação tipada entre porta de saída e porta de entrada | `WorkspaceDocument` |
| `Participant` | Pessoa ou agente presente numa sessão | Presença |

## 2.2 Workspace

Um workspace é um documento composto pelo usuário, e **não** uma página. Ele tem identidade própria, URL, dono e papéis. **Não depende de haver uma sessão ativa.**

```json
{
  "id": "3f6a…(uuid)",
  "title": "Investigação — Empresa Alfa",
  "schemaVersion": 1,
  "ownerId": "urn:user:…",
  "spaceRef": "urn:ia:space:…",
  "classification": "interno",
  "templateOf": null,
  "createdAt": "2026-10-04T12:00:00Z",
  "updatedAt": "2026-10-04T12:40:00Z"
}
```

Requisitos:

- **R-WS-1** (MVP). Criar, abrir, renomear, duplicar e arquivar um workspace.
- **R-WS-2** (MVP). URL estável e compartilhável: `/agora/workspace/<id>`. Quando hospedado por uma aplicação, a aplicação pode mapear para o próprio prefixo (`/inteligencia-aberta/investigacao/<id>`), mas o `<id>` é o mesmo.
- **R-WS-3** (MVP). Reabrir um workspace restaura as instâncias, o layout, as configurações, as conexões e as notas, **sem** precisar de nenhuma sessão ativa.
- **R-WS-4** (F2). Templates: um workspace marcado como template pode gerar outros (`templateOf` registra a origem).
- **R-WS-5** (F3). Fork/branch e versionamento (ver 05.8).
- **R-WS-6** (MVP). Duplicar copia a **composição e o conteúdo colaborativo**. Os dados de domínio não são copiados, porque o documento só tem referências. A cópia referencia os mesmos objetos de domínio, e o acesso a eles continua sendo decidido pelo domínio.

## 2.3 Componente, instância e a distinção que importa

- **Definição** (`ComponentDefinition`): `{ name, component (classe), manifest }`. Única por `name` num registro. Versionada.
- **Instância** (`ComponentInstance`): `{ id, type, version, config, position/size ou placement, label }`. Pode haver várias do mesmo `type`.

```json
{
  "id": "cmp-729",
  "type": "ia-graph",
  "typeVersion": "1.0.0",
  "label": "Rede da Empresa Alfa",
  "placement": { "mode": "grid", "x": 6, "y": 0, "w": 6, "h": 8 },
  "config": { "depth": 2 },
  "createdBy": "urn:user:…",
  "createdVia": "action | palette | agent | template"
}
```

Regras:

- **R-INST-1.** O `id` é gerado no cliente que cria (UUID v4, com prefixo legível opcional), assim criações concorrentes não colidem.
- **R-INST-2.** `config` é validado contra o esquema de configuração do manifesto. Valores inválidos são rejeitados na escrita, e não só na renderização.
- **R-INST-3.** `typeVersion` registra com qual versão do manifesto a instância foi criada. Se o componente instalado for mais novo, o Agora aplica o `migrateConfig(from, to, config)` do manifesto, se existir. Se o tipo não estiver instalado, a instância aparece como **placeholder** que preserva `config` intacto (nunca descarta dados de um componente desconhecido).
- **R-INST-4.** Remover uma instância remove também as conexões que a envolvem. A remoção é uma operação do documento, portanto desfazível (ver 05.7).
- **R-INST-5.** `createdVia` e `createdBy` são informativos e auditáveis. São a base para "quem criou isto?" quando um agente cria componentes.

## 2.4 O documento do workspace

A estrutura lógica (independente de implementação CRDT):

```text
WorkspaceDocument
├── meta            Map    { title, schemaVersion, layoutMode, … }
├── instances       Map<instanceId, InstanceRecord>
├── order           List<instanceId>          (ordem de z / abas / foco)
├── layout          Map    estrutura do modo ativo (ver 07)
├── connections     Map<connectionId, ConnectionRecord>
├── content         Map<instanceId, SharedContent>
│                    (texto das notas, traços do quadro, mensagens fixadas…)
└── savedViews      Map<viewId, SavedView>
```

**R-DOC-1.** O documento tem `schemaVersion`. Abrir um documento de versão mais nova do que o cliente conhece abre em modo **somente leitura** com aviso (ver D-09 para migrações).

**R-DOC-2.** Cada **componente colaborativo** recebe do Agora um *nó de conteúdo próprio* (`content[instanceId]`), e não tem acesso ao resto do documento. É por esse nó que `ultima-notes` guarda o texto e `ultima-whiteboard` guarda os traços. Isso limita o impacto de um componente defeituoso.

**R-DOC-3. Referências, não cópias.** Um componente de domínio que "mostra a Empresa X" guarda em `config` ou nas portas o **identificador** (`urn:ia:entity:123`) e não o objeto. O objeto é obtido da API do domínio, com a permissão de quem está vendo. Exceção explícita: conteúdo **autoral** do usuário (nota, desenho, comentário) é conteúdo do workspace e vive no documento.

**R-DOC-4. Limites.** O Agora define limites de tamanho para o documento (D-10) e rejeita, nas portas e na `config`, valores binários e payloads grandes inline. Arquivos vão para o armazenamento de objetos e entram como referência (`blob:` ou URL assinada).

### 2.4.1 Por que referências (justificativa)

1. O Inteligência Aberta classifica artefatos (`público`, `interno`, `restrito`, `confidencial`) e aplica `policy_engine`. Se o conteúdo fosse copiado para o documento, um participante sem permissão poderia ler o dado pelo sincronizador.
2. O CRDT acumula histórico de operações. Um dado "apagado" do domínio ainda existiria no histórico do documento (a federação do IA tem um problema de apagamento análogo, ADR 010).
3. O princípio da proposta (seção 23) diz que o documento colaborativo não é o banco de dados da aplicação.

## 2.5 Sessão

Uma sessão é a atividade ao vivo num workspace.

- **R-SES-1.** Uma sessão existe enquanto há pelo menos um participante conectado ao canal de presença do workspace. Não precisa ser criada explicitamente pelo usuário. Entrar no workspace é entrar na sessão.
- **R-SES-2.** A presença é **efêmera** (ver 05.3) e não vai para o documento.
- **R-SES-3.** O chat do workspace pertence ao workspace e persiste, com política de retenção configurável (D-11). A conferência de áudio e vídeo pertence à sessão e não persiste. Gravação, se existir, é um recurso à parte e fora do MVP.
- **R-SES-4.** O fim da sessão não altera o documento.

## 2.6 Identidade de participantes

Um participante tem `id` estável (pessoa ou agente), `displayName`, `kind: "human" | "agent"` e uma cor atribuída por sessão. Agentes **sempre** aparecem identificados como tal (R-AG-1 em 08).

No Inteligência Aberta, a identidade vem do `accounts.User`. Em outro hospedeiro, vem de um `IdentityProvider` do adaptador (ver 09).

## 2.7 Compatibilidade com o `espaco`

O `espaco` guarda o workspace local por IndexedDB. A migração não é objetivo do MVP. Fica registrado para uma fase posterior um importador (`espaco` → documento Agora) para quem já tem visualizações salvas (D-12).
