import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/api-client-react", () => ({ importLeadsCsv: vi.fn() }));
import { importLeadsCsv } from "@workspace/api-client-react";
import { HousecallCustomerImport } from "./housecall-customer-import";

const csv = 'ID,First Name,Last Name,Email,Mobile Number\ncus_1,"Smith, Jane",Smith,jane@example.test,\n';
const preview = { dryRun: true as const, fileName: "customers.csv", totalRows: 1, imported: 1, updated: 0, duplicates: 0, conflicts: 0, skipped: 0, suppressed: 0, errors: [], errorsTruncated: false, sourceKey: "housecall-pro", snapshotAsOf: null };
const saved = { id: "imp-1", fileName: "customers.csv", totalRows: 1, imported: 1, updated: 0, duplicates: 0, conflicts: 0, skipped: 0, suppressed: 0, errors: [], sourceKey: "housecall-pro", snapshotAsOf: null, createdAt: "2026-10-12T00:00:00Z" };
const upload = (name: string, body: string) =>
  fireEvent.change(screen.getByLabelText("Housecall Pro customer CSV"), { target: { files: [new File([body], name, { type: "text/csv" })] } });

afterEach(() => { cleanup(); vi.mocked(importLeadsCsv).mockReset(); });

describe("Housecall Pro customer import", () => {
  it("previews with suggested columns before an explicit, reviewed import", async () => {
    vi.mocked(importLeadsCsv).mockResolvedValueOnce(preview).mockResolvedValueOnce(saved);
    const onImported = vi.fn();
    render(<HousecallCustomerImport onImported={onImported} />);
    expect(screen.getByText(/Customers/, { selector: "strong" })).toBeTruthy();
    upload("customers.csv", csv);
    const first = await screen.findByLabelText(/First name/);
    expect((first as HTMLSelectElement).value).toBe("1");
    expect(screen.getByText("e.g. Smith, Jane")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import customers" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    await screen.findByTestId("hcp-import-preview");
    expect(vi.mocked(importLeadsCsv).mock.calls[0][0]).toMatchObject({
      dryRun: true, sourceKey: "housecall-pro", mapping: { externalCustomerId: 0, firstName: 1, lastName: 2, email: 3, phone: 4 },
    });
    const importButton = screen.getByRole("button", { name: "Import customers" }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed this preview/));
    fireEvent.click(importButton);
    await screen.findByTestId("hcp-import-done");
    expect(vi.mocked(importLeadsCsv).mock.calls[1][0]).toMatchObject({ dryRun: false });
    expect(onImported).toHaveBeenCalledWith(saved);
  });

  it("requires a new preview after the mapping changes", async () => {
    vi.mocked(importLeadsCsv).mockResolvedValue(preview);
    render(<HousecallCustomerImport onImported={vi.fn()} />);
    upload("customers.csv", csv);
    fireEvent.click(await screen.findByRole("button", { name: "Preview import" }));
    await screen.findByTestId("hcp-import-preview");
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: "2" } });
    await waitFor(() => expect(screen.queryByTestId("hcp-import-preview")).toBeNull());
  });

  it("clears the review confirmation when a new preview is generated", async () => {
    vi.mocked(importLeadsCsv).mockResolvedValue(preview);
    render(<HousecallCustomerImport onImported={vi.fn()} />);
    upload("customers.csv", csv);
    fireEvent.click(await screen.findByRole("button", { name: "Preview import" }));
    fireEvent.click(await screen.findByLabelText(/I reviewed this preview/));
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    await screen.findByTestId("hcp-import-preview");
    expect((screen.getByLabelText(/I reviewed this preview/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Import customers" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not claim nothing was saved when the import outcome is unknown", async () => {
    vi.mocked(importLeadsCsv).mockResolvedValueOnce(preview).mockRejectedValueOnce(new TypeError("network lost"));
    render(<HousecallCustomerImport onImported={vi.fn()} />);
    upload("customers.csv", csv);
    fireEvent.click(await screen.findByRole("button", { name: "Preview import" }));
    fireEvent.click(await screen.findByLabelText(/I reviewed this preview/));
    fireEvent.click(screen.getByRole("button", { name: "Import customers" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not confirm the import result.*Check your import history/);
    expect(alert.textContent).not.toMatch(/Nothing was imported/);
    expect(screen.queryByTestId("hcp-import-preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Import customers" })).toBeNull();
  });

  it("explains how to convert an Excel export instead of uploading it", async () => {
    render(<HousecallCustomerImport onImported={vi.fn()} />);
    upload("customers.xlsx", "binary");
    expect((await screen.findByRole("alert")).textContent).toMatch(/save or download it as CSV/);
    expect(importLeadsCsv).not.toHaveBeenCalled();
  });
});
