// app/db.server.ts

import { PrismaClient } from "@prisma/client";

// This block tells TypeScript that 'global' can have a prisma property
declare global {
  var prisma: PrismaClient | undefined;
}

// Check if prisma is already on the global object, otherwise create it
const db = global.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prisma = db;
}

export default db;