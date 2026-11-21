"""Um LLM por trás de qualquer API compatível com OpenAI (/v1/chat/completions): o gateway do inteligencia-aberta (Ollama, token em
AGORA_LLM_KEY), um servidor vLLM/llama.cpp, ou uma API externa. A chamada é servidor -> servidor: a chave nunca vai ao navegador.

O modelo só recebe a frase e as opções e deve responder com o id da escolhida. Sem logprobs, a confiança é fixa (AGORA_LLM_CONFIDENCE) para
a escolhida e o resto é repartido: o app trata como "sugestão" e pergunta antes de executar abaixo do limiar dele."""
import json
import re
import time
import urllib.request

SISTEMA = ("Você escolhe qual opção corresponde à frase do usuário. Responda APENAS com o id exato de uma das opções, sem explicação. "
           "Se a frase for conversa comum e não um comando, escolha a opção de conversa.")


def montar_mensagens(pergunta: str, opcoes: list[dict], estado: str) -> list[dict]:
    lista = "\n".join(f"- {o['id']}: {o['text']}" for o in opcoes)
    return [{"role": "system", "content": SISTEMA}, {"role": "user", "content": f"{pergunta or 'Qual opção?'}\n\nOpções:\n{lista}\n\nFrase: {estado}\n\nId da opção:"}]


def escolher_id(resposta: str, ids: list[str]) -> str | None:
    """O id que o modelo disse: igual à resposta inteira, ou o que aparece primeiro como palavra (ids longos antes dos curtos que são prefixo deles)."""
    limpa = resposta.strip().strip("`'\".:*- \n").lower()
    for i in ids:
        if limpa == i.lower():
            return i
    achado = None
    for i in sorted(ids, key=len, reverse=True):
        m = re.search(rf"(?<![\w-]){re.escape(i.lower())}(?![\w-])", resposta.lower())
        if m and (achado is None or m.start() < achado[0]):
            achado = (m.start(), i)
    return achado[1] if achado else None


def pontuar(escolhido: str | None, ids: list[str], confianca: float) -> list[float]:
    if escolhido is None:                                  # o modelo não disse nada utilizável: ninguém ganha, o app responde "não entendi"
        return [1 / len(ids)] * len(ids)
    resto = (1 - confianca) / (len(ids) - 1)
    return [confianca if i == escolhido else resto for i in ids]


class OpenAICompatBackend:
    def __init__(self, url, modelo="", chave=None, timeout=30.0, confianca=0.8):
        self.url, self.modelo, self.chave, self.timeout, self.confianca = url, modelo, chave, timeout, confianca
        self.id = f"openai:{modelo or 'default'}"

    def load(self) -> None:           # nada a carregar: o modelo mora do outro lado
        pass

    def choose(self, question, options, state):
        corpo = {"messages": montar_mensagens(question, options, state), "temperature": 0, "max_tokens": 24, "stream": False}
        if self.modelo:
            corpo["model"] = self.modelo
        cabecalhos = {"content-type": "application/json", **({"authorization": f"Bearer {self.chave}"} if self.chave else {})}
        pedido = urllib.request.Request(self.url, json.dumps(corpo).encode(), cabecalhos, method="POST")
        with urllib.request.urlopen(pedido, timeout=self.timeout) as resposta:
            dados = json.load(resposta)
        texto = (dados.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        ids = [o["id"] for o in options]
        return pontuar(escolher_id(texto, ids), ids, self.confianca)
