import { useId } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { assetPageFor } from "./workday-contract";
import { workdayRequest } from "./workday-ui";
import {
  invoiceButton,
  invoiceControl,
  type InvoiceDocument,
  type InvoiceEquipmentSelection,
  type InvoiceEquipmentSnapshot,
} from "@/lib/invoice-ui";

const MAX_EQUIPMENT = 10;
function identity(item: Pick<InvoiceEquipmentSnapshot, "manufacturer" | "model">) {
  return [item.manufacturer, item.model].filter(Boolean).join(" ");
}

/**
 * Staff choose recorded equipment; the server copies its current facts into
 * the draft. Warranty terms are typed by staff and printed verbatim.
 */
export function InvoiceEquipmentPicker({
  organizationId,
  contactId,
  propertyId,
  attached,
  value,
  onChange,
  disabled,
}: {
  organizationId: string;
  contactId: string;
  propertyId: string | null;
  attached: InvoiceEquipmentSnapshot[];
  value: InvoiceEquipmentSelection;
  onChange: (next: InvoiceEquipmentSelection) => void;
  disabled: boolean;
}) {
  const prefix = useId();
  const assets = useInfiniteQuery({
    queryKey: ["invoice-equipment", organizationId, contactId, propertyId],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => {
      const query = new URLSearchParams();
      if (propertyId) query.set("propertyId", propertyId);
      if (pageParam) query.set("cursor", pageParam);
      const search = query.toString();
      return workdayRequest(assetPageFor(organizationId, contactId, propertyId), `/contacts/${contactId}/assets${search ? `?${search}` : ""}`, { signal });
    },
    // Stop rather than loop if the server ever repeats a cursor.
    getNextPageParam: (last, _pages, _param, params) =>
      last.hasMore && last.nextCursor && !params.includes(last.nextCursor) ? last.nextCursor : undefined,
  });
  const listed = new Map((assets.data?.pages ?? []).flatMap((page) => page.items).map((asset) => [asset.id, asset]));
  const active = [...listed.values()].filter((asset) => asset.status === "active");
  const loaded = new Set(active.map((asset) => asset.id));
  // Keep earlier attachments visible even when no longer listed, so removal is explicit.
  const earlier = attached.filter((item) => value.assetIds.includes(item.assetId) && !loaded.has(item.assetId));
  const toggle = (id: string, checked: boolean) =>
    onChange({
      ...value,
      assetIds: checked ? [...value.assetIds, id] : value.assetIds.filter((selected) => selected !== id),
    });
  const full = value.assetIds.length >= MAX_EQUIPMENT;
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Equipment and warranty (optional)</legend>
      <p className="text-sm text-muted-foreground">
        Attach equipment already recorded for this customer. Saving copies its current make, model, serial and recorded
        warranty dates into this draft; issuing keeps that copy unchanged.
      </p>
      {assets.isLoading && <p role="status" className="text-sm">Loading recorded equipment…</p>}
      {assets.isError && (
        <p role="alert" className="text-sm text-destructive">
          Recorded equipment could not be loaded. The invoice can still be saved without it.
        </p>
      )}
      {assets.isSuccess && !assets.hasNextPage && active.length === 0 && earlier.length === 0 && (
        <p className="text-sm">No active equipment is recorded for this customer{propertyId ? " at this property" : ""}.</p>
      )}
      <ul className="space-y-2">
        {active.map((asset) => {
          const checked = value.assetIds.includes(asset.id);
          return (
            <li key={asset.id} className="flex min-w-0 items-start gap-2">
              <input
                id={`${prefix}-${asset.id}`}
                type="checkbox"
                className="mt-1 h-5 w-5"
                checked={checked}
                disabled={!checked && full}
                onChange={(event) => toggle(asset.id, event.target.checked)}
              />
              <label htmlFor={`${prefix}-${asset.id}`} className="min-w-0 text-sm [overflow-wrap:anywhere]">
                <span className="font-medium">{asset.label}</span>
                {identity(asset) && <span> — {identity(asset)}</span>}
                {asset.serial && <span className="block text-muted-foreground">Serial {asset.serial}</span>}
                {(asset.warrantyStartsOn || asset.warrantyEndsOn) && (
                  <span className="block text-muted-foreground">
                    Recorded warranty {asset.warrantyStartsOn ?? "start not recorded"} to {asset.warrantyEndsOn ?? "end not recorded"}
                  </span>
                )}
              </label>
            </li>
          );
        })}
        {earlier.map((item) => (
          <li key={item.assetId} className="flex min-w-0 items-start gap-2">
            <input
              id={`${prefix}-${item.assetId}`}
              type="checkbox"
              className="mt-1 h-5 w-5"
              checked
              onChange={() => toggle(item.assetId, false)}
            />
            <label htmlFor={`${prefix}-${item.assetId}`} className="min-w-0 text-sm [overflow-wrap:anywhere]">
              <span className="font-medium">{item.label}</span> (attached earlier; no longer listed as active here — uncheck
              to remove)
            </label>
          </li>
        ))}
      </ul>
      {assets.hasNextPage && (
        <button
          type="button"
          className={invoiceButton}
          disabled={assets.isFetchingNextPage}
          onClick={() => void assets.fetchNextPage()}
        >
          {assets.isFetchingNextPage ? "Loading more equipment…" : "Load more recorded equipment"}
        </button>
      )}
      {full && <p className="text-sm">Up to {MAX_EQUIPMENT} equipment records can be attached.</p>}
      <div>
        <label htmlFor={`${prefix}-terms`} className="mb-1 block text-sm font-medium">
          Warranty terms to print on the invoice (optional)
        </label>
        <textarea
          id={`${prefix}-terms`}
          className={invoiceControl}
          rows={3}
          maxLength={2000}
          value={value.warrantyTerms ?? ""}
          onChange={(event) => onChange({ ...value, warrantyTerms: event.target.value || null })}
          aria-describedby={`${prefix}-terms-help`}
        />
        <p id={`${prefix}-terms-help`} className="mt-1 text-xs text-muted-foreground">
          For example, your own workmanship warranty. Printed exactly as typed; GrowthOS does not decide coverage.
        </p>
      </div>
    </fieldset>
  );
}

