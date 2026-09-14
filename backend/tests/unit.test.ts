import { describe, expect, test } from "bun:test";
import { computeAging } from "../src/services/debtors.service.ts";
import { addMonths, businessInstant, daysBetween, monthBounds, startOfWeek } from "../src/utils/dates.ts";
import { toCsv } from "../src/utils/csv.ts";
import { money } from "../src/utils/numbers.ts";
import { likeContains } from "../src/utils/sql.ts";
import { litresAmount, plateSchema } from "../src/validators/common.ts";
import { gitCreateSchema } from "../src/validators/git.ts";

describe("debtor aging (FIFO)", () => {
  test("repayments settle the oldest charges first", () => {
    const aging = computeAging(
      [
        { type: "opening_balance", amount: 100_000, businessDate: "2026-05-01" },
        { type: "credit_sale", amount: 50_000, businessDate: "2026-08-20" },
        { type: "repayment", amount: 120_000, businessDate: "2026-09-01" },
      ],
      "2026-09-10",
    );
    // 100k oldest charge fully paid, 20k applied to the August sale → 30k left, 21 days old.
    expect(aging.balance).toBe(30_000);
    expect(aging.oldestUnpaidDate).toBe("2026-08-20");
    expect(aging.buckets.current).toBe(30_000);
    expect(aging.buckets["90_plus"]).toBe(0);
    expect(aging.status).toBe("current");
  });

  test("buckets by age of the unpaid remainder", () => {
    const aging = computeAging(
      [
        { type: "opening_balance", amount: 100_000, businessDate: "2026-05-01" },
        { type: "credit_sale", amount: 40_000, businessDate: "2026-07-20" },
        { type: "repayment", amount: 30_000, businessDate: "2026-09-01" },
      ],
      "2026-09-10",
    );
    expect(aging.buckets["90_plus"]).toBe(70_000);
    expect(aging.buckets["31_60"]).toBe(40_000);
    expect(aging.status).toBe("90_plus");
  });

  test("settled and credit balances", () => {
    expect(computeAging([{ type: "credit_sale", amount: 10, businessDate: "2026-09-01" }, { type: "repayment", amount: 10, businessDate: "2026-09-02" }], "2026-09-10").status).toBe("settled");
    expect(computeAging([], "2026-09-10").status).toBe("none");
  });
});

describe("dates", () => {
  test("month bounds and arithmetic", () => {
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(daysBetween("2026-09-01", "2026-09-14")).toBe(13);
    expect(startOfWeek("2026-09-13")).toBe("2026-09-07"); // Sunday → Monday
  });

  test("business wall-clock time converts to UTC (Africa/Lagos is UTC+1)", () => {
    expect(businessInstant("2026-09-13", "09:40").toISOString()).toBe("2026-09-13T08:40:00.000Z");
  });
});

describe("validation", () => {
  test("numeric inputs accept thousands separators and currency symbols", () => {
    expect(litresAmount().parse("33,000")).toBe(33_000);
    expect(litresAmount().safeParse("-5").success).toBe(false);
    expect(litresAmount().safeParse("1.234").success).toBe(false);
  });

  test("truck plates are normalised", () => {
    expect(plateSchema.parse("ngr 201 kj")).toBe("NGR-201-KJ");
    expect(plateSchema.safeParse("<script>").success).toBe(false);
  });

  test("multi-delivery quantities must add up to the order", () => {
    const base = { productId: 1, quantity: 30_000, orderPrice: 645, isMultiDelivery: true };
    expect(gitCreateSchema.safeParse({ ...base, destinations: [{ stationId: 1, quantity: 15_000 }, { stationId: 2, quantity: 10_000 }] }).success).toBe(false);
    expect(gitCreateSchema.safeParse({ ...base, destinations: [{ stationId: 1, quantity: 15_000 }, { stationId: 2, quantity: 15_000 }] }).success).toBe(true);
  });
});

describe("utilities", () => {
  test("CSV neutralises spreadsheet formulas and escapes quotes", () => {
    const csv = toCsv([{ key: "a", label: "Name" }, { key: "b", label: "Amount" }], [{ a: '=HYPERLINK("x")', b: -84000 }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(",-84000");
  });

  test("LIKE patterns escape wildcards", () => {
    expect(likeContains("50%_off")).toBe("%50\\%\\_off%");
  });

  test("money rounding", () => {
    expect(money(0.1 + 0.2)).toBe(0.3);
    expect(money(1980 * 700.45)).toBe(1_386_891);
  });
});
