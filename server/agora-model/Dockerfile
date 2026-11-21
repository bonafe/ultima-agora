FROM python:3.12-slim
WORKDIR /app
# REQUIREMENTS=requirements-gpu.txt para GPU (docker-compose.gpu.yml)
ARG REQUIREMENTS=requirements.txt
COPY requirements.txt requirements-gpu.txt ./
RUN pip install --no-cache-dir -r ${REQUIREMENTS}
COPY app.py ./
COPY backends ./backends
# Os pesos NÃO entram na imagem: montados em /models (tools/baixar_modelo_laya.py baixa para models/laya-en-int4/)
ENV PORT=8790 BIND_ADDR=0.0.0.0 LAYA_DIR=/models/laya-en-int4 PYTHONUNBUFFERED=1
USER 10001
EXPOSE 8790
HEALTHCHECK --interval=30s --start-period=60s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8790/health', timeout=3)" || exit 1
CMD ["python", "app.py"]
