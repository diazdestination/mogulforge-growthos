/** Public, non-sensitive return page. Stripe webhooks confirm the actual receipt. */
export function PaymentReturn({ canceled }: { canceled: boolean }) {
  return <main className="min-h-screen grid place-items-center p-6 bg-background text-foreground">
    <div className="max-w-md space-y-4 rounded-xl border p-6">
      <h1 className="text-xl font-semibold">{canceled ? 'Checkout closed' : 'Payment submitted'}</h1>
      <p>{canceled ? 'You returned from checkout. If you submitted a bank payment, it may still be clearing.' : 'Your contractor will receive confirmation from Stripe. Bank payments can take time to clear.'}</p>
      <p>Contact your contractor to confirm the invoice balance before making another payment.</p>
    </div>
  </main>;
}
