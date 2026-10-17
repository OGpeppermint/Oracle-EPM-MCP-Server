import type { Server } from "node:http";
import type { Socket } from "node:net";

export function manageHttpShutdown(listener: Server, timeoutMs: number) {
  const resources = new Map<() => Promise<void>, boolean>();
  const sockets = new Map<Socket, number>();
  let shuttingDown = false;
  let forced = false;
  let shutdownPromise: Promise<void> | undefined;

  listener.on("connection", (socket) => {
    sockets.set(socket, 0);
    socket.once("close", () => sockets.delete(socket));
    if (shuttingDown) socket.destroy();
  });
  // Track active responses, including pipelined requests and sockets with no request yet.
  listener.on("request", (req, res) => {
    const socket = req.socket;
    sockets.set(socket, (sockets.get(socket) ?? 0) + 1);
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true;
      if (!sockets.has(socket)) return;
      const active = Math.max(0, sockets.get(socket)! - 1);
      sockets.set(socket, active);
      if (shuttingDown && active === 0) socket.destroySoon();
    };
    res.once("finish", complete);
    res.once("close", complete);
  });

  function track(close: () => Promise<void>, closeOnShutdown = false): () => Promise<void> {
    let closing: Promise<void> | undefined;
    const release = () => {
      closing ??= Promise.resolve().then(close).catch(() => {
        console.error("Failed to close an MCP connection.");
        process.exitCode = 1;
      }).finally(() => resources.delete(release));
      return closing;
    };
    resources.set(release, closeOnShutdown);
    return release;
  }

  function shutdown(signal: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    console.error(`Received ${signal}; stopping HTTP requests and draining active connections.`);
    // Notification streams have no response boundary to drain toward.
    for (const [release, closeOnShutdown] of resources) {
      if (closeOnShutdown) void release();
    }
    const deadline = setTimeout(() => {
      forced = true;
      console.error("Shutdown deadline exceeded; forcing remaining connections closed.");
      listener.closeAllConnections();
      for (const socket of sockets.keys()) socket.destroy();
      for (const release of resources.keys()) void release();
      process.exitCode = 1;
      // Let resource-close microtasks start, but never wait indefinitely for them.
      setImmediate(() => process.exit(1));
    }, timeoutMs);
    shutdownPromise = (async () => {
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
        for (const [socket, active] of sockets) {
          if (active === 0) socket.destroySoon();
        }
      });
      await Promise.all([...resources.keys()].map((release) => release()));
      clearTimeout(deadline);
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      if (!forced) console.error("HTTP shutdown complete.");
    })();
    return shutdownPromise;
  }

  const onSigterm = () => { void shutdown("SIGTERM"); };
  const onSigint = () => { void shutdown("SIGINT"); };
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  return { get shuttingDown() { return shuttingDown; }, track, shutdown };
}
