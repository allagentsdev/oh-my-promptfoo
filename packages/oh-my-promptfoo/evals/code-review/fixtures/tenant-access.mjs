export function canReadInvoice(invoice, user) {
  return user.roles.includes("billing");
}
