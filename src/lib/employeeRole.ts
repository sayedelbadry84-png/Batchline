// Plain shared constant — kept in its own non-"use client" module so both
// RoleSelect.tsx (client) and employees/actions.ts (server) can import it
// without either crossing the client/server boundary through the other.
export const OTHER_ROLE_SENTINEL = "__OTHER__";
