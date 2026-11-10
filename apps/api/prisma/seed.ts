/**
 * Seeds the built-in demo user (the identity every request uses until real auth exists).
 * Safe to run any number of times, and safe if you already created a user named "demo" by hand: it is found by
 * username and left alone. Runs automatically after `prisma migrate reset`, or manually with:
 *   pnpm --filter @sonora/api db:seed
 */
import { PrismaClient } from "@prisma/client";
import { DEMO_USER } from "../src/services/demoUser";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { username: DEMO_USER.username },
    update: {},
    create: { ...DEMO_USER },
  });
  console.log(`Demo user ready: ${user.username} (id: ${user.id})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
