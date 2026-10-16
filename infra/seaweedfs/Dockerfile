FROM postgres:16.13-alpine3.23 AS timezone

FROM chrislusf/seaweedfs:4.29
COPY --from=timezone /usr/share/zoneinfo/Europe/Moscow /usr/share/zoneinfo/Europe/Moscow
ENV TZ=Europe/Moscow
