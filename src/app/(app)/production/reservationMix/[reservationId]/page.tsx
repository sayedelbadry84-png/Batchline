import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { canPerformAction } from "@/lib/permissions";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import { getDictionary } from "@/lib/i18n";
import { getEffectiveMix } from "@/lib/reservationMixRevisions";
import { ReservationMixEditor, type MixOverrideRow } from "@/components/ReservationMixEditor";

// A reservation's mix can only be edited while it's still open for
// batching — matches the same window saveReservationMixRevision itself
// enforces server-side (EDITABLE_STATUSES in reservationMixRevisions.ts).
const EDITABLE_STATUSES = new Set(["CONFIRMED", "IN_PRODUCTION"]);

export default async function ReservationMixPage({ params }: { params: Promise<{ reservationId: string }> }) {
  const user = await requirePageAccess("production");
  const { reservationId } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.production;
  const mo = m.mixOverride;

  const [reservation, materials] = await Promise.all([
    prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        project: { include: { customer: true } },
        site: true,
        mix: { include: { components: { include: { material: true } } } },
        mixRevisions: { where: { status: "ACTIVE" }, take: 1 },
      },
    }),
    prisma.material.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!reservation) notFound();

  const canEditPermission = await canPerformAction(user.role, "production", "editReservationMix");
  const canEditScope = canEditPermission && isSiteInScope(reservation.siteId, effectiveSiteId(user));
  const isEditableState = EDITABLE_STATUSES.has(reservation.status);
  const canEdit = canEditScope && isEditableState;

  const effective = await getEffectiveMix(prisma, reservationId, reservation.mixId);

  const toRow = (materialId: string, materialName: string, materialType: string, designMassKgPerM3: number, note: string | null): MixOverrideRow => {
    const original = reservation.mix.components.find((c) => c.materialId === materialId);
    return {
      materialId,
      materialName,
      materialType,
      designMassKgPerM3,
      dosageUnit: (original?.dosageUnit as "KG" | "LITER") ?? "KG",
      specificGravity: original?.material.specificGravity ?? materials.find((mt) => mt.id === materialId)?.specificGravity ?? null,
      note,
    };
  };

  const originalComponents: MixOverrideRow[] = reservation.mix.components.map((c) =>
    toRow(c.materialId, c.material.name, c.material.type, c.designMassKgPerM3, null),
  );
  const initialComponents: MixOverrideRow[] = effective.components.map((c) => toRow(c.materialId, c.materialName, materials.find((mt) => mt.id === c.materialId)?.type ?? "", c.designMassKgPerM3, c.note));

  const availableMaterials = materials.map((mt) => ({ id: mt.id, name: mt.name, type: mt.type, specificGravity: mt.specificGravity }));

  const dUnit = dict.modules.mixDesigns.detail;
  const backHref = "/production";

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{mo.title}</h1>
        <Link href={backHref} className="mt-1 inline-block text-sm text-accent-strong hover:underline">
          ← {m.title}
        </Link>
      </header>

      <div className={ui.card}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-ink-muted">{m.col.reservation}</dt>
            <dd className="font-mono" dir="ltr">{reservation.reservationNumber}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">{m.col.project}</dt>
            <dd>
              {reservation.project.name}
              <div className="text-xs text-ink-muted">{reservation.project.customer.legalName}</div>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">{dict.field.siteCode}</dt>
            <dd>{reservation.site.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">{m.col.mix}</dt>
            <dd className="font-mono text-xs" dir="ltr">
              {reservation.mix.code}
              <div className="font-sans text-ink">{reservation.mix.grade}</div>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">{m.col.volume}</dt>
            <dd className="font-mono tabular">{reservation.requestedVolumeM3} m³</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">{m.col.status}</dt>
            <dd>{dict.status[reservation.status as keyof typeof dict.status] ?? reservation.status}</dd>
          </div>
          {effective.revisionNumber !== null && (
            <div>
              <dt className="text-xs text-ink-muted">{mo.title}</dt>
              <dd className="font-medium text-accent-strong">{mo.revisedBadge(effective.revisionNumber)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className={ui.card}>
        {canEdit ? (
          <ReservationMixEditor
            reservationId={reservation.id}
            volumeM3={reservation.requestedVolumeM3}
            originalComponents={originalComponents}
            initialComponents={initialComponents}
            hasActiveRevision={reservation.mixRevisions.length > 0}
            availableMaterials={availableMaterials}
            materialTypeLabels={dict.materialTypes}
            backHref={backHref}
            messages={{
              scopedNotice: mo.scopedNotice,
              col: mo.col,
              addMaterialPlaceholder: mo.addMaterialPlaceholder,
              addMaterialButton: mo.addMaterialButton,
              removeButton: mo.removeButton,
              resetComponentButton: mo.resetComponentButton,
              resetAllButton: mo.resetAllButton,
              reasonLabel: mo.reasonLabel,
              reasonPlaceholder: mo.reasonPlaceholder,
              saveButton: mo.saveButton,
              cancelButton: mo.cancelButton,
              cancelRevisionButton: mo.cancelRevisionButton,
              confirmSavePrompt: mo.confirmSavePrompt,
              confirmCancelPrompt: mo.confirmCancelPrompt,
              waterCementWarning: mo.waterCementWarning,
              wcRatioNote: mo.wcRatioNote,
              errorNotFound: mo.errorNotFound,
              errorInvalidState: mo.errorInvalidState,
              errorNoComponents: mo.errorNoComponents,
              errorDuplicateMaterial: mo.errorDuplicateMaterial,
              errorInvalidQuantity: mo.errorInvalidQuantity,
              errorMaterialNotFound: mo.errorMaterialNotFound,
              errorInvalidReason: mo.errorInvalidReason,
              errorNoActiveRevision: mo.errorNoActiveRevision,
              unitKgShort: dUnit.unitKgShort,
              unitLiterShort: dUnit.unitLiterShort,
            }}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {isEditableState ? null : <p className="text-sm text-warn">{mo.notEditableState}</p>}
            <div className="overflow-x-auto">
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>{mo.col.material}</th>
                    <th className={ui.th}>{mo.col.type}</th>
                    <th className={ui.th}>{mo.col.modified}</th>
                    <th className={ui.th}>{mo.col.note}</th>
                  </tr>
                </thead>
                <tbody>
                  {initialComponents.map((c) => (
                    <tr key={c.materialId}>
                      <td className={ui.td}>{c.materialName}</td>
                      <td className={`${ui.td} text-xs text-ink-muted`}>{dict.materialTypes[c.materialType as keyof typeof dict.materialTypes] ?? c.materialType}</td>
                      <td className={`${ui.td} font-mono tabular text-xs`}>{c.designMassKgPerM3.toFixed(2)} kg</td>
                      <td className={`${ui.td} text-xs`}>{c.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
