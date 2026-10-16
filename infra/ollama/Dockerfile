FROM postgres:16.13-alpine3.23 AS timezone

FROM ollama/ollama:0.40.3
COPY --from=timezone /usr/share/zoneinfo/Europe/Moscow /usr/share/zoneinfo/Europe/Moscow
ENV TZ=Europe/Moscow
