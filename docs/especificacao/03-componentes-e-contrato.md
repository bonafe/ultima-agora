# 03. Componentes e contrato

## 3.1 Camadas

**Decisão D-02 (2026-10-04): o UltimaJS evolui para suportar mixins/capabilities.** O Agora não duplica no seu lado o que pertence ao framework.

```text
UltimaJS       ComponentBase → ReactiveComponent + mecanismo de mixins (novo, genérico)
Ultima Agora   AgoraComponent = ReactiveComponent + Connectable + Collaborative + ContextProvider …
Aplicação      ia-graph, ia-news, …  (estendem AgoraComponent ou aplicam as mixins que precisam)
```

**R-CMP-1.** Todo componente do catálogo é um `AgoraComponent`. Um componente só visual pode estender `ReactiveComponent` e ser envolvido por um *adapter* (ver 3.7).

**R-CMP-2. Divisão de responsabilidade entre os projetos.**
- **No UltimaJS** entra apenas o **mecanismo genérico**: aplicar mixins a uma classe de componente (`class X extends mix(ReactiveComponent).with(A, B)`), com ordem de composição definida, hooks de ciclo de vida encadeáveis (`onLoad`, `onDispose`) e conflitos de nome detectados. Nada de colaboração, portas, workspace ou domínio.
- **No Agora** ficam as mixins concretas: `Connectable` (portas), `Collaborative` (conteúdo compartilhado), `PresenceAware`, `ContextProvider`, `DomainAware`, e a composição pronta `AgoraComponent`.
- Mudanças no UltimaJS seguem as regras dele: sem build, sem dependências, teste em `tests/` com cada mudança, `CHANGELOG.md` e `ComponentBase.VERSION`. Devem ser **retrocompatíveis**: os componentes existentes (inclusive o `espaco`) continuam funcionando sem alteração.
- O Agora exige UltimaJS **≥ 0.3.0** (primeira versão com `mix()`, `src/mixins.js`, já publicada na `master` do `ultima`). O protótipo foi validado: `#state` privado, `observedAttributes` e `onLoad` encadeado funcionam através das mixins.

**R-CMP-3. Mixins × capabilities.** Cada mixin corresponde a uma capability do manifesto (3.5). A mixin só **é aplicada/ativada** se o manifesto declarar a capability, e um componente que não declara `shared-content` não recebe `this.shared`. A composição fica no manifesto e a implementação em classes pequenas e independentes, e evita a herança profunda `Component → Reactive → Collaborative`.

**Validado (M0):** o mecanismo de mixins preserva o `#state` privado, `observedAttributes` e `import.meta.url` do `ComponentBase`/`ReactiveComponent` (testes no UltimaJS e no Agora).

## 3.2 Estrutura de arquivos de um componente

Mantém a convenção do UltimaJS:

```text
components/notes/
├── ultima-notes.js          # classe, importa AgoraComponent
├── ultima-notes.html        # template
├── ultima-notes.css
└── ultima-notes.manifest.json    # manifesto declarativo (ver 3.3)
```

O manifesto fica em arquivo JSON próprio, não embutido na classe, por duas razões. O catálogo pode **listar componentes sem baixar o código** (paleta, validação de conexões, contexto de agente). E agentes e ferramentas podem lê-lo sem executar JavaScript.

> A proposta usa YAML nos exemplos. O formato de arquivo é JSON, porque o navegador o lê nativamente e não há build. O conteúdo é o mesmo (D-03).

## 3.3 Manifesto

```json
{
  "name": "ia-graph",
  "title": "Grafo",
  "version": "1.0.0",
  "category": "intelligence",
  "icon": "assets/graph.svg",
  "module": "./ia-graph.js",
  "tag": "ia-graph",
  "description": "Visualiza entidades e relações.",

  "inputs": {
    "entities":      { "type": "Entity[]",       "required": false },
    "relationships": { "type": "Relationship[]", "required": false }
  },
  "outputs": {
    "selectedEntity":       { "type": "Entity" },
    "selectedRelationship": { "type": "Relationship" }
  },
  "actions": {
    "expand": { "title": "Expandir", "input": "Entity",  "effect": "self" },
    "center": { "title": "Centralizar", "input": "Entity", "effect": "self" },
    "filter": { "title": "Filtrar", "input": "FilterSpec", "effect": "self" }
  },
  "config": {
    "depth":  { "type": "integer", "default": 2, "min": 1, "max": 5, "title": "Profundidade" },
    "layout": { "type": "enum", "values": ["force", "tree"], "default": "force" }
  },
  "capabilities": ["resizable", "connectable", "context-provider"],
  "defaultSize": { "w": 6, "h": 8 },
  "permissions": { "requiresDomainAccess": true }
}
```

