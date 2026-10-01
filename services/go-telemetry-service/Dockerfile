# syntax=docker/dockerfile:1.7

FROM golang:1.22-alpine AS builder
WORKDIR /src

RUN apk add --no-cache ca-certificates git

# Dependency metadata is committed so Docker builds are reproducible and do not
# mutate module state during image creation.
COPY go.mod go.sum ./

RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download && \
    go mod verify

# Compile the whole package. Bidding/WebSocket extensions live in additional
# .go files alongside main.go and must be part of the same package build.
COPY *.go ./

ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/telemetry-service \
    .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates

COPY --from=builder /out/telemetry-service /usr/local/bin/telemetry-service

USER 65532:65532
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/telemetry-service"]