export function InvoiceEquipmentView({ equipment }: { equipment: InvoiceDocument["equipment"] }) {
  if (!equipment) return null;
  const dated = equipment.items.some((item) => item.warrantyStartsOn || item.warrantyEndsOn);
  const recordedWarranty = equipment.items.some((item) => item.warrantyStartsOn || item.warrantyEndsOn || item.warrantySource);
  return (
    <section aria-label="Equipment and warranty" className="space-y-3 text-sm">
      {equipment.items.length > 0 && (
        <>
          <h4 className="font-semibold">Equipment serviced</h4>
          <ul className="space-y-2">
            {equipment.items.map((item) => (
              <li key={item.assetId} className="[overflow-wrap:anywhere]">
                <span className="font-medium">{item.label}</span>
                {identity(item) && <span> — {identity(item)}</span>}
                {item.serial && <span className="block">Serial: {item.serial}</span>}
                {item.location && <span className="block">Location: {item.location}</span>}
                {item.installedOn && <span className="block">Installed: {item.installedOn}</span>}
                {(item.warrantyStartsOn || item.warrantyEndsOn || item.warrantySource) && (
                  <span className="block">
                    Recorded warranty: {item.warrantyStartsOn ?? "start not recorded"} to{" "}
                    {item.warrantyEndsOn ?? "end not recorded"}
                    {item.warrantySource && ` (source: ${item.warrantySource})`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {equipment.warrantyTerms && (
        <>
          <h4 className="font-semibold">Warranty terms</h4>
          <p className="whitespace-pre-wrap break-words">{equipment.warrantyTerms}</p>
        </>
      )}
      {recordedWarranty && (
        <p className="text-xs text-muted-foreground">
          Recorded warranty {dated ? "dates are" : "information is"} listed for reference; the warranty provider determines coverage.
        </p>
      )}
    </section>
  );
}
