FROM denoland/deno:2.2.11

WORKDIR /app

COPY deno.json ./
COPY src ./src
COPY migrations ./migrations

RUN deno cache src/main.ts

EXPOSE 8080

CMD ["run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "src/main.ts"]
