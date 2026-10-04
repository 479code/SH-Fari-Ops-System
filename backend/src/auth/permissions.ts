/**
 * permissions.ts — the permission catalogue and the seeded system roles.
 *
 * Permission codes are `<module>.<action>`. The catalogue is the source of truth:
 * the seed script syncs it into the `permissions` table, and route guards only
 * accept codes defined here (enforced by the `Permission` type).
 */

export const PERMISSIONS = {
  "dashboard.view": { module: "Dashboard", description: "View dashboards, KPIs and station comparison" },
  "exceptions.view": { module: "Dashboard", description: "View exceptions requiring attention" },
  "exceptions.review": { module: "Dashboard", description: "Review and close exceptions" },

  "receipts.view": { module: "Truck receiving", description: "View truck receipts" },
  "receipts.create": { module: "Truck receiving", description: "Record truck receipts" },
  "receipts.verify": { module: "Truck receiving", description: "Verify or dispute truck receipts (updates stock)" },
  "receipts.cancel": { module: "Truck receiving", description: "Cancel truck receipts" },

  "dsr.view": { module: "DSR", description: "View daily sales records" },
  "dsr.record": { module: "DSR", description: "Open a business day and enter pump readings" },
  "dsr.close": { module: "DSR", description: "Close and lock a business day" },
  "dsr.reopen": { module: "DSR", description: "Reopen a locked day for correction" },

  "rtt.view": { module: "RTT", description: "View return-to-tank entries" },
  "rtt.create": { module: "RTT", description: "Log return-to-tank entries" },
  "rtt.cancel": { module: "RTT", description: "Cancel return-to-tank entries" },

  "stock.view": { module: "Stock", description: "View stock ledger, balances and dips" },
  "stock.dip": { module: "Stock", description: "Record physical dip readings" },
  "stock.adjust": { module: "Stock", description: "Post controlled stock adjustments" },

  "git.view": { module: "GIT", description: "View goods-in-transit orders" },
  "git.create": { module: "GIT", description: "Create goods-in-transit orders" },
  "git.update": { module: "GIT", description: "Update GIT status, trucks, deliveries and exceptions" },

  "cash.view": { module: "Cash & bank", description: "View cash positions and bank deposits" },
  "cash.record": { module: "Cash & bank", description: "Record bank deposits and daily cash declarations" },
  "cash.review": { module: "Cash & bank", description: "Review and close cash reconciliations" },

  "debtors.view": { module: "Debtors", description: "View debtors and their transactions" },
  "debtors.create": { module: "Debtors", description: "Register and edit debtors" },
  "debtors.transact": { module: "Debtors", description: "Record credit sales and repayments" },
  "debtors.void": { module: "Debtors", description: "Void debtor transactions" },

  "expenses.view": { module: "Expenses", description: "View expenses" },
  "expenses.create": { module: "Expenses", description: "Log and cancel own pending expenses" },
  "expenses.approve": { module: "Expenses", description: "Approve or reject expenses" },

  "reports.view": { module: "Reports", description: "Generate reports" },
  "reports.export": { module: "Reports", description: "Export reports to CSV" },

  "audit.view": { module: "Audit", description: "View the audit trail" },
  "audit.export": { module: "Audit", description: "Export the audit trail" },

  "stations.view": { module: "Setup", description: "View stations, tanks and pumps" },
  "stations.manage": { module: "Setup", description: "Register and edit stations, tanks and pumps" },
  "products.manage": { module: "Setup", description: "Manage products and pump prices" },
  "narrations.manage": { module: "Setup", description: "Manage the expense narration list" },
  "banks.manage": { module: "Setup", description: "Manage the bank list" },
  "settings.manage": { module: "Setup", description: "Change control parameters" },
  "users.view": { module: "Setup", description: "View users" },
  "users.manage": { module: "Setup", description: "Create, edit, suspend users and issue password resets" },
  "roles.view": { module: "Setup", description: "View roles and permissions" },
  "roles.manage": { module: "Setup", description: "Create and edit roles and their permissions" },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const viewAll = ALL_PERMISSIONS.filter((p) => p.endsWith(".view"));

export interface RoleDefinition {
  name: string;
  description: string;
  permissions: Permission[];
}

export const SYSTEM_ROLES: RoleDefinition[] = [
  {
    name: "System Administrator",
    description: "System configuration, users, roles, master data and audit access.",
    permissions: ALL_PERMISSIONS,
  },
  {
    name: "Station Manager",
    description: "Station operations, DSR, stock, expenses, debtors, cash review and station reports.",
    permissions: [
      "dashboard.view", "exceptions.view", "exceptions.review", "stations.view",
      "receipts.view", "receipts.create", "receipts.verify", "receipts.cancel",
      "dsr.view", "dsr.record", "dsr.close", "dsr.reopen",
      "rtt.view", "rtt.create", "rtt.cancel",
      "stock.view", "stock.dip", "stock.adjust",
      "git.view",
      "cash.view", "cash.review",
      "debtors.view", "debtors.create", "debtors.transact", "debtors.void",
      "expenses.view", "expenses.create", "expenses.approve",
      "reports.view", "reports.export",
    ],
  },
  {
    name: "Receiving / Operations Officer",
    description: "Truck receiving, waybill/landing-price details, GIT and discharge activities.",
    permissions: [
      "dashboard.view", "exceptions.view", "stations.view",
      "receipts.view", "receipts.create", "receipts.verify",
      "git.view", "git.create", "git.update",
      "stock.view", "stock.dip",
    ],
  },
  {
    name: "Pump / Sales Officer",
    description: "Daily pump/sales entries and relevant opening/closing activities.",
    permissions: ["dsr.view", "dsr.record", "rtt.view", "rtt.create", "stock.view"],
  },
  {
    name: "Cashier / Accounts Officer",
    description: "Cash analysis, expenses, debtors, POS, CIT and teller-wise bank payments.",
    permissions: [
      "dashboard.view", "exceptions.view", "dsr.view",
      "cash.view", "cash.record",
      "debtors.view", "debtors.create", "debtors.transact",
      "expenses.view", "expenses.create",
      "reports.view",
    ],
  },
  {
    name: "Management / ED",
    description: "Read-only consolidated dashboards, financial reports, variances and exceptions.",
    permissions: [...viewAll.filter((p) => !["users.view", "roles.view", "audit.view"].includes(p)), "reports.export"],
  },
  {
    name: "Auditor / Control",
    description: "Read-only transaction history, reconciliations, approvals and audit trail.",
    permissions: [...viewAll, "reports.export", "audit.export"],
  },
];
