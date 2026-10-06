import { useQuery } from "@tanstack/react-query";
import { z } from "zod/v4";
import {
  customerWorkEstimateSchema,
  customerWorkProjectSchema,
} from "../../../api-server/src/services/returning-customer-contract";
import { contractorRequest } from "@/lib/contractor-api";

// Existing opportunity estimates allowed zero-quantity rows. Read their original
// evidence without silently applying the new returning-work input restrictions.
const legacyEstimateSchema = customerWorkEstimateSchema.safeExtend({
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().nonnegative(),
      unitPriceCents: z.number().int().nonnegative(),
      totalCents: z.number().int().nonnegative(),
    }),
  ),
});

export function useExactCustomerWork(
  kind: "estimates" | "projects",
  id: string | undefined,
  organizationId: string,
  scopeKey: string,
) {
  return useQuery({
    queryKey: ["native-customer-work", scopeKey, kind, id],
    enabled: !!id,
    retry: false,
    queryFn: async () => {
      const raw = await contractorRequest<Record<string, unknown>>(
        `/${kind}/${id}`,
      );
      const result =
        kind === "estimates"
          ? raw.customerWorkId
            ? customerWorkEstimateSchema.parse(raw)
            : legacyEstimateSchema.parse(raw)
          : customerWorkProjectSchema.parse(raw);
      if (result.id !== id || result.organizationId !== organizationId)
        throw new Error("Exact native record context changed");
      return result;
    },
  });
}
