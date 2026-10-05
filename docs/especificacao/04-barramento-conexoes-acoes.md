# 04. Barramento, conexões e ações

## 4.1 Visão

Componentes se comunicam sem conhecer a implementação uns dos outros. O Agora oferece um **barramento de portas tipadas**. Cada instância tem portas de entrada e saída declaradas no manifesto, e as **conexões** ligam saídas a entradas. Os valores trafegam apenas por essas conexões.

A proposta menciona um barramento de eventos simples (`emit`/`on` por nome) como ponto de partida e pede a evolução para tipos, esquema, origem, destino e contexto. A especificação vai direto ao modelo tipado, mas **mantém a ergonomia**: para o desenvolvedor do componente, ainda é `this.emit("selectedEntity", entity)`.

## 4.2 Sistema de tipos

Um **tipo** tem nome, esquema e (opcionalmente) relações com outros tipos.

```json
{
  "name": "Entity",
  "schema": { "type": "object", "required": ["id", "kind"],
              "properties": { "id": {"type":"string"}, "kind": {"type":"string"}, "label": {"type":"string"} } },
  "extends": null,
  "displayHint": "entity"
}
```

- **R-TYPE-1.** Os tipos primitivos do núcleo são: `String`, `Number`, `Boolean`, `Date`, `DateRange`, `Json`, `Ref` (referência a objeto de domínio), `File`, `Text` e `Selection`, mais os genéricos `T[]` e `Optional<T>`.
- **R-TYPE-2.** O núcleo define também tipos de **visualização genérica** que as aplicações especializam: `Table` (colunas + linhas), `Series` / `TimeSeries`, `Graph` (nós + arestas), `GeoFeatures`, `Document`, `FilterSpec`.
- **R-TYPE-3.** Aplicações registram tipos de domínio (`Entity`, `Relationship`, `Claim`…). O núcleo não os conhece (princípio de domínio fora do núcleo).
- **R-TYPE-4. Subtipagem.** `extends` permite que `Person extends Entity` seja aceito onde `Entity` é esperado. Não há conversão implícita entre tipos que não estejam na cadeia.
- **R-TYPE-5. Conversores.** Uma aplicação pode registrar `Converter<From, To>` (ex.: `Relationship[] → Graph`, `Relationship[] → Table`). Eles são a base da sugestão de visualizações (4.7) e ficam explícitos na UI quando aplicados.
- **R-TYPE-6.** Valores que atravessam o barramento são **JSON serializável** e de tamanho limitado. Para dados volumosos, a porta carrega uma **referência** (`Ref`/`DatasetRef` com consulta paginável), e quem consome busca. Isso evita copiar conjuntos grandes pelo documento e pelo barramento.

> Os tipos, como o manifesto, são dados. Esquema em JSON Schema (subconjunto) é suficiente, sem dependências, e já serve a agentes (08) para entender ferramentas.

## 4.3 Portas

```text
entrada:  type, required?, multiple? (aceita várias conexões; valor = lista)
saída:    type, retained? (mantém último valor, padrão: sim)
```

- **R-PORT-1.** Uma saída **retém** o último valor emitido. Quem se conecta depois recebe o valor atual imediatamente (comportamento de "estado", e não de "evento"). Para eventos sem estado (um clique momentâneo), a saída é declarada `retained: false`.
- **R-PORT-2.** Uma entrada `multiple: false` aceita só uma conexão. Uma nova conexão a substitui após confirmação do usuário (ou falha, se feita por agente sem permissão para isso).
- **R-PORT-3.** Os valores emitidos são **imutáveis** para quem os recebe (congelados em desenvolvimento).
- **R-PORT-4.** O valor atual de cada saída é **estado derivado e local**, e não vai para o documento. A *conexão* é persistente, mas o *valor* é recalculado a partir dos componentes quando o workspace abre. Exceção: componentes podem persistir seleção em `config` ou em conteúdo compartilhado, se isso fizer sentido para o caso de uso.

Isso responde a uma questão que a proposta deixa aberta: **uma seleção é compartilhada entre os participantes?** A especificação distingue:

| Tipo de seleção | Onde vive | Efeito |
|---|---|---|
| **Seleção local** | Estado do componente do usuário, emite na porta localmente | Só o participante vê o efeito nos componentes conectados |
| **Seleção compartilhada ("seguir")** | Modo opt-in que publica a seleção como presença (não persistente) ou grava em `config`/conteúdo (persistente) | Os outros veem a seleção; aplicá-la nos seus componentes é opcional |
| **Seleção fixada** | Gravada na instância (`config.selected`) | Todos veem, e persiste |

