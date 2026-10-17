# 07. Shell, layout e UI

O **shell** é a aplicação do Agora: `agora-shell`, um custom element UltimaJS que hospeda o workspace e o chrome em volta dele (barra superior, paleta, inspetor, presença, chat).

## 7.1 Estrutura da interface

```text
┌───────────────────────────────────────────────────────────────┐
│ Barra: título do workspace · sync · participantes · 🎤 📹 💬 ⚙ │
├────────────┬──────────────────────────────────────┬───────────┤
│ Paleta     │                                      │ Inspetor  │
│ (catálogo) │            Workspace                 │ (instância│
│            │   [instâncias em layout/canvas]      │ selecion.)│
│            │                                      │           │
│            │              presença · tiles de vídeo · chat     │
└────────────┴──────────────────────────────────────┴───────────┘
```

**R-UI-1.** Paleta, inspetor e chat são **recolhíveis**. O conteúdo deve poder ocupar a tela quase toda (o conteúdo é o centro, ver proposta 56).
**R-UI-2.** O shell não contém nenhuma tela de domínio. Tudo que é específico (ex.: busca de empresa) é um componente.
**R-UI-3.** O shell é composto de componentes UltimaJS (`agora-palette`, `agora-inspector`, `agora-workspace`, `agora-toolbar`, `agora-presence`), cada um substituível para temas/hospedeiros.

## 7.2 Paleta

- **R-PAL-1.** Construída a partir do `ComponentRegistry` (manifestos), agrupada por `category`, com busca por título/descrição.
- **R-PAL-2.** Adicionar um componente por **arrastar** para o workspace e por **clique/Enter** (cria no local padrão). Ambos têm paridade (acessibilidade).
- **R-PAL-3.** Pré-visualização opcional (ícone + descrição + portas), e não renderiza o componente real.
- **R-PAL-4.** Mostra só componentes cuja `permissions.requiresDomainAccess` o usuário satisfaz.
- **R-PAL-5.** Filtra por papel: `viewer` e `participant` não adicionam componentes (dependendo da política do workspace, D-22).

## 7.3 Modelos de layout

A proposta lista quatro modos (Workspace, Canvas, Apresentação, Dashboard) e pede que o MVP **não** tente o canvas infinito. A especificação define um **modelo de layout abstrato**, para que os modos sejam variações do mesmo contrato:

```text
LayoutEngine
  place(instanceId, hint)            → placement
  move/resize(instanceId, delta)
  remove(instanceId)
  serialize() / restore(data)        → grava em doc.layout
  mode: "grid" | "dock" | "canvas" | "presentation"
```

### MVP: modo Workspace (grid + docking)

- **R-LAY-1.** Grid de colunas fixas (12) com arrastar e redimensionar instâncias, colisão resolvida empurrando para baixo.
- **R-LAY-2.** **Abas:** várias instâncias podem compartilhar a mesma célula como abas.
- **R-LAY-3.** **Divisões** horizontais e verticais recursivas (árvore de painéis) como alternativa ao grid. Escolha de uma das duas como o modelo único do MVP é a decisão D-23. Recomendação: **árvore de painéis com abas** (docking), por ser a que melhor combina com a ideia de "divisões" e "abas" da proposta. O grid puro fica como modo posterior de dashboard.
- **R-LAY-4.** Maximizar uma instância temporariamente (por usuário, sem alterar o layout compartilhado).
- **R-LAY-5.** Cada usuário pode ter **viewport/visão local** (qual aba está aberta, painel maximizado), que não altera o layout compartilhado. Alterações estruturais (adicionar, mover, redimensionar) alteram o compartilhado.
- **R-LAY-6.** Em telas estreitas (tablet/telemóvel), layout em **coluna única com abas**, derivado do mesmo documento. Edição de layout fica limitada nesses dispositivos.

### Fases seguintes

- **Canvas** (F3): posição livre, zoom/pan, possivelmente infinito. Usa `placement: { mode: "canvas", x, y, w, h }`.
- **Apresentação** (F3): sequência de **visões** (subconjuntos de instâncias + layout + estado de config). Dependem de `savedViews` (R-VIEW-1).
- **Dashboard** (F3): grid otimizado, atualização periódica, sem edição.

