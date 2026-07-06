import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "demo-ca-firm" },
    update: {},
    create: {
      name: "Demo CA Firm",
      slug: "demo-ca-firm",
    },
  });

  const passwordHash = await bcrypt.hash("ChangeMe123!", 10);

  await prisma.user.upsert({
    where: { email: "owner@demo-ca-firm.test" },
    update: {},
    create: {
      organizationId: org.id,
      name: "Firm Owner",
      email: "owner@demo-ca-firm.test",
      passwordHash,
      role: Role.OWNER,
    },
  });

  console.log("Seed complete. Login with owner@demo-ca-firm.test / ChangeMe123!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
