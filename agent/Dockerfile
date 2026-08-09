# syntax=docker/dockerfile:1.7
FROM golang:1.26-alpine AS build
ARG AGENT_VERSION=dev
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w -X main.version=${AGENT_VERSION}" -o /out/gateway-agent ./cmd/gateway-agent
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/gateway-backup-helper ./cmd/gateway-backup-helper

FROM alpine:3.23
RUN apk add --no-cache ca-certificates docker-cli-compose \
    && addgroup -S -g 10001 gateway \
    && adduser -S -D -H -u 10001 -G gateway gateway \
    && install -d -o gateway -g gateway -m 0700 /var/lib/gateway-agent \
    && install -d -o gateway -g gateway -m 0755 /srv/stacks \
    && install -d -o gateway -g gateway -m 0755 /srv/traefik-dynamic
COPY --from=build /out/gateway-agent /usr/local/bin/gateway-agent
COPY --from=build /out/gateway-backup-helper /usr/local/bin/gateway-backup-helper
USER gateway:gateway
VOLUME ["/var/lib/gateway-agent"]
ENTRYPOINT ["/usr/local/bin/gateway-agent"]