**R-LAY-7.** Mudar de modo **não perde dados**. Cada instância mantém `placement` por modo, e a ausência de placement no novo modo recebe posição automática.

### Janelas destacadas (flutuantes e outras janelas do navegador)

- **R-LAY-8.** Qualquer componente pode ser **destacado** do painel: (a) numa **janela flutuante** sobre o workspace (mover pela barra de título, redimensionar pela borda, teclado: setas movem, Enter reacopla) ou (b) numa **outra janela do navegador** (multi-monitor). Duplo clique na aba flutua; arrastar a aba **para fora da janela do navegador** abre a outra janela onde o ponteiro foi solto; o menu `⋯` oferece ambos.
- **R-LAY-9.** Destacar é **visão local** (R-LAY-5): o componente continua no seu painel no layout compartilhado (os colegas o veem acoplado); só neste navegador ele é desenhado fora. A aba fica marcada `⧉` e mostra "Mostrar / Reacoplar aqui".
- **R-LAY-10.** **Binding:** o componente **não é recriado nem recarregado**. O mesmo elemento vivo muda de lugar no DOM (para a janela flutuante, ou para o documento da outra janela). O código segue rodando na janela principal, então documento, portas e barramento continuam ligados sem protocolo de mensagens. Consequências: a janela principal precisa ficar aberta (fechá-la encerra as outras janelas; ao recarregar, tudo volta acoplado); fechar ou recarregar a outra janela reacopla; um componente que escuta o `document` global só ouve a janela principal.
- **R-LAY-11.** Soltar: o destaque mostra exatamente o que o soltar fará (aba na posição, dividir o painel, dividir o workspace inteiro pela borda). Soltar na barra de abas insere/reordena. `Esc` cancela o arrasto.
- **R-LAY-12.** **Janelas pessoais:** além dos componentes do documento, o shell pode ter janelas só da visão da pessoa (a chamada). Flutuam, vão para outra janela do navegador e se escondem como as outras, e **acoplam ao lado de qualquer painel** (aba ou divisão), só na visão da pessoa: a árvore compartilhada é desenhada com a janela pessoal costurada, sem escrever nada no documento (se o painel de onde ela pende some, ela passa a flutuar); esconder as guarda fora da tela e o que elas executam (a chamada) continua. A janela da chamada contém um workspace local e pessoal, com uma janela por pessoa, com o mesmo docking, abas, flutuação e destaque (R-CONF-2).

### Apresentação compacta (celular e janelas estreitas)

- **R-LAY-13.** O workspace escolhe a apresentação pela **largura da própria caixa** (abaixo de 720 px), não pela da tela: uma janela de navegador estreita também fica compacta. Compacto é **outra apresentação do mesmo documento**, nunca outro documento: a árvore de painéis é achatada na ordem de leitura (`flattenTree`) e **uma janela por vez** ocupa a caixa, com uma barra inferior (as 4 primeiras janelas, sempre incluindo a ativa, e "☰" com a lista completa). Qual está ativa é visão local (R-LAY-5). Os elementos vivos são **movidos, nunca recriados** ao trocar de apresentação, e todos continuam montados (as conexões seguem valendo com a janela escondida).
- **R-LAY-14.** No compacto: janelas flutuantes aparecem na lista (voltam a flutuar quando a caixa alarga); **usar e compor leve**: abrir, ler, escrever, adicionar (a paleta vira folha), renomear e fechar; **dividir e acoplar ficam para caixas largas**. Quem só pode ler não renomeia, fecha nem adiciona.
- **R-LAY-15.** Uma janela escondida que **recebe valor pelo barramento** (a tabela mudou o que o grafo mostra) ganha um ponto na barra, apagado quando é vista; só janelas já vistas pelo menos uma vez recebem o ponto.
- **R-LAY-16.** O shell, também pela largura da própria caixa: o cabeçalho mostra só o essencial e o resto fica atrás de "⋯"; paleta, inspetor e chat viram **folhas de baixo, uma por vez**, com um fundo que fecha; adicionar um componente fecha a folha. A **chamada** vira tela cheia ou, minimizada, uma **mini-barra** (quem fala, microfone, câmera, sair) acima da barra de janelas: o áudio não para ao trocar de janela.

