export * from "./generated/api";
export * from "./generated/types";
// Orval names this path validator the same as its generated query-argument
// type. Keep the public query type and expose the path validator explicitly.
export type { GetServiceCareParams } from "./generated/types/getServiceCareParams";
export { GetServiceCareParams as GetServiceCarePathParams } from "./generated/api";
export type { ListServiceMailboxRepliesParams } from "./generated/types/listServiceMailboxRepliesParams";
export { ListServiceMailboxRepliesParams as ListServiceMailboxRepliesPathParams } from "./generated/api";
export type { ListLeadMailboxRepliesParams } from "./generated/types/listLeadMailboxRepliesParams";
export { ListLeadMailboxRepliesParams as ListLeadMailboxRepliesPathParams } from "./generated/api";
export type { ListServiceSmsRepliesParams } from "./generated/types/listServiceSmsRepliesParams";
export { ListServiceSmsRepliesParams as ListServiceSmsRepliesPathParams } from "./generated/api";
export type { GetCustomerWorkspaceSectionParams } from "./generated/types/getCustomerWorkspaceSectionParams";
export { GetCustomerWorkspaceSectionParams as GetCustomerWorkspaceSectionPathParams } from "./generated/api";
