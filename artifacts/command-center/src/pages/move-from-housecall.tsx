import { useState } from "react";
import { Link } from "wouter";
import { HousecallCustomerImport } from "@/components/housecall-customer-import";
import { HousecallEstimatesImport } from "@/components/housecall-estimates-import";
import { HousecallJobsImport } from "@/components/housecall-jobs-import";

/** One place to bring a contractor's Housecall Pro history into GrowthOS. */
export default function MoveFromHousecall() {
  const [customersImported, setCustomersImported] = useState(false);
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Move from Housecall Pro</h1>
        <p className="text-sm text-muted-foreground">
          Bring your customers, job history, open estimates, invoices and open balances. Every step shows a preview first and saves nothing until you confirm. Importing the same file again never creates duplicates, and nothing is sent to your customers.
        </p>
      </header>
      <section className="rounded-lg border p-4" aria-labelledby="hcp-customers">
        <h2 id="hcp-customers" className="text-lg font-semibold">Customers</h2>
        <p className="text-sm text-muted-foreground">Contacts, service addresses, tags, lead source and notes.</p>
        <HousecallCustomerImport onImported={() => setCustomersImported(true)} />
        {customersImported && <p className="mt-2 text-sm">Next: import your jobs report below.</p>}
      </section>
      <section className="rounded-lg border p-4" aria-labelledby="hcp-jobs">
        <h2 id="hcp-jobs" className="text-lg font-semibold">Jobs, invoices and open balances</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Job history on each customer, upcoming visits, then invoices and what customers still owe. Imported invoices appear under <Link href="/invoices" className="underline">Invoices</Link>.
        </p>
        <HousecallJobsImport />
      </section>
      <section className="rounded-lg border p-4" aria-labelledby="hcp-estimates">
        <h2 id="hcp-estimates" className="text-lg font-semibold">Estimates</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Open estimates come in ready for follow-up under <Link href="/estimates" className="underline">Estimates</Link>; approved and declined ones become customer history.
        </p>
        <HousecallEstimatesImport />
      </section>
    </div>
  );
}
