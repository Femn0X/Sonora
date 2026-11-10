import { buildApp } from "./app";

async function main() {
  const app = await buildApp({ logger: true });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Sonora API listening on :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
