import { closeServerRuntime, getServerRuntime } from "./bootstrap.js";

const { app, config } = await getServerRuntime();
const server = app.listen(config.port, () => {
  process.stdout.write(`EduSafety server listening on port ${config.port}\n`);
});

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close((error) => {
    void closeServerRuntime().then(() => {
      process.exit(error === undefined ? 0 : 1);
    }, () => {
      process.exit(1);
    });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
