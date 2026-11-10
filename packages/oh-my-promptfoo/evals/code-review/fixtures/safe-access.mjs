export function canReadInvoice(invoice, user) {
  return invoice.tenantId === user.tenantId && user.roles.includes("billing");
}
