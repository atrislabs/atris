# Runs the Atris MCP server over stdio. MCP directories such as Glama build
# this image to start the server and list its tools. No npm dependencies.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV ATRIS_SKIP_UPDATE_CHECK=1 ATRIS_NONINTERACTIVE=1
ENTRYPOINT ["node", "bin/atris.js", "mcp"]
