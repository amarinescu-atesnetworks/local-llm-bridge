FROM nginx:1.27-alpine

# Build context is the project root (local-llm-bridge/), per docker-compose.yml
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY page/             /usr/share/nginx/html/

# Source files come from Windows via scp and arrive with 0600 perms;
# nginx workers run as the `nginx` user and need world-read to serve them.
RUN chmod -R a+rX /usr/share/nginx/html

EXPOSE 3000