### Campos

| Campo | Obrigatório | Descrição |
|---|---|---|
| `name`, `tag` | sim | Identificador único e tag do custom element. Precisam ser iguais, salvo exceção documentada. Prefixo: `ultima-` (núcleo), ou o prefixo da aplicação (`ia-`). |
| `title`, `description`, `category`, `icon` | sim (`icon` e `description` recomendados) | Paleta e busca. |
| `version` | sim | SemVer. A mudança incompatível em portas/config exige MAJOR. |
| `module` | sim | Caminho do módulo ES, relativo ao manifesto. |
| `inputs` / `outputs` | não | Portas tipadas (ver 04). |
| `actions` | não | Ações expostas (ver 04.6). |
| `config` | não | Esquema da configuração por instância (ver 3.4). |
| `capabilities` | não | Capacidades solicitadas (ver 3.5). |
| `defaultSize` | não | Tamanho inicial no grid. |
| `permissions` | não | Requisitos de acesso (ver 09). |
| `migrations` | não | Referência a função de migração de `config`. |

**R-MAN-1.** O manifesto é validado no `register()`. Manifesto inválido faz o registro falhar com mensagem que cita o campo.
**R-MAN-2.** Um tipo de porta referenciado precisa existir no `TypeRegistry` (ver 04.2) no momento do registro, ou ser registrado pelo mesmo pacote.
**R-MAN-3.** O manifesto é a **única** fonte de verdade de portas, ações e config. O código do componente pode ser consistente com ele, e uma verificação automática (teste de contrato, 3.8) compara os dois.

## 3.4 Esquema de configuração

Um subconjunto pequeno e fechado de tipos, suficiente para gerar o **inspetor** automaticamente (ver 07):

`string`, `text`, `integer`, `number`, `boolean`, `enum`, `color`, `date`, `reference` (referência a objeto de domínio, com `refType`), `list<T>`.

Cada campo aceita `default`, `title`, `description`, `min`/`max`, `required` e `visibleIf` (condição sobre outros campos da mesma config).

Um componente que precise de configuração mais rica pode fornecer um **editor próprio** (`configEditor: "./graph-config.js"`). O inspetor genérico serve de fallback e continua mostrando os campos básicos.

## 3.5 Capabilities

Capacidades que o Agora concede quando declaradas. O conjunto inicial é fechado e cresce por versão do contrato:

| Capability | Concede | Fase |
|---|---|---|
| `resizable` | Participa do redimensionamento do layout e recebe `onResize(w,h)` | MVP |
| `connectable` | Portas ligáveis no barramento (`this.ports`) | MVP |
| `shared-content` | `this.shared`: nó de conteúdo colaborativo próprio | MVP |
| `presence-aware` | `this.presence`: publicar/ler presença do componente (seleção, cursor) | MVP |
| `context-provider` | Participa do contexto entregue aos agentes (`describeContext()`) | F2 |
| `domain-data` | `this.domain`: cliente da API de domínio, com a permissão do usuário | MVP |
| `file-store` | `this.files`: enviar/obter arquivos no armazenamento de objetos | F2 |
| `agent-callable` | Ações visíveis para agentes | F2 |

**R-CAP-1.** Acesso sem capability declarada falha com erro claro (`this.shared` é `undefined` e acessar produz mensagem que aponta a capability faltante).

## 3.6 `AgoraComponent`: superfície mínima

Além do que o `ReactiveComponent` já oferece (`state`, `data-state`, templates `data-*`, `onLoad()`, `whenLoaded()`), a base do Agora oferece:

