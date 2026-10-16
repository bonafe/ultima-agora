# 01. Visão e princípios

## 1.1 Problema

Aplicações web tradicionais fixam o fluxo de trabalho em telas predefinidas pelo desenvolvedor (`menu → consulta → detalhe → relatório`). Isso funciona para processos lineares, mas não para trabalho **exploratório e colaborativo** como a investigação. Nela o caminho (notícia → pessoa → empresa → contrato → documento → evidência → nova pessoa) não é conhecido de antemão, e várias pessoas precisam enxergar e manipular o mesmo contexto ao mesmo tempo.

## 1.2 Proposta

O Ultima Agora é um ambiente em que o **usuário compõe o próprio espaço de trabalho** com componentes vivos e interoperáveis, e em que a **colaboração é nativa**. O resultado, o **workspace**, é ao mesmo tempo:

- interface;
- contexto de trabalho;
- registro do raciocínio (o que foi aberto, ligado e anotado);
- ambiente de colaboração (presença, chat, áudio, vídeo, notas, quadro).

O workspace é **persistente**. Quando todos saem, ele continua existindo e na próxima sessão está como foi deixado.

## 1.3 Posicionamento

O Agora **não é** um sistema de videoconferência, um whiteboard, um dashboard, um construtor de páginas, um editor low-code ou um editor de fluxos. Ele toma emprestada uma ideia de cada um e combina todas em outra coisa:

| Inspiração | O que se aproveita | O que não se copia |
|---|---|---|
| BigBlueButton | Comunicação, notas e quadro no mesmo ambiente | A reunião como unidade central |
| LangGraph / editores de nós | Componentes como nós relacionáveis | A execução de grafos como finalidade |
| Miro / tldraw | Organização livre de elementos | O quadro infinito como modelo único de layout |
| Dashboards configuráveis | Componentes de visualização arrumáveis | A leitura passiva |

## 1.4 Atores

| Ator | Descrição |
|---|---|
| **Usuário** | Pessoa que compõe e usa workspaces. Seu papel num workspace é `owner`, `editor`, `participant` ou `viewer`. |
| **Desenvolvedor de componentes** | Escreve componentes `ultima-*` (genéricos) ou componentes de domínio (`ia-*`). |
| **Desenvolvedor de aplicação** | Instala um conjunto de componentes e serviços de domínio sobre o Agora (por exemplo, o Inteligência Aberta). |
| **Agente** | Participante automatizado. Atua pelo mesmo contrato de ações e permissões dos humanos, com identidade própria. |
| **Operador** | Implanta e mantém o servidor de sincronização, a conferência e o backend. |

## 1.5 Não objetivos iniciais

Mantém-se a lista da proposta e acrescentam-se itens que precisam ser explícitos:

- Substituto completo do Miro, do BigBlueButton, de IDE visual, de plataforma no-code, de editor gráfico profissional, de motor de workflow ou de framework de IA.
- Pilha própria de WebRTC (codecs, transporte, SFU). Usa-se a API nativa do navegador (`RTCPeerConnection`) para o provider em malha e o LiveKit para escala (D-36).
- **Reescrever o UltimaJS.** O Agora o usa como está, com no máximo contribuições pequenas e compatíveis.
- **Ser o banco de dados da aplicação.** O documento colaborativo não armazena entidades de domínio (ver 02 e 05).
- **Substituir telas tradicionais.** Formulários e páginas continuam válidos e convivem com os workspaces (seção 50 da proposta).
- **Garantir sincronização sem servidor (P2P puro)** no MVP. O local-first exige que o cliente funcione offline, mas a sincronização usa um servidor.

## 1.6 Princípios

Os nove princípios da proposta ficam como estão. Cada um recebe um critério verificável:

| Princípio | Critério verificável |
|---|---|
| **Vanilla quando possível** | Nenhum framework de UI no núcleo; nenhum passo de build para executar o núcleo. |
| **Composição sobre telas fixas** | Toda funcionalidade de usuário é entregue como componente registrável; o shell não tem telas específicas de domínio. |
| **Domínio fora do núcleo** | `core/`, `collaboration/`, `conference/`, `ui/` não contêm os termos de domínio da aplicação (`Entity`, `Claim`, `Evidence`...). Verificável por busca de texto em CI. |
| **Colaboração nativa** | Toda mudança de composição é uma operação sobre o documento compartilhado. Não existe caminho de mutação local que ignore o documento. |
| **Local-first** | Com a rede cortada, o usuário abre, edita e reabre um workspace já visitado. As mudanças sincronizam na reconexão. |
| **Interfaces tipadas** | Toda porta, ação e configuração tem tipo declarado no manifesto, e uma conexão incompatível é recusada com motivo. |
| **Baixo acoplamento** | Yjs, LiveKit, Django e PostgreSQL só aparecem atrás de adaptadores (`adapters/`, `providers/`). Os componentes não os importam. |
| **Código legível** | Mantém-se a separação `componente.html` / `componente.js` / `componente.css`, e um componente típico fica abaixo de ~400 linhas por arquivo. |
| **Usuário controla o espaço** | Nenhuma ação automática (sugestão, agente) cria, move ou remove componentes sem registro e sem possibilidade de desfazer. |

## 1.7 Convenções herdadas

Para garantir aderência ao ecossistema existente:

**Do UltimaJS**
- Arquivos `.js` / `.html` / `.css` separados por componente. O `.js` passa `import.meta.url` ao construtor.
- A configuração do construtor é `{ templateUrl, shadowDom }`.
- Pontos de extensão: `onLoad()` e `whenLoaded()` (nunca checar `LOADED_EVENT` à mão).
- Estado reativo em `state` / `data-state`. Template com `data-bind`, `data-if`/`data-else-if`/`data-else` e `data-for` (com chave).
- Sem `package.json` e sem bundler. Testes em `tests/`, executados no navegador, sem dependências, com `tests/run.sh` para o modo headless. Cada correção de bug vem com teste.
- `CHANGELOG.md` para mudanças visíveis.
- O core do UltimaJS é **copiado** para dentro do projeto (`vendor/ultima/`), como o `espaco` faz, com a versão (`ComponentBase.VERSION`) registrada.

**Do Inteligência Aberta**
- Documentos em português. ADRs numerados em `docs/arquitetura/decisoes/` (as decisões desta especificação que virarem definitivas devem virar ADR).
- UUIDs como identificadores.
- Observabilidade que nunca derruba o fluxo (`emit()` sem exceções) e logs append-only com projeções reconstruíveis.
- Deploy em contêineres com Docker Compose. Segredos validados na subida.
- Comandos de ação sensíveis são auditados.
- Interface de voz é cidadã de primeira classe (ADR 004). O Agora deve preservar isso (ver [06](06-comunicacao.md) e [07](07-shell-layout-ui.md)).

**Do `espaco` (aprendizado, não herança de código)**
- O `espaco` já provou persistência local por IndexedDB e a ideia de visualizações trocáveis. O Agora generaliza para múltiplos usuários e componentes com contrato. Lições a levantar do seu `08-known-technical-debt.md` antes de começar o código do shell.
- O nome "Workspace" já existe no `espaco` (classe `Workspace`, tag `workspace-ultima`). No Agora, a tag do shell é `agora-shell`, e o termo "workspace" designa o **documento**.
