# 05. Colaboração e estado

## 5.1 Três tipos de estado

| Tipo | Exemplos | Persiste? | Sincronizado? | Onde |
|---|---|---|---|---|
| **Persistente colaborativo** | Instâncias, layout, config, conexões, notas, traços do quadro, visões salvas | Sim | Sim (CRDT) | `WorkspaceDocument` |
| **Efêmero compartilhado (presença)** | Usuário online, cursor, componente em foco, seleção atual, viewport, microfone/câmera, "digitando" | Não | Sim, em tempo real | Canal de presença |
| **Local** | Seleção local, scroll, painel aberto, último valor de porta, preferências de UI | Opcional (localStorage/IndexedDB do usuário) | Não | Cliente |
| **De domínio** | Entidades, alegações, evidências, artefatos | Sim | Não pelo Agora | API do domínio (ver 02.4.1) |

**R-STATE-1.** Cada dado tem **exatamente um** lar. Em dúvida entre "documento" e "local", escolher local.
**R-STATE-2.** O que vai para o documento deve fazer sentido **quando ninguém está online** (R-WS-3). Presença e seleção momentânea nunca entram no documento.

## 5.2 Abstração do estado colaborativo (`StateStore`)

O Agora não expõe o Yjs aos componentes. O núcleo trabalha com a interface:

```text
StateStore
  open(workspaceId) → WorkspaceDoc
WorkspaceDoc
  map(path) / list(path) / text(path)   → coleções observáveis
  transact(label, fn)                   → agrupa mudanças numa operação desfazível
  onChange(path, fn)
  undoManager                           → undo(), redo(), canUndo, canRedo
  snapshot() / restore(snapshot)
  awareness                             → ver 5.3
  status                                → "offline" | "connecting" | "synced" | "error"
```

**R-STORE-1.** Os componentes recebem apenas a fatia que a capability lhes concede (`this.shared` ≈ um `map` e um `text` sob `content[instanceId]`).
**R-STORE-2.** `YjsStateStore` é a implementação de referência. Outra (Automerge, ou um mock em memória para testes) deve poder substituí-la **sem alterar código fora de `adapters/` e `collaboration/providers/`**.
**R-STORE-3.** Existe um `MemoryStateStore` completo (sem rede) usado nos testes e no modo "workspace local, sem servidor".

### Providers de transporte

A mesma separação do Yjs: **document** × **providers**.

| Provider | Função | Fase |
|---|---|---|
| `IndexedDbPersistence` | Cache local, base do local-first | MVP |
| `WebSocketProvider` | Sincronização com o servidor | MVP |
| `BroadcastChannelProvider` | Abas do mesmo navegador | MVP (barato) |
| `WebRtcProvider` | P2P (LAN sem servidor) | F3 |

## 5.3 Presença

```text
Awareness (por participante)
{
  user:   { id, name, color, kind },
  focus:  { instanceId, element? },
  select: { instanceId, port, summary },      // "Empresa X"
  cursor: { instanceId, x, y } | null,
  view:   { scroll, zoom, visibleInstances },
  media:  { mic: bool, cam: bool, speaking: bool },
  typing: { instanceId } | null
}
```

- **R-PRES-1.** A presença é **efêmera**, tem *heartbeat* e expira sozinha (alguns segundos após a desconexão).
- **R-PRES-2.** A presença é **independente do domínio**. O campo `select.summary` é um texto curto produzido pelo componente (por exemplo o rótulo da entidade), sem dados sensíveis (ver R-PRES-3).
- **R-PRES-3. Privacidade.** O resumo de seleção é filtrado: o componente só publica o que o **espectador** pode ver. Em dúvida, publica apenas "selecionou algo em <componente>". O Agora oferece `presence.setSummary(text, { visibility })` e a política padrão é conservadora.
- **R-PRES-4.** O usuário pode se tornar "invisível" no nível de cursor/seleção (mas continua listado como participante, por transparência com os demais).
- **R-PRES-5.** Frequência de cursor limitada (~15 Hz) e coalescida.
- **R-PRES-6.** Mensagens como "Maria está editando as notas" são derivadas de `focus`/`typing`, não de eventos próprios.

## 5.4 Local-first

```text
Browser ── IndexedDB (documento + fila de updates) ── sincronização ── Servidor
```

- **R-LF-1.** Ao abrir um workspace, o cliente **renderiza a partir do IndexedDB** enquanto conecta. A UI mostra o estado de sincronização (`status`).
- **R-LF-2.** Offline, todas as operações de composição e edição colaborativa continuam. Na reconexão, mesclam sem perda por CRDT.
- **R-LF-3.** O que depende do servidor (consultas de domínio, agentes, chat, conferência) degrada de forma clara: o componente mostra o último dado em cache com indicação "offline", ou o estado vazio com explicação. Nunca falha em silêncio.
- **R-LF-4.** O cache de dados de domínio no cliente (se existir) respeita a classificação: dados `restrito`/`confidencial` **não** são guardados no IndexedDB sem política explícita (D-16) e são apagados no logout.
- **R-LF-5.** Dispositivo compartilhado: o logout limpa o cache local do usuário (opção "dispositivo público" no login do hospedeiro).
- **R-LF-6.** O documento local fica cifrado em repouso? **Em aberto** (D-17). Não é requisito do MVP, mas a decisão afeta ambientes isolados, que são alvo do Inteligência Aberta.

