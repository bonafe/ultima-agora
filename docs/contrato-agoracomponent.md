# Contrato do componente — versão 1 (congelado no M2)

Decisão **D-04**: o contrato foi congelado ao fim do M2, depois de quatro componentes reais (`ultima-text`,
`ultima-notes`, `ultima-table`, `ultima-graph`) e do barramento tipado. Mudar o que está abaixo exige
nova versão do contrato (`AgoraComponent.CONTRACT_VERSION`), migração dos componentes e entrada no `CHANGELOG`.
Acrescentar capacidades **opcionais** não quebra o contrato.

## Manifesto (`*.manifest.json`)

| Campo | Regra |
|---|---|
| `name`, `tag` | minúsculas com hífen; iguais |
| `title`, `version` (SemVer), `module` | obrigatórios; `module` relativo ao manifesto |
| `category`, `description` | paleta e busca |
| `inputs.<porta>` | `{ type, multiple?, required? }` — `type` precisa estar em `registry.types` |
| `outputs.<porta>` | `{ type, retained? }` — `retained: false` entrega uma vez, sem repetir a quem chega depois |
| `actions.<nome>` | `{ title, effect: self\|state\|emit\|feed\|create, port?, produces?, suggests?, autoCreate? }` |
| `config.<campo>` | `{ type, default?, min?, max?, values?, title? }` |
| `capabilities` | `connectable`, `shared-content`, `presence-aware`, `domain-data`, `chat`, `conference`, `resizable`, … (`chat` and `conference` were added after the freeze: adding an OPTIONAL capability does not break contract v1) |

Regras de ação: `emit` e `create` exigem `port` (saída do próprio componente); `create` exige `produces`, igual ao tipo
dessa saída. `suggests` ordena os componentes oferecidos para exibir o resultado.

## Classe (`AgoraComponent`)

Entrada (o que o componente **recebe**): `attach()` é chamado pelo shell antes do carregamento; depois
`config` (somente leitura, com os defaults), `instanceId`, `manifest`, e os serviços guardados por capability
(`ports`, `shared`, `presence`, `domain` — acesso sem a capability declarada falha dizendo qual falta).

Pontos de extensão (o que o componente **sobrescreve**):

| Método | Quando |
|---|---|
| `onLoad()` | depois do template; chamar `super.onLoad()`. Aqui o componente deve **emitir o estado inicial** |
| `onConfig(config)` | a configuração da instância mudou |
| `onInput(port, valor)` | chegou valor numa entrada (`undefined` = desconectada). Valores recebidos antes de `onLoad` ficam em fila, o último por porta |
| `onAction(nome, args)` | ação do manifesto; pode ser assíncrona; o retorno é o resultado |
| `describeContext()` | resumo (não dados completos) para agentes |
| `onDispose()` | a instância foi removida de vez (mover entre painéis **não** chama) |

Saída (o que o componente **chama**): `this.emit(porta, valor)`, `this.setConfig(patch)`.

## Regras para quem escreve componentes

1. **Saídas são estado local derivado.** O documento guarda as conexões, não os valores. Ao carregar ou mudar a
   configuração, o componente emite de novo o que produz (aprendido no M2: um grafo conectado ficava vazio
   depois de recarregar porque a saída só existia por causa de uma ação).
2. Emitir só portas e tipos declarados; o barramento valida o valor e recusa o inválido.
3. Valores que atravessam portas são JSON e pequenos; dados volumosos viajam como referência (`Ref`).
4. Elementos SVG não têm a propriedade `hidden`: use `toggleAttribute('hidden')`.
5. Não repintar a árvore inteira ao receber `onInput` quando houver foco em campo de texto do componente.
