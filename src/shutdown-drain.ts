import type { Server } from "node:http";

export interface ShutdownDrain {
  isDraining: () => boolean;
  begin: (server: Server) => void;
}

export function createShutdownDrain(args: {
  drainSeconds: number;
  onClosed: (error?: Error) => void;
}): ShutdownDrain {
  let draining = false;

  return {
    isDraining: () => draining,
    begin: (server) => {
      if (draining) {
        return;
      }
      draining = true;
      console.log(
        `Shutting down; reporting not ready first, drain_seconds=${args.drainSeconds}`,
      );
      setTimeout(() => {
        server.close((error) => args.onClosed(error));
      }, args.drainSeconds * 1000);
    },
  };
}
