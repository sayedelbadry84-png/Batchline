import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { MODULE_NAV, VIEW_NAV, getAllRoles, ACTION_LIST, getEffectiveRoles, getEffectiveActionRoles } from "@/lib/permissions";
import { saveModulePermissions, saveActionPermissions } from "./actions";
import { PermissionRow } from "./PermissionRow";

export default async function PermissionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // Deliberately not routed through requirePageAccess/MODULE_ROLES like
  // every other page — this IS the screen that edits that table, so an
  // Admin who mis-clicks a checkbox elsewhere must still always be able to
  // reach this one specific page to undo it.
  if (user.role !== "ADMIN") redirect("/access-denied?module=permissions");

  const { dict, locale } = await getDictionary();
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

  const allRoles = await getAllRoles();
  const roleKeys = allRoles.map((r) => r.key);
  const roleLabels = Object.fromEntries(allRoles.map((r) => [r.key, locale === "ar" ? r.labelAr : r.labelEn]));

  const existingActionRows = await prisma.actionPermission.findMany();
  const customizedActionKeys = new Set(existingActionRows.map((r) => `${r.moduleKey}:${r.actionKey}`));
  const actionRows = await Promise.all(
    ACTION_LIST.map(async (a) => ({
      ...a,
      roles: await getEffectiveActionRoles(a.moduleKey, a.actionKey),
      customized: customizedActionKeys.has(`${a.moduleKey}:${a.actionKey}`),
    })),
  );

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
              {roleKeys.map((r) => (
                <th key={r} className={`${ui.th} text-center`}>
                  {roleLabels[r]}
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
                    roles={roleKeys}
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

      <header>
        <h2 className="font-display text-lg font-semibold">{m.actionsTitle}</h2>
        <p className={ui.intro}>{m.actionsIntro}</p>
      </header>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.module}</th>
              {roleKeys.map((r) => (
                <th key={r} className={`${ui.th} text-center`}>
                  {roleLabels[r]}
                </th>
              ))}
              <th className={ui.th}></th>
            </tr>
          </thead>
          <tbody>
            {actionRows.map(({ moduleKey, actionKey, roles, customized }) => {
              const formId = `action-perm-${moduleKey}-${actionKey}`;
              const label = m.actionLabel[moduleKey][actionKey as keyof (typeof m.actionLabel)[typeof moduleKey]];
              return (
                <tr key={`${moduleKey}:${actionKey}`}>
                  <td className={`${ui.td} font-medium`}>
                    {dict.nav[MODULE_NAV.find((mod) => mod.key === moduleKey)?.labelKey ?? "dashboard"]} — {label}
                    <div className="text-xs text-ink-faint">{customized ? m.customNote : m.defaultNote}</div>
                    <form id={formId} action={saveActionPermissions}>
                      <input type="hidden" name="moduleKey" value={moduleKey} />
                      <input type="hidden" name="actionKey" value={actionKey} />
                    </form>
                  </td>
                  <PermissionRow
                    formId={formId}
                    roles={roleKeys}
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
