/**
 * search.service.ts — the global "Search records, refs…" box.
 *
 * Searches document references and names across modules the user can view,
 * always within their station scope.
 */
import { sql } from "drizzle-orm";
import { db, selectRows } from "../db/client.ts";
import type { Actor } from "../types.ts";
import { likeContains } from "../utils/sql.ts";

export interface SearchHit {
  type: string;
  page: string;
  ref: string;
  label: string;
  date: string | null;
  stationId: number | null;
  stationName: string | null;
  id: number;
}

const PER_TYPE = 5;

export async function search(actor: Actor, term: string): Promise<SearchHit[]> {
  const p = likeContains(term);
  const station = actor.stationId;
  const scope = (col: string) => (station !== null ? sql`AND ${sql.raw(col)} = ${station}` : sql``);
  const can = (perm: string) => actor.permissions.has(perm);
  const queries: Promise<SearchHit[]>[] = [];

  if (can("receipts.view")) {
    queries.push(
      selectRows<SearchHit>(
        db,
        sql`SELECT 'Truck receipt' AS type, 'truck' AS page, r.id, r.waybill_ref AS ref,
                   CONCAT(tr.plate_number, ' · ', p.code, ' ', FORMAT(r.quantity, 0), ' L · ', r.status) AS label,
                   r.business_date AS date, r.station_id AS stationId, s.name AS stationName
            FROM truck_receipts r JOIN trucks tr ON tr.id = r.truck_id JOIN products p ON p.id = r.product_id JOIN stations s ON s.id = r.station_id
            WHERE (r.waybill_ref LIKE ${p} OR tr.plate_number LIKE ${p}) ${scope("r.station_id")}
            ORDER BY r.business_date DESC LIMIT ${PER_TYPE}`,
      ),
    );
  }
  if (can("git.view")) {
    queries.push(
      selectRows<SearchHit>(
        db,
        sql`SELECT 'GIT order' AS type, 'git' AS page, o.id, o.ref,
                   CONCAT(p.code, ' ', FORMAT(o.quantity, 0), ' L · ', REPLACE(o.status, '_', ' ')) AS label,
                   o.order_date AS date, NULL AS stationId, NULL AS stationName
            FROM git_orders o JOIN products p ON p.id = o.product_id LEFT JOIN trucks tr ON tr.id = o.truck_id
            WHERE (o.ref LIKE ${p} OR tr.plate_number LIKE ${p})
              ${station !== null ? sql`AND EXISTS (SELECT 1 FROM git_deliveries d WHERE d.git_order_id = o.id AND d.station_id = ${station})` : sql``}
            ORDER BY o.order_date DESC LIMIT ${PER_TYPE}`,
      ),
    );
  }
  if (can("dsr.view")) {
    queries.push(
      selectRows<SearchHit>(
        db,
        sql`SELECT 'DSR day' AS type, 'dsr' AS page, d.id, d.ref, CONCAT('Business day · ', d.status) AS label,
                   d.business_date AS date, d.station_id AS stationId, s.name AS stationName
            FROM dsr_days d JOIN stations s ON s.id = d.station_id
            WHERE d.ref LIKE ${p} ${scope("d.station_id")}
            ORDER BY d.business_date DESC LIMIT ${PER_TYPE}`,
      ),
    );
  }
  if (can("rtt.view")) {
    queries.push(
      selectRows<SearchHit>(
        db,
        sql`SELECT 'RTT' AS type, 'rtt' AS page, e.id, e.ref, CONCAT(pu.name, ' · ', FORMAT(e.quantity, 1), ' L · ', e.reason) AS label,
                   e.business_date AS date, e.station_id AS stationId, s.name AS stationName
            FROM rtt_entries e JOIN pumps pu ON pu.id = e.pump_id JOIN stations s ON s.id = e.station_id
            WHERE e.ref LIKE ${p} ${scope("e.station_id")}
            ORDER BY e.business_date DESC LIMIT ${PER_TYPE}`,
      ),
    );
  }
  if (can("stock.view")) {
    queries.push(
      selectRows<SearchHit>(
        db,
        sql`SELECT 'Physical dip' AS type, 'stock' AS page, d.id, d.ref, CONCAT(t.name, ' · variance ', FORMAT(d.variance, 1), ' L') AS label,
                   d.business_date AS date, d.station_id AS stationId, s.name AS stationName
            FROM physical_dips d JOIN tanks t ON t.id = d.tank_id JOIN stations s ON s.id = d.station_id
            WHERE d.ref LIKE ${p} ${scope("d.station_id")}
            UNION ALL
            SELECT 'Stock adjustment', 'stock', a.id, a.ref, CONCAT(t.name, ' · ', FORMAT(a.quantity, 1), ' L · ', a.reason),
                   a.business_date, a.station_id, s.name
            FROM stock_adjustments a JOIN tanks t ON t.id = a.tank_id JOIN stations s ON s.id = a.station_id
            WHERE a.ref LIKE ${p} ${scope("a.station_id")}
            LIMIT ${PER_TYPE}`,
      ),
    );
  }
  if (can("expenses.view")) {
    queries.push(
      selectRows<SearchHit>(
        db,
        sql`SELECT 'Expense' AS type, 'expenses' AS page, e.id, e.ref, CONCAT(n.name, ' · ', e.payee, ' · ₦', FORMAT(e.amount, 0)) AS label,
                   e.business_date AS date, e.station_id AS stationId, s.name AS stationName
            FROM expenses e JOIN expense_narrations n ON n.id = e.narration_id JOIN stations s ON s.id = e.station_id
            WHERE (e.ref LIKE ${p} OR e.payee LIKE ${p} OR e.reference LIKE ${p}) ${scope("e.station_id")}
            ORDER BY e.business_date DESC LIMIT ${PER_TYPE}`,
      ),
    );
  }
  if (can("cash.view")) {
    queries.push(
      selectRows<SearchHit>(
        db,
        sql`SELECT 'Bank deposit' AS type, 'cash' AS page, b.id, b.teller_ref AS ref, CONCAT(bk.name, ' · ₦', FORMAT(b.amount, 0), ' · ', b.status) AS label,
                   b.business_date AS date, b.station_id AS stationId, s.name AS stationName
            FROM bank_deposits b JOIN banks bk ON bk.id = b.bank_id JOIN stations s ON s.id = b.station_id
            WHERE b.teller_ref LIKE ${p} ${scope("b.station_id")}
            ORDER BY b.business_date DESC LIMIT ${PER_TYPE}`,
      ),
    );
  }
  if (can("debtors.view")) {
    queries.push(
      selectRows<SearchHit>(
        db,
        sql`SELECT 'Debtor' AS type, 'debtors' AS page, d.id, d.name AS ref, 'Customer account' AS label,
                   NULL AS date, d.station_id AS stationId, s.name AS stationName
            FROM debtors d JOIN stations s ON s.id = d.station_id
            WHERE d.name LIKE ${p} ${scope("d.station_id")}
            ORDER BY d.name LIMIT ${PER_TYPE}`,
      ),
    );
  }

  return (await Promise.all(queries)).flat();
}
