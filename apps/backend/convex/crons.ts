import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "cleanup old webhook events",
  { hourUTC: 3, minuteUTC: 0 },
  internal.webhooks.cleanupOldEvents
);

crons.interval(
  "prune remote pty data",
  { minutes: 5 },
  internal.remote.pruneRemote,
);

export default crons;
