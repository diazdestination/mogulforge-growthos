import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BieEmailReviewSummary, preparedBieEmail } from "./bie-email-review";
const prepared = () => ({
  subject: "Synthetic subject",
  body: "<script>send secrets</script>",
  emailReview: {
    version: 1,
    preparedByUserId: "staff-one",
    preparedAt: "2026-10-02T12:00:00Z",
    recipient: "customer@example.invalid",
    sender: { provider: "microsoft", senderEmail: "staff@example.invalid" },
    leadId: "lead-one",
    contactId: "contact-one",
    leadCreatedAt: "2026-10-01T12:00:00Z",
    leadUpdatedAt: "2026-10-01T12:00:00Z",
  },
});
afterEach(cleanup);
it("shows frozen recipient, mailbox and provider, escaped message and untracked boundary", () => {
  const { container } = render(
    <BieEmailReviewSummary
      payload={prepared()}
      status="proposed"
      showContent
    />,
  );
  expect(screen.getByText(/customer@example.invalid/)).toBeTruthy();
  expect(screen.getByText(/staff@example.invalid/)).toBeTruthy();
  expect(screen.getByText(/Untracked email/)).toBeTruthy();
  expect(screen.getByText("<script>send secrets</script>")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
});
it("shows tracked lead permission only for a matching complete prepared identity", () => {
  const payload = {
    ...prepared(),
    deliverySnapshot: {
      version: 1,
      kind: "bie_lead_email",
      recipient: "customer@example.invalid",
      mailboxIdentity: {
        provider: "microsoft",
        mailboxEmail: "staff@example.invalid",
      },
      leadMonitoringApproval: {
        version: 3,
        approvedAt: "2026-10-02T11:00:00Z",
      },
    },
  };
  render(<BieEmailReviewSummary payload={payload} status="proposed" />);
  expect(screen.getByText(/approval version 3/)).toBeTruthy();
  expect(
    preparedBieEmail({
      ...payload,
      deliverySnapshot: {
        ...payload.deliverySnapshot,
        recipient: "changed@example.invalid",
      },
    }),
  ).toBeNull();
  expect(
    preparedBieEmail({
      ...payload,
      deliverySnapshot: {
        ...payload.deliverySnapshot,
        leadMonitoringApproval: null,
      },
    }),
  ).toBeNull();
});
it("does not adopt historical approved messages or malformed reviews as tracked", () => {
  render(
    <BieEmailReviewSummary
      payload={{ subject: "Old draft", body: "Old approved email" }}
      status="approved"
    />,
  );
  expect(screen.getByText(/Legacy or unavailable email review/)).toBeTruthy();
  expect(
    preparedBieEmail({
      ...prepared(),
      emailReview: { recipient: "customer@example.invalid" },
    }),
  ).toBeNull();
});
