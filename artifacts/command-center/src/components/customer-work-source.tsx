import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getContact } from "@workspace/api-client-react";
import ContactSelect from "./contact-select";
import CustomerPropertySelect from "./customer-property-select";
import { workdayButton } from "./workday-ui";

export type CustomerWorkChoice = {
  contactId: string;
  propertyId: string | null;
  confirmed: boolean;
};
/** Shared explicit source selection; property identity never comes from a label. */
export function CustomerWorkSource({
  organizationId,
  scopeKey,
  value,
  onChange,
  disabled,
  purpose = "estimate",
}: {
  organizationId: string;
  scopeKey: string;
  value: CustomerWorkChoice;
  onChange: (value: CustomerWorkChoice) => void;
  disabled?: boolean;
  purpose?: "estimate" | "job" | "invoice";
}) {
  const customer = useQuery({
    queryKey: ["customer-work-customer", scopeKey, value.contactId],
    enabled: !!value.contactId,
    retry: false,
    queryFn: async () => {
      const record = await getContact(value.contactId);
      if (
        record.id !== value.contactId ||
        record.organizationId !== organizationId
      )
        throw new Error("Customer context changed");
      return record;
    },
  });
  const [propertyReady, setPropertyReady] = useState(false);
  useEffect(() => {
    if ((customer.isError || !propertyReady) && value.confirmed)
      onChange({ ...value, confirmed: false });
  }, [customer.isError, propertyReady, value.confirmed]);
  return (
    <section
      aria-label="Existing customer work source"
      className="min-w-0 space-y-3 rounded-lg border p-3"
    >
      <div className="text-sm font-medium">
        <p>Existing customer</p>
        <ContactSelect
          label="Existing customer"
          value={value.contactId}
          queryScope={scopeKey}
          required
          onChange={(contactId) =>
            onChange({ contactId, propertyId: null, confirmed: false })
          }
          testId="customer-work-contact"
        />
      </div>
      {customer.isPending && value.contactId && (
        <p role="status">Checking the exact customer…</p>
      )}
      {customer.isError && (
        <p role="alert">
          The current customer could not be verified. No work may be created
          from this selection.
        </p>
      )}
      {customer.data && !customer.isError && (
        <p className="break-words text-sm">
          Customer:{" "}
          {[customer.data.firstName, customer.data.lastName]
            .filter(Boolean)
            .join(" ") || "Customer"}{" "}
          · {customer.data.id}
        </p>
      )}
      <CustomerPropertySelect
        organizationId={organizationId}
        contactId={value.contactId}
        scopeKey={scopeKey}
        purpose={purpose}
        value={value.propertyId ?? ""}
        disabled={disabled}
        onReadyChange={setPropertyReady}
        onChange={(propertyId) =>
          onChange({
            ...value,
            propertyId: propertyId || null,
            confirmed: false,
          })
        }
      />
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={
            value.confirmed &&
            !!customer.data &&
            !customer.isError &&
            propertyReady
          }
          disabled={
            disabled || !customer.data || customer.isError || !propertyReady
          }
          onChange={(event) =>
            onChange({ ...value, confirmed: event.target.checked })
          }
        />
        I checked this customer and{" "}
        {value.propertyId
          ? "selected property"
          : "deliberately chose no property"}{" "}
        for this new work.
      </label>
      <p className="text-xs text-muted-foreground">
        This creates returning work, not a new lead. Its customer/property
        identity stays fixed; a different job needs a separate work record.
      </p>
    </section>
  );
}
export function CustomerWorkCommandNotice({
  command,
  allowed = true,
}: {
  command: {
    busy: boolean;
    pending: unknown;
    error: string;
    retry: () => unknown;
  };
  allowed?: boolean;
}) {
  return (
    <>
      {command.busy && (
        <p role="status">Confirming the original submitted work request…</p>
      )}
      {command.error && (
        <p role="alert" className="break-words text-sm">
          {command.error}
        </p>
      )}
      {command.pending &&
        !command.busy &&
        (allowed ? (
          <button
            type="button"
            className={workdayButton}
            onClick={() => void command.retry()}
          >
            Reconcile original work request
          </button>
        ) : (
          <p className="text-sm">
            The original request is retained. Your current access cannot
            reconcile it.
          </p>
        ))}
    </>
  );
}
