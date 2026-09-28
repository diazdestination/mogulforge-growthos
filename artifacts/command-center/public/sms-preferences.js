let program;
const form = document.querySelector("#preferences"),
  button = document.querySelector("#submit"),
  result = document.querySelector("#result");
fetch("/api/v1/public/sms/program")
  .then((response) => {
    if (!response.ok) throw new Error();
    return response.json();
  })
  .then((value) => {
    program = value;
    button.disabled = !value.available;
    document.querySelector("#availability").textContent = value.available
      ? "Confirm only the text purposes you want. No promotional texts are included."
      : "Text enrollment is not open yet. The program is awaiting sender, business and consent review.";
  })
  .catch(() => {
    document.querySelector("#availability").textContent =
      "Text enrollment is not available right now.";
  });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!program?.available) return;
  button.disabled = true;
  result.textContent = "";
  try {
    const fields = new FormData(form);
    const response = await fetch("/api/v1/public/sms/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: fields.get("phone"),
        customerCare: fields.has("customerCare"),
        appointments: fields.has("appointments"),
        ownPhone: fields.has("ownPhone"),
        disclosureVersion: program.disclosureVersion,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Please try again.");
    result.textContent = `From your own phone, text ${data.verificationText} to ${data.sender} within 24 hours. If you previously sent STOP, send START first. No program consent is granted until this confirmation matches your customer number.`;
  } catch (error) {
    result.textContent = error.message ?? "Preferences could not be saved.";
  } finally {
    button.disabled = false;
  }
});