## 7.4 Inspetor

Permite configurar a instância selecionada sem telas administrativas específicas.

Seções:

1. **Dados:** config do manifesto (campos gerados a partir do esquema, 3.4).
2. **Visual:** opções de aparência (se o componente expor).
3. **Conexões:** entradas ← origens, saídas → destinos; criar, trocar e remover conexões; mostrar compatíveis.
4. **Ações:** lista as ações executáveis sobre o estado atual (4.6).
5. **Informações:** tipo, versão, criada por/quando, id (copiável, útil para chat e suporte).

- **R-INS-1.** Campos do inspetor são gerados automaticamente. Um `configEditor` customizado pode substituir a seção Dados.
- **R-INS-2.** Alterações no inspetor são operações do documento (colaborativas e desfazíveis). Edição simultânea do mesmo campo mostra quem está editando (presença).
- **R-INS-3.** Para `viewer`, o inspetor é somente leitura.

## 7.5 Visões salvas

- **R-VIEW-1** (F2). `savedViews`: um instantâneo nomeado de combinação *(instâncias visíveis, layout, config, seleções fixadas)* que pode ser restaurado ou usado como passo de apresentação.
- No MVP, o equivalente é "filtros salvos" dentro da `config` de cada componente.

## 7.6 Presença na interface

- Lista de participantes na barra superior (avatares, cor, indicação de microfone/câmera/falando).
- Rótulos nos componentes: borda colorida e etiqueta ("Maria") no componente em que alguém está em foco.
- Indicador "X está editando as notas", "Carlos selecionou Empresa X".
- Cursor dos colegas apenas dentro de componentes que o suportam (notas, quadro) e sobre o canvas em modo canvas.
- **R-PRES-UI-1.** A presença **não pode competir com o conteúdo**: pequena, translúcida, e desligável por usuário.
- **R-PRES-UI-2.** Entrar/sair de participantes é anunciado discretamente (região `aria-live` polida).
- **R-PRES-UI-3. "Seguir":** clicar num participante permite acompanhar sua vista (aba/painel/maximizado). É local e opt-in.

## 7.7 Tema e identidade visual

- **R-THEME-1.** Estilos via **variáveis CSS** no shell (`--agora-*`), que atravessam o Shadow DOM e permitem tema claro/escuro e contraste elevado. Componentes de terceiros são estilizados pelas variáveis, não por seletores do shell.
- **R-THEME-2.** A aplicação hospedeira pode definir seu tema (o Inteligência Aberta aplicaria a sua identidade).
- **R-THEME-3.** Mensagem de produto: "este é um lugar onde estamos trabalhando juntos". Presença e participantes são visíveis, mas discretos.

## 7.8 Acessibilidade e internacionalização

- **R-A11Y-1.** Todo o shell e os componentes do núcleo operáveis por **teclado**, com foco visível e ordem coerente, e rótulos ARIA. Alvo: WCAG 2.2 AA.
- **R-A11Y-2.** Todas as operações por arrastar têm **alternativa por teclado/menus** (adicionar componente, mover entre painéis, criar conexão).
- **R-A11Y-3.** Alterações de colaboração relevantes anunciadas via `aria-live`, sem excesso.
- **R-A11Y-4.** Vídeo: legendas/transcrição: a legenda ao vivo e o componente `ultima-transcript` (6.2.1, D-37) atendem; dependem do modelo instalado.
- **R-I18N-1.** Textos de interface externalizados, com `pt-BR` como idioma padrão e inglês secundário. Datas, números e fusos pelo `Intl`.
- **R-I18N-2.** Componentes declaram seus textos em arquivos próprios (`i18n/pt-BR.json`, `i18n/en.json`).

## 7.9 Desempenho

- **R-PERF-1.** Alvo: workspace com até **~30 instâncias** e **~10 participantes** com interação fluida em hardware modesto. Medido no MVP com um workspace de referência (11.5).
- **R-PERF-2.** Instâncias fora da vista são montadas preguiçosamente (R-LIFE-2).
- **R-PERF-3.** Carregamento inicial: shell + paleta sem baixar código dos componentes (apenas manifestos).
