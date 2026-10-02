import { useState } from "react";

/** Setup guidance only. Both website types use the same tenant-scoped intake contract. */
export function WebsiteConnectionGuide() {
  const [website, setWebsite] = useState<"existing" | "smart-site">("existing");

  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          Which website are you connecting?
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {(
            [
              ["existing", "Keep my current website"],
              ["smart-site", "Connect a MogulForge Smart Site"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="website-setup-guide"
                value={value}
                checked={website === value}
                onChange={() => setWebsite(value)}
                className="h-4 w-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {website === "existing"
          ? "Keep your website and branding. Your website manager can connect its inquiry form to GrowthOS. Compatibility and installation need to be checked before it can receive leads."
          : "Connect your Smart Site to this company’s GrowthOS workspace. The website keeps its own branding; accepted inquiries appear here for your team to follow up."}
      </p>
      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer font-medium">
          What happens before leads can arrive?
        </summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
          <li>
            Create the draft connection below and save its private server
            settings.
          </li>
          <li>
            {website === "existing"
              ? "Have your website manager install a server connection for the form. A supported backend or secure relay is required; never paste the private key into a webpage."
              : "Have your Smart Site installer configure its server connection using the saved settings."}
          </li>
          <li>
            Choose who responds to inquiries and confirm the customer contact
            policy.
          </li>
          <li>
            Verify the connection, test an approved inquiry through to the lead
            inbox, then complete the launch checks before accepting customer
            traffic.
          </li>
        </ol>
        <p className="mt-3 text-muted-foreground">
          Choosing a website type only changes this guide. A draft does not
          enable capture, send messages, book appointments, or connect Housecall
          Pro.
        </p>
      </details>
    </div>
  );
}