Padrão do MVP: **seleção local** + indicação de presença ("Carlos selecionou Empresa X"). Decisão registrada em D-14.

## 4.4 Conexões

```json
{
  "id": "conn-12",
  "from": { "instance": "cmp-17", "port": "selectedEntity" },
  "to":   { "instance": "cmp-32", "port": "entity" },
  "transform": null,
  "createdBy": "urn:user:…",
  "createdVia": "auto | manual | action | agent"
}
```

- **R-CONN-1. Validação.** Ao criar a conexão, o Agora verifica a compatibilidade (igual, subtipo, ou conversor registrado). Incompatível: recusada com motivo legível (`"Entity[] não é aceito por 'entity' (espera Entity)"`).
- **R-CONN-2. Ciclos.** Ciclos são detectados na criação. Por padrão são recusados. Um ciclo só é permitido se ao menos uma aresta for marcada `loop: "guarded"`, e o barramento aplica propagação com limite de profundidade e *debounce* para impedir laços infinitos (D-15).
- **R-CONN-3. Automáticas.** Se a ação do usuário cria uma nova instância, o Agora cria a conexão natural (ver 4.6). Se existe **exatamente um** destino compatível para uma saída e o usuário pediu "conectar automaticamente", conecta. Havendo mais de um, pergunta.
- **R-CONN-4. Persistência.** Conexões vivem no documento (colaborativas) e são operações desfazíveis.
- **R-CONN-5** (F2). **UI de conexões visuais:** arrastar de uma porta para outra, linhas desenhadas sobre o workspace, destaque de portas compatíveis. No MVP, as conexões são criadas por ações, pelo inspetor e por um seletor simples ("Receber de…").
- **R-CONN-6.** Se a instância origem ou destino for removida, a conexão é removida. Se for substituída por outra de mesmo tipo, o Agora oferece reconectar.
- **R-CONN-7. Permissão de dados.** Conectar não concede acesso. Uma saída que carrega `Ref` para algo que o consumidor (ou o usuário que está olhando) não pode ver continua sendo recusada pela API de domínio. O barramento transporta referências, e a autorização acontece no acesso ao dado (02.4.1).

### 4.4.1 Semântica de propagação

- A entrega é **assíncrona e em ordem por conexão**, num único *tick* de microtarefa, para evitar reentrância.
- Valores iguais (comparação estrutural) não são reenviados.
- A emissão para uma conexão cujo destino ainda não carregou entra em fila (R-LIFE-1).
- O barramento **expõe observabilidade** (ver 4.9): cada entrega pode ser inspecionada num painel de depuração, mas sem registrar o conteúdo por padrão, apenas tipo e identificadores.

## 4.5 Barramento como API para desenvolvedores

```js
// dentro de um componente
this.emit("selectedEntity", entity);

onInput(port, value) {
  if (port === "entity") this.load(value);
}
```

O barramento também tem uma API para **serviços** do shell e agentes (não para componentes comuns):

```js
bus.snapshot()                          // valores atuais de todas as portas (para contexto)
bus.connect(from, to, opts)             // valida e grava no documento
bus.disconnect(connectionId)
bus.subscribe(instanceId, port, fn)     // observação (ex.: painel, agente)
```

Componentes **não** assinam diretamente portas de outros componentes. A comunicação passa pelas conexões (rastreáveis).

## 4.6 Ações

Uma **ação** é uma operação nomeada que um componente oferece sobre seu conteúdo atual ou sobre um valor dado. Substitui a ideia de "botões fixos" do componente: o conjunto de ações vem do manifesto e é apresentado de forma uniforme (menu de contexto, barra, agente).

```json
"actions": {
  "showConnections": {
    "title": "Mostrar conexões",
    "input": "Entity",
    "effect": "create",
    "produces": "Relationship[]",
    "suggests": ["ia-graph", "ia-table"],
    "requires": ["domain-data"]
  }
}
```

### Efeitos

| `effect` | Significado |
|---|---|
| `self` | Modifica o próprio componente (ex.: centralizar o grafo) |
| `state` | Altera o estado/config do componente (persistente) |
| `emit` | Produz um valor numa porta de saída |
| `feed` | Alimenta um componente existente (conectado ou escolhido) |
| `create` | Cria um novo componente (e a conexão correspondente) |

