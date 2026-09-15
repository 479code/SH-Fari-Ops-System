/** Setup API: stations, tanks, pumps, products & prices, narrations, banks, users, roles and settings. */
import { Hono } from "hono";
import { requireAnyPermission, requireAuth, requirePermission } from "../middleware/auth.ts";
import * as master from "../services/masterdata.service.ts";
import * as rolesService from "../services/roles.service.ts";
import { getSettings, settingsUpdateSchema, updateSettings } from "../services/settings.service.ts";
import * as stations from "../services/stations.service.ts";
import * as usersService from "../services/users.service.ts";
import type { AppEnv } from "../types.ts";
import { created, ok, paged, readId, readJson, readQuery } from "../utils/http.ts";
import {
  bankCreateSchema,
  bankUpdateSchema,
  narrationCreateSchema,
  narrationUpdateSchema,
  priceCreateSchema,
  productCreateSchema,
  productUpdateSchema,
  pumpCreateSchema,
  pumpUpdateSchema,
  roleCreateSchema,
  roleUpdateSchema,
  stationCreateSchema,
  stationUpdateSchema,
  tankCreateSchema,
  tankUpdateSchema,
  userCreateSchema,
  userListQuery,
  userUpdateSchema,
} from "../validators/setup.ts";

/* Stations, tanks, pumps --------------------------------------------------------- */

export const stationRoutes = new Hono<AppEnv>();
stationRoutes.use(requireAuth);

stationRoutes.get("/", requirePermission("stations.view"), async (c) => ok(c, await stations.listStations(c.get("actor"))));
stationRoutes.post("/", requirePermission("stations.manage"), async (c) => {
  const input = await readJson(c, stationCreateSchema);
  return created(c, await stations.createStation(c.get("actor"), input), "Station registered.");
});
stationRoutes.get("/:id", requirePermission("stations.view"), async (c) => ok(c, await stations.getStation(c.get("actor"), readId(c))));
stationRoutes.patch("/:id", requirePermission("stations.manage"), async (c) => {
  const input = await readJson(c, stationUpdateSchema);
  return ok(c, await stations.updateStation(c.get("actor"), readId(c), input), "Station updated.");
});
stationRoutes.post("/:id/tanks", requirePermission("stations.manage"), async (c) => {
  const input = await readJson(c, tankCreateSchema);
  return created(c, await stations.createTank(c.get("actor"), readId(c), input), "Tank registered.");
});
stationRoutes.post("/:id/pumps", requirePermission("stations.manage"), async (c) => {
  const input = await readJson(c, pumpCreateSchema);
  return created(c, await stations.createPump(c.get("actor"), readId(c), input), "Pump registered.");
});

export const tankRoutes = new Hono<AppEnv>();
tankRoutes.use(requireAuth);
tankRoutes.patch("/:id", requirePermission("stations.manage"), async (c) => {
  const input = await readJson(c, tankUpdateSchema);
  return ok(c, await stations.updateTank(c.get("actor"), readId(c), input), "Tank updated.");
});

export const pumpRoutes = new Hono<AppEnv>();
pumpRoutes.use(requireAuth);
pumpRoutes.patch("/:id", requirePermission("stations.manage"), async (c) => {
  const input = await readJson(c, pumpUpdateSchema);
  return ok(c, await stations.updatePump(c.get("actor"), readId(c), input), "Pump updated.");
});

/* Products & prices ------------------------------------------------------------------ */

export const productRoutes = new Hono<AppEnv>();
productRoutes.use(requireAuth);

productRoutes.get("/", requireAnyPermission("products.manage", "stations.view"), async (c) => ok(c, await master.listProducts()));
productRoutes.post("/", requirePermission("products.manage"), async (c) => {
  const input = await readJson(c, productCreateSchema);
  return created(c, await master.createProduct(c.get("actor"), input), "Product created.");
});
productRoutes.patch("/:id", requirePermission("products.manage"), async (c) => {
  const input = await readJson(c, productUpdateSchema);
  return ok(c, await master.updateProduct(c.get("actor"), readId(c), input), "Product updated.");
});
productRoutes.get("/:id/prices", requireAnyPermission("products.manage", "stations.view"), async (c) => ok(c, await master.listPrices(readId(c))));
productRoutes.post("/:id/prices", requirePermission("products.manage"), async (c) => {
  const input = await readJson(c, priceCreateSchema);
  return created(c, await master.addPrice(c.get("actor"), readId(c), input), "Price saved — applies from its effective date.");
});

