# Static app + reverse proxy to agora-sync, over HTTPS with a self-signed certificate (dev/demo).
# Camera and microphone only work in a secure context, so other machines on the network need https://.
FROM nginx:alpine
RUN apk add --no-cache openssl
COPY default.conf /etc/nginx/conf.d/default.conf
COPY make-cert.sh /docker-entrypoint.d/05-make-cert.sh
RUN chmod +x /docker-entrypoint.d/05-make-cert.sh
VOLUME /etc/nginx/certs