## 5.5 Conflitos

O CRDT garante convergência, mas não garante **intenção**. Pontos explícitos:

| Situação | Resultado | Mitigação |
|---|---|---|
| Dois usuários movem a mesma instância | Prevalece uma posição (última escrita por relógio lógico) | Aceitável; presença mostra que alguém está arrastando e bloqueia visualmente |
| Um remove a instância enquanto outro edita as notas dela | Remoção prevalece; conteúdo fica recuperável no histórico | Toast "removido por X", com *desfazer* durante alguns segundos |
| Duas conexões para uma entrada `multiple:false` | Convergem para uma; a outra é marcada `superseded` e some | Notificação |
| Edições de `config` simultâneas em campos diferentes | Mescladas por campo | Cada campo é uma chave do mapa, não um blob JSON |
| Edição de `config` incompatível com o esquema pós-mescla | Validação ao aplicar; valor inválido é revertido ao último válido localmente e sinalizado | Esquema na leitura é mais tolerante que na escrita |

**R-CONF-1.** `config` e `placement` são gravados **por campo** (mapas), e nunca como objeto JSON único, para que mudanças independentes não se sobreponham.
**R-CONF-2.** Há *soft lock* opcional (presença) em operações longas, como arrastar, para evitar disputas, sem impedir a edição.

## 5.6 Chat

Ver 06. Resumo da decisão de estado: as mensagens **não** ficam no documento do workspace (crescimento sem limite, política de retenção própria, permissão distinta). Têm armazenamento próprio no servidor, entregue em tempo real pelo mesmo canal, e uma cópia no cache local.

## 5.7 Histórico

### Undo/redo (MVP)

- **R-HIST-1.** O undo/redo é **por usuário** (só desfaz as próprias operações), com `transact(label, fn)` definindo a granularidade (mover instância, aplicar sugestão, executar ação com `create`).
- **R-HIST-2.** Operações de agentes são desfazíveis pelo humano que as pediu, e ficam marcadas na lista de histórico.
- **R-HIST-3.** O undo **não desfaz efeitos fora do documento** (consulta executada, mensagem enviada). Ele remove a instância criada, mas não "desconsulta". O Agora comunica isso quando a ação tinha efeito externo.

### Versões e auditoria (F2/F3)

- **R-HIST-4** (F2). Linha do tempo de alterações: quem, quando, o quê (instância criada/removida/configurada, conexão, nota).
- **R-HIST-5** (F2). *Snapshots* nomeados, comparação e restauração.
- **R-HIST-6** (F3). Fork/branch e merge entre workspaces.
- **R-HIST-7. Distinção essencial no Inteligência Aberta:** o **histórico da interface** (este documento) **não é** a **proveniência dos dados** (`Provenance`, `Claim`, `Evidence`). Os dois nunca são fundidos: um item de proveniência pode referenciar o workspace em que foi criado, e o histórico do workspace pode referenciar o dado, mas nenhum substitui o outro.
- **R-HIST-8.** O histórico guarda quem fez cada alteração com identidade verificada pelo servidor (não só autodeclarada no cliente). Ver D-18 sobre como compatibilizar CRDT com autoria confiável.

## 5.8 Compactação e crescimento

CRDTs acumulam histórico.
- **R-GC-1.** O servidor compacta periodicamente (*garbage collection*) o documento, respeitando a janela de snapshots/undo configurada.
- **R-GC-2.** Conteúdo de grande volume (traços de whiteboard, imagens coladas) tem limites e vai para componentes/armazenamento próprios.
- **R-GC-3.** Monitorar o tamanho do documento e avisar o dono quando se aproxima do limite (D-10).

## 5.9 Servidor de sincronização

Resumo; os detalhes de implantação estão em 09.

- **R-SYNC-1.** Um serviço independente (contêiner) mantém os documentos abertos em memória, persiste em disco/Postgres, repassa updates e presença, e aplica autorização.
- **R-SYNC-2. Autorização por documento e por papel.** Um `viewer` não consegue enviar updates de escrita. O servidor **rejeita** o que o papel não permite. Não basta esconder o botão no cliente.
- **R-SYNC-3.** O servidor valida a estrutura básica dos updates (limite de tamanho por update, taxa por conexão), mas **não** interpreta o conteúdo semântico.
- **R-SYNC-4.** Uma queda do servidor não impede o uso local (R-LF-2).
- **R-SYNC-5.** O servidor emite eventos operacionais (conexão, desconexão, erro, tamanho) para observabilidade, sem conteúdo.

## 5.10 Riscos conhecidos

1. **Autoria confiável vs. CRDT.** Autoria por operação exige que o servidor carimbe a identidade; na primeira versão, o servidor aceita updates apenas de conexões autenticadas e registra autoria por conexão/sessão (D-18).
2. **Permissão por componente** (além do workspace) é difícil num CRDT único. No MVP o papel vale para o workspace inteiro (conforme a proposta, seção 42). Granularidade maior exigiria sub-documentos (um por instância de conteúdo sensível). A estrutura `content[instanceId]` foi escolhida para permitir isso depois sem quebrar o esquema (D-19).
3. **Tamanho e desempenho** de documentos com muitos componentes ou traços de whiteboard.
4. **Bibliotecas sem build**: Yjs e seus providers precisam de um bundle ESM copiado para `vendor/` (D-06).
