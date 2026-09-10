import type { Prisma } from "@prisma/client";
// Lock order: LeaveRequest (when present), Employee, Plant. Transfers
// update Employee and therefore cannot pass a scope check held here.
export async function lockEmployeeScope(tx: Prisma.TransactionClient, employeeId: string, siteId: string | null) {
  await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} FOR UPDATE`;
  const employee = await tx.employee.findUnique({ where: { id: employeeId } });
  if (!employee) return false;
  await tx.$queryRaw`SELECT "id" FROM "Plant" WHERE "id" = ${employee.plantId} FOR SHARE`;
  const plant = await tx.plant.findUnique({ where: { id: employee.plantId }, select: { siteId: true } });
  return !!plant && (siteId === null || plant.siteId === siteId);
}
export async function lockLeaveScope(tx: Prisma.TransactionClient, id: string, siteId: string | null) {
  await tx.$queryRaw`SELECT "id" FROM "LeaveRequest" WHERE "id" = ${id} FOR UPDATE`;
  const leave = await tx.leaveRequest.findUnique({ where: { id } });
  if (!leave || !(await lockEmployeeScope(tx, leave.employeeId, siteId))) return null;
  return leave;
}
