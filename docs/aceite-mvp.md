# Aceite do MVP — rastreabilidade dos 23 critérios

Fonte dos critérios: `docs/especificacao/11-roadmap-mvp.md`, seção 11.5. Este documento diz, **critério por critério**, qual teste o cobre e **o que ainda não está provado**. ✅ = coberto por teste automatizado que falharia se o comportamento quebrasse; ◐ = coberto em parte (a lacuna está escrita); nenhum critério ficou sem cobertura.

Como rodar: `tests/run.sh` (navegador, rápido, sem servidor) · `tests/run_acceptance.sh` (várias pessoas contra o `agora-sync` real) · `cd server/agora-sync && npm test` · no repositório do Inteligência Aberta: `scripts/testar_agora_ia.sh` e `pytest tests/test_agora_*.py`.

| # | Critério | Estado | Evidência | O que falta provar |
|---|---|---|---|---|
| 1 | Criar workspace; adicionar notas/busca/tabela por arrasto e por teclado; mover, redimensionar, abas | ◐ | `acceptance A1` (arrasto da paleta sobre a borda do painel, mover, dividir); `F23` | "Por teclado" é provado **estruturalmente** (itens da paleta são `<button>`, o separador é focável com setas), não com eventos de teclado reais num leitor de tela. Os nomes `ia-table` e `ia-graph` do texto são `ultima-table`/`ultima-graph` |
| 2 | Fechar e reabrir: composição, config e notas idênticas | ✅ | `acceptance A2` (snapshot idêntico, **com o servidor inalcançável**) | — |
| 3 | Remover desfaz-se com *undo* | ✅ | `acceptance A3` (a instância e a conexão voltam) | — |
| 4 | Ação "mostrar conexões" cria grafo conectado, ao lado, em um passo desfazível | ✅ | `acceptance B4/B5`; testes M2 (`createLinked` é um passo); IA: `ia-entity → showRelations` | A ação chama-se "Mostrar como grafo" / "Mostrar relações" |
| 5 | Escolher uma pessoa no grafo faz `ia-news` mostrar as notícias dela | ✅ | IA `tests.js` "criterion 5" (Node → Entity); verificado no portal real com artefatos `documento` | Notícia = artefato `documento` que **menciona o nome** (busca textual), não um vínculo estruturado |
| 6 | Conexão incompatível é recusada com motivo legível | ✅ | `acceptance B6/B7`; testes de tipos e do barramento | — |
| 7 | Manifesto inválido faz `register()` falhar citando o campo | ✅ | `acceptance B6/B7`; testes do manifesto | — |
| 8 | Dois usuários veem criação, movimento e configuração em < 1 s numa rede local | ◐ | `acceptance C8`: ~10–15 ms (criar, mover, configurar), servidor local | Medido em **localhost**, não numa LAN real com latência |
| 9 | Edição simultânea de `ultima-notes` converge sem perda | ✅ | `acceptance C9` (digitando de verdade nas duas caixas); servidor: `two clients converge` | — |
| 10 | Presença: avatar, componente em foco, "Carlos selecionou…" sem vazar rótulo | ◐ | `acceptance C10`: quem está aqui, onde está, "digitando", e **nenhum conteúdo** na presença | "Carlos selecionou *X*" **não existe por decisão** (R-PRES-3): publicar o rótulo exigiria política por componente. O critério pede o aviso sem rótulo; hoje não há nem o aviso |
| 11 | Offline: editar localmente, reconectar, mesclar sem perda | ✅ | `acceptance C11` (edição offline + criação offline + edição alheia no meio); servidor: `goes offline… merges` | — |
| 12 | `viewer` não altera o documento nem adulterando o cliente | ✅ | `acceptance C12` (escrita direta no Yjs, burlando o cliente → servidor derruba); servidor: testes de papel. **Mutação:** desligar a checagem no servidor faz o C12 falhar | — |
| 13 | Mudança de papel em sessão vale sem recarregar | ✅ | `acceptance C13` (`/dev/role`); IA: portal → `agora-sync` verificado no navegador | — |
| 14 | Sem acesso: vê "sem acesso", e a referência não vaza no documento, presença ou chat | ◐ | IA: objeto de outra organização é 404 (backend) e "Sem acesso" (front); o documento só guarda ids; presença sem rótulo | O **chat** é texto livre: ninguém impede de digitar um nome lá, e as referências tipadas no chat (R-CHAT-3) são F2 |
| 15 | Dado `confidencial` não é gravado no IndexedDB | ◐ | IA: política de cache (`offline_cache.js`): acima do nível nunca é gravado, purga ao baixar; padrão da instância `restrito` | Vale **na configuração padrão**. Uma instância que ponha o teto em `confidencial` e uma pessoa que escolha esse nível passam a guardá-lo (decisão consciente, com aviso de não cifrado) |
| 16 | Eventos operacionais aparecem no painel do IA, sem conteúdo | ◐ | IA backend: eventos `agora.*` gravados com ids, sem conteúdo (testes) | Não foi verificado **visualmente** no painel `/eventos/` |
| 17 | Duplicar copia composição e notas, não dados de domínio | ✅ | `acceptance D17` | — |
| 18 | Chat em tempo real, persiste, menção notifica | ✅ | `acceptance E18` (~10 ms; histórico volta ao reabrir; viewer lê); servidor: 13 testes; portal real com duas pessoas | "Notifica" = contador, cor, título da aba e rótulo acessível; **não** há notificação do sistema operacional |
| 19 | Suíte de contrato passa em todos os componentes do MVP | ◐ | `contract:` percorre os 5 componentes do catálogo do núcleo (manifesto, portas, ações, contexto, capabilities fechadas) | Os componentes `ia-*` têm testes próprios, mas **não** passam pelo mesmo laço genérico de contrato |
| 20 | Sem build: `python3 -m http.server` + abrir executa o hospedeiro dev | ✅ | Todo o desenvolvimento e a verificação manual rodaram assim | — |
| 21 | Acoplamento: sem Yjs/LiveKit fora dos providers, sem domínio no núcleo | ✅ | `tools/verificar_acoplamento.py` em `tests/run.sh` e no CI; o verificador tem teste próprio (7 casos de violação) | — |
| 22 | Workspace de referência (≈ 20 instâncias, 5 participantes) fluido | ◐ | `acceptance F22`: 20 instâncias montadas em 8 ms, vistas por 4 outras em ~95 ms, mudança chega a todos em ~15 ms, pior atraso de timer 0 ms | Medido **nesta máquina**, não em "hardware modesto" |
| 23 | Teclado e leitor de tela: criar, adicionar, conectar, abrir o chat sem mouse | ◐ | `acceptance F23`: fluxo completo por controles nativos; varredura de **todos** os controles do shell (nomeados, alcançáveis por Tab) | Não testado com leitor de tela real nem com eventos de teclado reais |

**Contagem:** 14 ✅ · 9 ◐ · 0 sem cobertura. Os ◐ são limites de **medição ou de escopo** (LAN real, hardware modesto, leitor de tela, painel visual), e duas **decisões** que divergem da letra do critério (10 e 15); nenhum deles esconde um comportamento quebrado conhecido.

## O que a verificação com o servidor real encontrou (e os testes anteriores não)

- O viewer era desconectado ao conectar (um update vazio do handshake era tratado como escrita).
- O contêiner do `agora-sync` não conseguia gravar em `/data` (bind mount criado como root) — **nada era persistido**; e uma falha de disco no chat derrubava a conexão em vez de avisar. Corrigidos (entrypoint que ajusta a permissão e baixa privilégio; falha de gravação vira erro claro).
- Fontes em abas inativas não alimentavam o que dependia delas (montagem preguiçosa).
- O service worker podia servir uma versão antiga do app (cache HTTP do navegador) e não atualizava só com a lista nova.
