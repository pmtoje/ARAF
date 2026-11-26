import type { Role } from "../domain/roles";

/** Credit staff who review Pay with ARAF applications (evaluate, request information, recommend, reject). */
export const PWA_OPERATOR_ROLES: readonly Role[] = ["CREDIT_OFFICER_1", "CREDIT_OFFICER_2", "CREDIT_OFFICER_3", "CREDIT_LEAD_1", "CREDIT_LEAD_2", "UNIT_HEAD"];
/** Credit approvers: give the final approval. Never the officer who recommended approval. */
export const PWA_APPROVER_ROLES: readonly Role[] = ["CREDIT_LEAD_1", "CREDIT_LEAD_2", "UNIT_HEAD"];
/** May view the Pay with ARAF queue. */
export const PWA_VIEW_ROLES: readonly Role[] = [...PWA_OPERATOR_ROLES, "SUPER_ADMIN"];
