-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contents" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topic" VARCHAR(200) NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'PENDING',
    "fileUrl" TEXT,
    "fileKey" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "creditRefundedAt" TIMESTAMP(3),

    CONSTRAINT "contents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contents_userId_createdAt_idx" ON "contents"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "contents_status_idx" ON "contents"("status");

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Adicionado à mão: o Prisma Schema não expressa CHECK constraints.
--
-- Rede de segurança para RN-02 ("o saldo nunca pode ficar negativo"). NÃO é a
-- solução de concorrência: o débito continuará sendo feito com um UPDATE
-- condicional atômico (`WHERE credits > 0`), conforme ADR-001. Esta constraint
-- existe para que um bug futuro na aplicação não consiga produzir saldo
-- negativo — defesa em profundidade, não a defesa principal.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD CONSTRAINT "users_credits_non_negative" CHECK ("credits" >= 0);
