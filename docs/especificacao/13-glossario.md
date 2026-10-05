# 13. Glossário

| Termo | Definição |
|---|---|
| **Ação** | Operação nomeada exposta por um componente; pode alterar a si, emitir valores ou criar componentes. |
| **Adapter (hospedeiro)** | Implementação dos contratos que ligam o Agora a um backend específico. |
| **Agente** | Participante automatizado do workspace, com identidade própria e permissões do humano que o aciona. |
| **Aplicação de domínio** | Conjunto de componentes, tipos, ações e serviços sobre o Agora (ex.: Inteligência Aberta). |
| **AgoraComponent** | Classe base dos componentes do catálogo; estende `ReactiveComponent` do UltimaJS. |
| **Awareness / presença** | Estado efêmero dos participantes conectados. |
| **Barramento** | Mecanismo que transporta valores tipados entre as portas das instâncias via conexões. |
| **Capability** | Capacidade declarada no manifesto e concedida pelo Agora (`shared-content`, `connectable`…). |
| **Catálogo** | Conjunto de componentes registrados disponíveis na paleta. |
| **Componente (definição)** | Implementação (classe + manifesto) disponível no registro. |
| **Conexão** | Ligação tipada de uma porta de saída a uma porta de entrada. |
| **Conteúdo autoral** | O que os usuários escrevem ou desenham no workspace (notas, quadro, chat). Pertence ao workspace. |
| **Conversor** | Função registrada que transforma um tipo em outro, habilitando conexões e sugestões. |
| **CRDT** | Tipo de dado replicado que converge sem coordenação central (implementação de referência: Yjs). |
| **Dados de domínio** | Objetos da aplicação (Entity, Claim, Evidence…). Vivem na API do domínio, não no documento. |
| **Documento do workspace** | Estrutura colaborativa que guarda a composição e o conteúdo autoral. |
| **Hospedeiro** | Aplicação que embute o Agora e fornece identidade, política, domínio e armazenamento (ex.: portal Django). |
| **Inspetor** | Painel de configuração, conexões e ações da instância selecionada. |
| **Instância** | Uso concreto de um componente num workspace. |
| **Local-first** | O cliente mantém cópia local utilizável sem rede e sincroniza depois. |
| **Manifesto** | Descrição declarativa (JSON) de um componente: portas, ações, config, capabilities. |
| **Paleta** | Lista de componentes disponíveis para adicionar. |
| **Porta** | Entrada ou saída tipada de uma instância. |
| **Provider** | Implementação substituível de um serviço (sincronização, conferência). |
| **Referência (`Ref`)** | Identificador de objeto de domínio, usado em vez de uma cópia. |
| **Sessão** | Atividade colaborativa ao vivo num workspace. |
| **Shell** | A aplicação do Agora (`agora-shell`) que hospeda o workspace e o chrome. |
| **`Space` (IA)** | Agrupamento de artefatos com política no Inteligência Aberta; distinto de workspace. |
| **StateStore** | Interface de estado colaborativo (Yjs é a implementação de referência). |
| **Workspace** | Espaço persistente, compartilhável, composto de instâncias; um documento, e não uma página. |
