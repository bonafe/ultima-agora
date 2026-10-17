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
