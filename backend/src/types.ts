import type { Logger } from "./utils/logger.ts";

/** The authenticated user a request (or a service call) acts on behalf of. */
export interface Actor {
  id: number;
  username: string;
  fullName: string;
  /** null = the user may work across all stations. */
  stationId: number | null;
  roles: string[];
  permissions: ReadonlySet<string>;
  sessionId: string;
  mustChangePassword: boolean;
  ip: string | null;
  userAgent: string | null;
}

/** Who to attribute an audit entry to. `userId: null` means the system itself. */
export interface AuditActor {
  userId: number | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
    clientIp: string | null;
    actor: Actor;
  };
}
