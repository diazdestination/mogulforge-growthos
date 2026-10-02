export * from "./generated/api";
export * from "./generated/types";
// Orval names this path validator the same as its generated query-argument
// type. Keep the public query type and expose the path validator explicitly.
export type { GetServiceCareParams } from "./generated/types/getServiceCareParams";
export { GetServiceCareParams as GetServiceCarePathParams } from "./generated/api";
