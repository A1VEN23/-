-- Migration: 0001_init
-- Creates all tables for gem-twa backend

CREATE TABLE "Wallet" (
    "id"                  TEXT NOT NULL,
    "telegramId"          TEXT NOT NULL,
    "chain"               TEXT NOT NULL,
    "address"             TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "encryptedMnemonic"   TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Wallet_telegramId_chain_key" ON "Wallet"("telegramId", "chain");

CREATE TABLE "Account" (
    "id"                  TEXT NOT NULL,
    "telegramId"          TEXT NOT NULL,
    "username"            TEXT,
    "nickname"            TEXT,
    "channelName"         TEXT,
    "notes"               TEXT,
    "language"            TEXT NOT NULL DEFAULT 'ru',
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "displayCurrency"     TEXT NOT NULL DEFAULT 'USD',
    "lastActive"          TIMESTAMP(3) NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Account_telegramId_key" ON "Account"("telegramId");

CREATE TABLE "Transaction" (
    "id"          TEXT NOT NULL,
    "walletId"    TEXT NOT NULL,
    "chain"       TEXT NOT NULL,
    "type"        TEXT NOT NULL,
    "amount"      TEXT NOT NULL,
    "asset"       TEXT NOT NULL,
    "toAddress"   TEXT,
    "fromAddress" TEXT,
    "txHash"      TEXT,
    "status"      TEXT NOT NULL DEFAULT 'pending',
    "fee"         TEXT,
    "memo"        TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Transaction"
    ADD CONSTRAINT "Transaction_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "Wallet"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TxError" (
    "id"           TEXT NOT NULL,
    "walletId"     TEXT NOT NULL,
    "chain"        TEXT NOT NULL,
    "amount"       TEXT NOT NULL,
    "errorCode"    TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "timestamp"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TxError_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TxError"
    ADD CONSTRAINT "TxError_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "Wallet"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AddressBook" (
    "id"         TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "address"    TEXT NOT NULL,
    "chain"      TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddressBook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Backup" (
    "id"          TEXT NOT NULL,
    "filename"    TEXT NOT NULL,
    "walletCount" INTEGER NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Backup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IpBlock" (
    "id"           TEXT NOT NULL,
    "ip"           TEXT NOT NULL,
    "blockedUntil" TIMESTAMP(3) NOT NULL,
    "reason"       TEXT NOT NULL,

    CONSTRAINT "IpBlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IpBlock_ip_key" ON "IpBlock"("ip");
