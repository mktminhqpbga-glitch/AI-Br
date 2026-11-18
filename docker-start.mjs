import { chownSync, mkdirSync } from "node:fs";

// Render mounts the disk after image creation. Grant the runtime user access
// to its mount before dropping root privileges and loading the gateway.
if (process.getuid() === 0) {
  const directory = "/var/data/ai-bridge";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chownSync(directory, 1000, 1000);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
await import("./local-server.mjs");
