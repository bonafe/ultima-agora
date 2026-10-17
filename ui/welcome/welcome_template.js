//The welcome workspace (D-38): a real, working composition that teaches by being used. Everything in it is an ordinary
//instance: the person can edit the text, change the table and watch the graph follow, rearrange, delete, add.
export const WELCOME_TEMPLATE_NAME = 'boas-vindas';

const GUIDE = `# Bem-vindo à Ágora Digital

Este espaço já está montado para você **mexer**. Nada aqui é de enfeite: tudo funciona de verdade.

## Experimente (leva 2 minutos)

1. **Mude a tabela.** À direita, em cima, está uma tabela. Clique na tabela e, no **Inspetor** (painel da direita), edite *Dados (CSV)* acrescentando uma linha, como \`Maria,Ágora,chegou\`.
2. **Olhe o grafo.** Ele está *ligado* à tabela e se redesenha sozinho. É assim que as peças conversam: uma entrega o que sabe para a outra.
3. **Escreva no caderno.** Na aba *Seu caderno*, aqui ao lado, anote o que quiser. Se mais gente entrar, vocês escrevem juntos.
4. **Arrume do seu jeito.** Arraste uma aba para a beira de outro painel para dividir a tela. Dá para desfazer com **Ctrl+Z**.
5. **Traga mais peças.** Em *Componentes* (à esquerda) há texto, notas, tabela e grafo. Clique para adicionar.

## O que é cada coisa

- **Chat** 💬 e **chamada** 📹 ficam no topo: conversam com todos que estiverem neste espaço.
- **Transcrição**: dentro da chamada, \`Transcrever minha fala\` escreve o que você diz, no seu computador.
- O espaço é **seu**: fica guardado neste navegador e abre até sem internet.

## Para chamar alguém

Quem tem a Ágora rodando em casa ou na empresa (veja *Rodar em casa* no site) copia o endereço desta página e manda. Quem abrir entra neste mesmo espaço.

*Dica: o botão **Boas-vindas** no topo traz este espaço de novo, intacto, quando você quiser.*
`;

const NOTEBOOK = `# Seu caderno

Escreva aqui. Se mais alguém entrar neste espaço, vocês dois veem o texto aparecer ao vivo.

- ideias:
- perguntas:
- o que combinamos:
`;

//The table says what the Ágora itself is made of: change it and the graph beside it follows
const WHO_DOES_WHAT = `from,to,label
Pessoas,Ágora,conversam
Máquinas,Ágora,propõem
Ágora,Transcrição,gera
Ágora,Grafos,desenha
Pessoas,Máquinas,decidem sobre o que propõem
Transcrição,Afirmações,alimenta
Afirmações,Grafos,viram nós e ligações`;

export const WELCOME = {
    title: 'Boas-vindas à Ágora',
    instances: [
        { key: 'guia', type: 'ultima-notes', label: 'Comece por aqui', config: { startInView: true }, text: GUIDE },
        { key: 'caderno', type: 'ultima-notes', label: 'Seu caderno', text: NOTEBOOK, place: { of: 'guia', side: 'center' } },
        { key: 'tabela', type: 'ultima-table', label: 'Quem faz o quê', config: { data: WHO_DOES_WHAT }, place: { of: 'guia', side: 'right' } },
        { key: 'grafo', type: 'ultima-graph', label: 'O mapa da Ágora', place: { of: 'tabela', side: 'bottom' } },
    ],
    connections: [{ from: ['tabela', 'graph'], to: ['grafo', 'graph'] }],
};
