/**
 * One HTTP "upgrade" dispatcher per server, routing WebSocket handshakes by path.
 *
 * Two `ws` servers attached with `{ server, path }` to the same HTTP server
 * break each other: each one answers 400 to every path that isn't its own,
 * so whichever is attached first kills the other's handshakes. Instead, each
 * WebSocketServer uses `noServer: true` and registers its path here.
 */
import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

const routesByServer = new WeakMap<Server, Map<string, UpgradeHandler>>();

/**
 * Route WebSocket upgrades for `path` on `server` to `handler`.
 * Unknown paths get 404. Returns a function that removes the route.
 */
export function registerUpgradeRoute(
  server: Server,
  path: string,
  handler: UpgradeHandler,
): () => void {
  let routes = routesByServer.get(server);
  if (!routes) {
    const table = new Map<string, UpgradeHandler>();
    routes = table;
    routesByServer.set(server, table);
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? "/";
      const index = url.indexOf("?");
      const pathname = index === -1 ? url : url.slice(0, index);
      const route = table.get(pathname);
      if (route) {
        route(req, socket, head);
        return;
      }
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  }
  routes.set(path, handler);
  const table = routes;
  return () => {
    if (table.get(path) === handler) table.delete(path);
  };
}
