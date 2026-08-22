import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { MODULE_NAV, VIEW_NAV, ASSIGNABLE_ROLES, getEffectiveRoles } from "@/lib/permissions";
import { saveModulePermissions } from "./actions";
import { PermissionRow } from "./PermissionRow";

export default async function PermissionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // Deliberately not routed through requirePageAccess/MODULE_ROLES like
  // every other page — this IS the screen that edits that table, so an
  // Admin who mis-clicks a checkbox elsewhere must still always be able to
  // reach this one specific page to undo it.
  if (user.role !== "ADMIN") redirect("/access-denied?module=permissions");

  const { dict } = await getDictionary();
  const m = dict.modules.permissions;

  const allModules = [...MODULE_NAV, ...VIEW_NAV];
  const existingRows = await prisma.rolePermission.findMany();
  const customizedKeys = new Set(existingRows.map((r) => r.moduleKey));

  const rows = await Promise.all(
    allModules.map(async (mod) => ({
      mod,
      roles: await getEffectiveRoles(mod.key),
      customized: customizedKeys.has(mod.key),
    })),
  );

  const roleLabels = Object.fromEntries(ASSIGNABLE_ROLES.map((r) => [r, dict.roles[r]]));

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.module}</th>
              {ASSIGNABLE_ROLES.map((r) => (
                <th key={r} className={`${ui.th} text-center`}>
                  {dict.roles[r]}
                </th>
              ))}
              <th className={ui.th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ mod, roles, customized }) => {
              const formId = `perm-${mod.key}`;
              return (
                <tr key={mod.key}>
                  <td className={`${ui.td} font-medium`}>
                    {dict.nav[mod.labelKey]}
                    <div className="text-xs text-ink-faint">{customized ? m.customNote : m.defaultNote}</div>
                    <form id={formId} action={saveModulePermissions}>
                      <input type="hidden" name="moduleKey" value={mod.key} />
                    </form>
                  </td>
                  <PermissionRow
                    formId={formId}
                    roles={ASSIGNABLE_ROLES}
                    roleLabels={roleLabels}
                    initialChecked={roles as string[]}
                    saveLabel={m.save}
                    warningLabel={m.allUncheckedWarning}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