- **R-ACT-1.** Ações são **descobríveis**: o shell lista as ações de uma instância a partir do manifesto, filtrando pela permissão do usuário e pelo estado atual (`enabledWhen`, quando declarado).
- **R-ACT-2.** Uma ação com `effect: "create"` declara o tipo produzido (`produces`) e visualizações sugeridas (`suggests`). O Agora cria a instância sugerida padrão (ou pergunta, ver 4.7), cria a conexão `from(instância origem, porta produzida) → to(nova instância)`, e posiciona a instância perto da origem.
- **R-ACT-3.** A execução da ação é **uma operação rastreável** (`ActionInvoked` no log operacional, ver 09.6) com `invokedBy`, `instance`, `action`, argumentos resumidos e resultado.
- **R-ACT-4.** Ações são **idempotentes onde possível**. Se não forem, `idempotent: false` é declarado e o shell pede confirmação para execução por agente.
- **R-ACT-5.** Uma ação demorada indica progresso e é cancelável. Resultado parcial pode alimentar o destino em *streaming*.
- **R-ACT-6.** Quando a ação produz dados via API de domínio, a saída carrega **referências ou conjuntos paginados**, e não cópias completas (R-TYPE-6).
- **R-ACT-7.** Execução por agente requer `agent-callable` (3.5) e passa pela política de agentes (08.5).

### Exemplo de fluxo (da proposta, seção 14)

1. Usuário abre `ia-organization`, escolhe "Empresa X".
2. Aciona **Mostrar conexões**. A ação consulta `domain.relationships(entity)`, produz `Relationship[]`.
3. O Agora cria `ia-graph`, conecta `ia-organization.relationships → ia-graph.relationships` e posiciona ao lado.
4. O usuário seleciona uma pessoa no grafo (porta `selectedEntity`).
5. Aciona **Buscar notícias** sobre ela. Surge `ia-news` conectado à saída `selectedEntity` do grafo.

## 4.7 Sugestão de visualizações

Dado um tipo produzido (ex.: `Relationship[]`), o Agora calcula candidatos:

1. `registry.typesAccepting("Relationship[]")` retorna componentes com alguma entrada compatível diretamente.
2. Conversores registrados ampliam a lista (`Relationship[] → Graph` habilita `ia-graph`/`ultima-graph`; `→ Table` habilita `ultima-table`).
3. A ordenação usa: `suggests` explícito da ação > `displayHint` do tipo > uso recente do usuário no workspace > ordem alfabética.

- **R-SUG-1.** O usuário vê as sugestões como pequeno menu ("Mostrar como: Grafo · Tabela · Lista") e escolhe. A primeira opção pode ser pré-aplicada se a ação declarar `autoCreate: true`.
- **R-SUG-2.** Escolher uma sugestão cria a instância e a conexão numa única operação desfazível.
- **R-SUG-3.** O mecanismo é **determinístico e baseado em manifestos**. Qualquer parte de IA (agente que escolhe a visualização por intenção do usuário) fica em 08 e usa esse mesmo mecanismo como ferramenta.

## 4.8 Interação com drag-and-drop

Arrastar um objeto (uma entidade da tabela, uma notícia) para outro componente (notas, whiteboard) é uma ação de **soltar um valor tipado** na entrada do alvo.

- **R-DND-1.** Componentes declaram `drops: [{ type: "Entity", action: "attach" }]` no manifesto. O drag carrega o valor tipado como `Ref` (nunca o objeto inteiro de domínio).
- **R-DND-2.** O resultado do soltar é feito de acordo com o alvo: nas notas, insere um *chip* de referência (com rótulo e link); no whiteboard, cria um cartão referenciando o objeto.
- **R-DND-3** (F2). O soltar a partir do e para fora do workspace (arquivos do computador) entra com `file-store`.

## 4.9 Observabilidade do barramento

- **R-OBS-1.** Um painel de depuração (só para papéis `editor`/`owner` e ligado por flag) lista conexões, último valor (tipo + resumo), contagem de entregas e erros.
- **R-OBS-2.** Erros de entrega (tipo inválido, componente que lançou exceção em `onInput`) são isolados: o componente defeituoso vai para estado `error` visível, os demais continuam funcionando.
- **R-OBS-3.** No Inteligência Aberta, eventos relevantes (`ActionInvoked`, `ComponentCreated`, `ConnectionCreated`) são emitidos para o log operacional (ADR 005). A emissão **nunca levanta exceção** e nunca inclui o conteúdo do dado, apenas identificadores.