```js
class AgoraComponent extends ReactiveComponent {
  // injetados pelo shell antes de onLoad()
  instanceId        // id da instância no workspace
  config            // configuração validada (leitura); alterar via this.setConfig()
  ports             // se "connectable": { in: {}, out: {} }
  shared            // se "shared-content": interface de conteúdo colaborativo (ver 05.2)
  presence          // se "presence-aware"
  domain            // se "domain-data"

  setConfig(patch)                    // grava na instância (operação do documento)
  emit(portName, value)               // publica numa porta de saída
  onInput(portName, value) {}         // sobrescrito: chega valor numa entrada
  onAction(name, args) {}             // sobrescrito: execução de ação
  describeContext() { return {} }     // sobrescrito: o que o agente pode saber
  onRole(role) {}                     // papel mudou: editor→viewer, etc.
  onDispose() {}                      // limpeza (remoção ou fechamento)
}
```

Observações:

- `emit()` e `onInput()` substituem o `this.emit("entity:selected", …)` / `this.on(…)` do exemplo da proposta. Eles são **tipados e vinculados ao manifesto**: emitir uma porta não declarada ou com valor fora do tipo falha em desenvolvimento e é descartado com aviso em produção.
- O nome e o formato exatos desta API são **o contrato mais caro de mudar depois**. Por isso o MVP implementa `AgoraComponent` com poucos componentes reais (`ultima-notes`, `ultima-table`, `ia-entity`, `ia-graph`) antes de congelar (D-04).
- Eventos DOM comuns (clique, input) continuam funcionando; o barramento é só para a **comunicação entre instâncias**.

### 3.6.1 Ciclo de vida de uma instância

```text
registrada → criada (operação no documento)
          → montada (custom element criado; ComponentBase carrega template)
          → onLoad()  (UltimaJS) → capabilities injetadas → portas ligadas
          → ativa (recebe inputs, ações, mudanças de papel, atualizações de shared)
          → desmontada (removida ou workspace fechado) → onDispose()
```

**R-LIFE-1.** O Agora só entrega `onInput`/`onAction` depois de `onLoad()`; valores chegados antes ficam em fila (por porta, mantém o último valor).
**R-LIFE-2.** Montagem preguiçosa: instâncias fora da viewport/aba ativa podem ser montadas sob demanda, **desde que mantenham as portas de saída consultáveis** (o último valor emitido persiste no barramento, não no componente).
**R-LIFE-3.** `shadowDom` fica a critério do componente. Componentes que usam bibliotecas que manipulam o DOM global (como editores) podem usar `shadowDom: false`, e o Agora não deve assumir nenhum dos dois.

## 3.7 Registro de componentes

```js
Agora.register({
  manifest: graphManifest,           // objeto ou URL do .manifest.json
  load: () => import("./ia-graph.js")   // carregamento sob demanda
});
```

**R-REG-1.** O registro lê manifestos primeiro, e o código só é carregado quando uma instância é criada (ou para pré-visualização). A paleta depende só de manifestos.
**R-REG-2.** `ComponentRegistry` oferece: `register`, `unregister`, `get(name)`, `list({category, search})`, `typesProducing(typeName)`, `typesAccepting(typeName)` (para o mecanismo de sugestão, ver 04.7), e eventos `registered`/`unregistered`.
**R-REG-3.** Aplicações instalam pacotes via `Agora.use(pack)`, em que `pack = { name, version, components: [...], types: [...], services: {...}, templates: [...] }`.
**R-REG-4.** Nomes colidindo geram erro, a menos que a segunda definição declare `replaces` com a versão substituída (útil em testes).
**R-REG-5** (F3). Componentes remotos (de outra origem) exigem assinatura/SRI e isolamento. Fora do MVP (D-13).

### Adapter para componentes que não são do Agora

Qualquer Custom Element pode ser exposto no catálogo por um manifesto que declare o mapeamento para atributos/propriedades/eventos do elemento (`adapter: { inputs: {entities: "prop:entities"}, outputs: {selectedEntity: "event:select"} }`). Isso permite reaproveitar componentes existentes, inclusive os do `espaco`.

## 3.8 Testes de contrato

Segue a convenção do UltimaJS (`tests/`, sem dependências, executável no navegador e headless):

- **Contrato de manifesto:** valida esquema e referências de tipos.
- **Contrato de componente:** monta o componente numa instância de teste (`Agora.test.mount(name, config)`), verifica que ele só emite portas declaradas, que suas ações existem e que `describeContext()` serializa em JSON dentro do limite.
- **Contrato de capacidade:** acesso sem capability produz o erro esperado.

Todo componente do catálogo (do núcleo e da aplicação) deve passar na suíte de contrato para ser empacotado.
