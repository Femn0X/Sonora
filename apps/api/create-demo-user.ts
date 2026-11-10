// scripts/create-demo-user.ts
import { prisma } from "src/services/prisma";

async function main() {
  const user = await prisma.user.upsert({
    where: { username: "demo" },
    update: {},
    create: {
      username: "demo",
      displayName: "Demo User",
    },
  });

  console.log(`Demo user: ${user.id}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
