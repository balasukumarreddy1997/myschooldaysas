import { randomBytes } from "node:crypto";
import type { CampusRole } from "./auth.ts";

const adminRank: Partial<Record<CampusRole, number>> = {
  super_admin: 3,
  org_admin: 2,
  campus_admin: 1,
};

export function generateTemporaryPassword(): string {
  return randomBytes(24).toString("base64url");
}

export function isValidNewPassword(password: string): boolean {
  return password.length >= 12 && password.length <= 256;
}

export function canManageUser(actorRoles: CampusRole[], targetRoles: CampusRole[]): boolean {
  const actorRanks = actorRoles
    .map((role) => adminRank[role])
    .filter((rank): rank is number => rank !== undefined);
  if (actorRanks.length === 0) return false;

  const targetRank = Math.max(0, ...targetRoles.map((role) => adminRank[role] ?? 0));
  return Math.max(...actorRanks) >= targetRank;
}

export function needsPasswordRehash(encoded: string): boolean {
  const [, algorithm, nText] = encoded.split("$");
  return algorithm !== "scrypt" || Number(nText) < 131072;
}
