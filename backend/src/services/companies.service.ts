/**
 * companies.service.ts — tenant (company) administration.
 *
 * Only the platform super-admin (actor.companyId === null) reaches these —
 * enforced by the `companies.view`/`companies.manage` permissions, which only
 * the seeded "Platform Administrator" role carries (see auth/permissions.ts).
 */
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/client.ts";
import { companies } from "../db/schema/index.ts";
import type { Actor } from "../types.ts";
import { AppError, notFound } from "../utils/errors.ts";
import { recordAudit } from "./audit.service.ts";

export async function listCompanies() {
  return db.select().from(companies).orderBy(companies.status, companies.name);
}

export async function getCompany(id: number) {
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  if (!row) throw notFound("Company");
  return row;
}

export async function createCompany(actor: Actor, input: { code: string; name: string; logoUrl?: string | null }) {
  const id = await db.transaction(async (tx) => {
    const [byCode] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.code, input.code));
    if (byCode) throw new AppError("CONFLICT", `Company code ${input.code} is already in use.`, { fields: { code: "Code already in use." } });
    const [byName] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.name, input.name));
    if (byName) throw new AppError("CONFLICT", `A company named ${input.name} already exists.`, { fields: { name: "Name already in use." } });

    const [inserted] = await tx
      .insert(companies)
      .values({ code: input.code, name: input.name, logoUrl: input.logoUrl ?? null })
      .$returningId();
    await recordAudit(tx, actor, { action: "created", resource: "company", resourceId: inserted!.id, recordRef: input.code, newValue: input });
    return inserted!.id;
  });
  return getCompany(id);
}

export async function updateCompany(actor: Actor, id: number, input: { name?: string; logoUrl?: string | null; status?: "active" | "inactive" }) {
  await db.transaction(async (tx) => {
    const [company] = await tx.select().from(companies).where(eq(companies.id, id)).for("update");
    if (!company) throw notFound("Company");
    if (input.name && input.name !== company.name) {
      const [byName] = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.name, input.name), ne(companies.id, id)));
      if (byName) throw new AppError("CONFLICT", `A company named ${input.name} already exists.`, { fields: { name: "Name already in use." } });
    }
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as typeof input;
    await tx.update(companies).set(patch).where(eq(companies.id, id));
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "company",
      resourceId: id,
      recordRef: company.code,
      oldValue: Object.fromEntries(Object.keys(patch).map((k) => [k, company[k as keyof typeof company]])),
      newValue: patch,
    });
  });
  return getCompany(id);
}
