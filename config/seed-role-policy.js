/**
 * Applies the access policy of the medical deployment to the USER and ADMIN
 * roles.
 *
 * librechat.pure-doctor.yaml deliberately leaves feature permissions out of
 * `interface:`: anything set there is rewritten into every role on each boot,
 * so the admin would be locked out of the agent builder together with the
 * patients. Role permissions live in the database instead and are edited in
 * the admin panel (Access > Roles). This script writes the same policy into a
 * fresh database, or puts a drifted one back.
 *
 *   docker compose -f deploy-compose.yml --profile seed run --rm seed \
 *     node config/seed-role-policy.js [--dry-run]
 */
const path = require('path');

/**
 * USER is the patient-facing role: it chats with the doctor agent (which uses
 * MCP tools, web search, file search and per-person memory), and nothing else.
 * Building, editing or sharing agents, prompts, MCP servers or skills stays
 * with the admin, and public chat links are off because chats hold health data.
 */
const USER_POLICY = {
  AGENTS: { USE: true, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  PROMPTS: { USE: false, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  // USE must stay on: agent MCP tools are only loaded for roles that may use MCP servers.
  MCP_SERVERS: { USE: true, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  SKILLS: { USE: false, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  REMOTE_AGENTS: { USE: false, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  MEMORIES: { USE: true, CREATE: true, UPDATE: true, READ: true, OPT_OUT: true },
  WEB_SEARCH: { USE: true },
  FILE_SEARCH: { USE: true },
  FILE_CITATIONS: { USE: true },
  MARKETPLACE: { USE: false },
  PEOPLE_PICKER: { VIEW_USERS: false, VIEW_GROUPS: false, VIEW_ROLES: false },
  BOOKMARKS: { USE: false },
  MULTI_CONVO: { USE: false },
  TEMPORARY_CHAT: { USE: false },
  RUN_CODE: { USE: false },
  SHARED_LINKS: { CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  SCHEDULES: { USE: false, CREATE: false },
};

/** ADMIN gets every permission the USER policy names, all switched on. */
const ADMIN_POLICY = Object.fromEntries(
  Object.entries(USER_POLICY).map(([type, perms]) => [
    type,
    Object.fromEntries(Object.keys(perms).map((perm) => [perm, true])),
  ]),
);

const ROLE_POLICY = { USER: USER_POLICY, ADMIN: ADMIN_POLICY };

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log(JSON.stringify(ROLE_POLICY, null, 2));
    process.exit(0);
  }

  require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
  const connect = require('./connect');
  // Registers the mongoose models the role methods below read from.
  require('~/db/models');
  const { getRoleByName, updateAccessPermissions } = require('~/models');

  await connect();
  for (const [roleName, policy] of Object.entries(ROLE_POLICY)) {
    // The API creates the default roles on its first boot; this script only
    // adjusts them, so start the API once before running it on a new database.
    const role = await getRoleByName(roleName);
    if (!role) {
      throw new Error(`role ${roleName} does not exist yet; start the API once first`);
    }
    await updateAccessPermissions(roleName, policy, role);
    console.log(`[seed-role-policy] ${roleName}: policy applied`);
  }

  const mongoose = require('mongoose');
  // Let the index builds that loading the models started finish before closing.
  await Promise.allSettled(Object.values(mongoose.models).map((model) => model.init()));
  await mongoose.disconnect();
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[seed-role-policy] failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { ROLE_POLICY, USER_POLICY, ADMIN_POLICY };
