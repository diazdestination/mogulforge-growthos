import { afterEach, describe, expect, it, vi } from "vitest";
import { dollarsToCents, printInvoiceDocument } from "./invoice-ui";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
describe("Saved invoice documents", () => {
  it("prints only escaped saved document content with a repeating table header", () => {
    const article = document.createElement("article");
    article.textContent = "Customer <script>doNotRun()</script> & service";
    const originalAppend = document.body.append.bind(document.body);
    let savedMarkup = "";
    const print = vi.fn();
    vi.spyOn(document.body, "append").mockImplementation((...nodes) => {
      originalAppend(...nodes);
      const frame = nodes[0] as HTMLIFrameElement;
      frame.contentWindow!.focus = vi.fn();
      frame.contentWindow!.print = () => {
        savedMarkup = frame.contentDocument!.documentElement.outerHTML;
        print();
        frame.contentWindow!.dispatchEvent(new Event("afterprint"));
      };
    });
    printInvoiceDocument(article);
    expect(print).toHaveBeenCalledTimes(1);
    expect(savedMarkup).toContain("&lt;script&gt;doNotRun()&lt;/script&gt;");
    expect(savedMarkup).not.toContain("<script>");
    expect(savedMarkup).toContain("thead{display:table-header-group}");
    expect(savedMarkup).not.toContain("position:absolute");
    expect(document.querySelector("iframe")).toBeNull();
  });
  it.each(["", "NaN", "-1", "1.234", "1e3", "10000000.01"])(
    "rejects invalid or excessive dollars %s",
    (value) => {
      expect(dollarsToCents(value)).toBeNull();
    },
  );
});