/* Narrations & banks --------------------------------------------------------------------- */

export const narrationRoutes = new Hono<AppEnv>();
narrationRoutes.use(requireAuth);
narrationRoutes.get("/", requireAnyPermission("narrations.manage", "expenses.view"), async (c) => ok(c, await master.listNarrations()));
narrationRoutes.post("/", requirePermission("narrations.manage"), async (c) => {
  const input = await readJson(c, narrationCreateSchema);
  return created(c, await master.createNarration(c.get("actor"), input), "Narration added.");
});
narrationRoutes.patch("/:id", requirePermission("narrations.manage"), async (c) => {
  const input = await readJson(c, narrationUpdateSchema);
  return ok(c, await master.updateNarration(c.get("actor"), readId(c), input), "Narration updated.");
});

export const bankRoutes = new Hono<AppEnv>();
bankRoutes.use(requireAuth);
bankRoutes.get("/", requireAnyPermission("banks.manage", "cash.view"), async (c) => ok(c, await master.listBanks()));
bankRoutes.post("/", requirePermission("banks.manage"), async (c) => {
  const input = await readJson(c, bankCreateSchema);
  return created(c, await master.createBank(c.get("actor"), input), "Bank added.");
});
bankRoutes.patch("/:id", requirePermission("banks.manage"), async (c) => {
  const input = await readJson(c, bankUpdateSchema);
  return ok(c, await master.updateBank(c.get("actor"), readId(c), input), "Bank updated.");
});

/* Users ------------------------------------------------------------------------------------ */

export const userRoutes = new Hono<AppEnv>();
userRoutes.use(requireAuth);

userRoutes.get("/", requirePermission("users.view"), async (c) => paged(c, await usersService.listUsers(readQuery(c, userListQuery))));
userRoutes.post("/", requirePermission("users.manage"), async (c) => {
  const input = await readJson(c, userCreateSchema);
  return created(c, await usersService.createUser(c.get("actor"), input), "User created — they must change the temporary password at first sign-in.");
});
userRoutes.get("/:id", requirePermission("users.view"), async (c) => ok(c, await usersService.getUser(readId(c))));
userRoutes.patch("/:id", requirePermission("users.manage"), async (c) => {
  const input = await readJson(c, userUpdateSchema);
  return ok(c, await usersService.updateUser(c.get("actor"), readId(c), input), "User updated.");
});
userRoutes.delete("/:id", requirePermission("users.manage"), async (c) => {
  await usersService.deleteUser(c.get("actor"), readId(c));
  return ok(c, null, "User deleted.");
});
userRoutes.post("/:id/unlock", requirePermission("users.manage"), async (c) => ok(c, await usersService.unlockUser(c.get("actor"), readId(c)), "Account unlocked."));
userRoutes.post("/:id/password-reset", requirePermission("users.manage"), async (c) => {
  const result = await usersService.issueUserPasswordReset(c.get("actor"), readId(c));
  return created(c, result, "Password reset link issued. Share it with the user securely — it is shown only once.");
});

/* Roles ------------------------------------------------------------------------------------- */

export const roleRoutes = new Hono<AppEnv>();
roleRoutes.use(requireAuth);

roleRoutes.get("/", requirePermission("roles.view"), async (c) => ok(c, await rolesService.listRoles()));
roleRoutes.get("/permissions", requirePermission("roles.view"), async (c) => ok(c, await rolesService.listPermissionCatalogue()));
roleRoutes.post("/", requirePermission("roles.manage"), async (c) => {
  const input = await readJson(c, roleCreateSchema);
  return created(c, await rolesService.createRole(c.get("actor"), input), "Role created.");
});
roleRoutes.patch("/:id", requirePermission("roles.manage"), async (c) => {
  const input = await readJson(c, roleUpdateSchema);
  return ok(c, await rolesService.updateRole(c.get("actor"), readId(c), input), "Role updated.");
});
roleRoutes.delete("/:id", requirePermission("roles.manage"), async (c) => {
  await rolesService.deleteRole(c.get("actor"), readId(c));
  return ok(c, null, "Role deleted.");
});

/* Settings ------------------------------------------------------------------------------------ */

export const settingsRoutes = new Hono<AppEnv>();
settingsRoutes.use(requireAuth);
settingsRoutes.get("/", async (c) => ok(c, await getSettings()));
settingsRoutes.put("/", requirePermission("settings.manage"), async (c) => {
  const input = await readJson(c, settingsUpdateSchema);
  return ok(c, await updateSettings(c.get("actor"), input), "Settings saved.");
});
