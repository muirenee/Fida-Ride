# syntax=docker/dockerfile:1.7

FROM golang:1.22-alpine AS builder
WORKDIR /src

RUN apk add --no-cache ca-certificates git

COPY go.mod ./
RUN go mod download

COPY main.go ./

ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/telemetry-service \
    ./main.go

FROM alpine:3.20
RUN apk add --no-cache ca-certificates

COPY --from=builder /out/telemetry-service /usr/local/bin/telemetry-service

USER 65532:65532
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/telemetry-service"]
