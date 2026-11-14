# The physician-ui Portal image for vm1, served at / on clics.ccme.or.th (#429): static files behind
# nginx, with deploy/vm1/portal.nginx.conf standing in for physician-ui/vercel.json.
#
# The context is the repository root (docker-compose.yml), because the files come from physician-ui/ and
# the config from deploy/vm1/. portal.Dockerfile.dockerignore beside this file lets only those two in.
FROM nginxinc/nginx-unprivileged:1.28.0-alpine

COPY deploy/vm1/portal.nginx.conf /etc/nginx/nginx.conf
COPY physician-ui/public /usr/share/nginx/html

EXPOSE 8080
# nginx directly, not the image's entrypoint: its scripts rewrite files under /etc/nginx, which the
# read-only root refuses.
ENTRYPOINT ["nginx", "-g", "daemon off;"]
