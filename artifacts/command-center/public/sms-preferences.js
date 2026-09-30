const form = document.querySelector("#preferences"),
  button = document.querySelector("#submit"),
  result = document.querySelector("#result"),
  availability = document.querySelector("#availability"),
  selector = new URLSearchParams(window.location.search).get("program");
let program = null;

function approvedHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}

async function loadProgram() {
  // A missing or malformed selector never falls back to MogulForge or another
  // contractor's program. Keep the form hidden and make no enrollment request.
  if (!selector || !/^[A-Za-z0-9_-]{24,128}$/.test(selector)) {
    availability.textContent = "This enrollment link is incomplete or invalid. Request a current link from the business.";
    return;
  }
  try {
    const response = await fetch(
      `/api/v1/public/sms/program?program=${encodeURIComponent(selector)}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("Program lookup failed");
    const value = await response.json();
    if (!value || typeof value.brand !== "string" || !value.brand.trim()) {
      availability.textContent = "This enrollment link is incomplete or invalid. Request a current link from the business.";
      return;
    }
    const brand = value.brand.trim();
    document.querySelector("#business-name").textContent = brand;
    document.querySelectorAll(".business-name").forEach((name) => {
      name.textContent = brand;
    });
    document.title = `${brand} · Text preferences`;

    const senderIsValid = typeof value.sender === "string" && /^\+1[2-9]\d{9}$/.test(value.sender);
    if (senderIsValid) {
      document.querySelector("#sender-number").textContent = value.sender;
      document.querySelector("#existing-sender").hidden = false;
    }

    const privacyUrl = approvedHttpsUrl(value.privacyUrl);
    const termsUrl = approvedHttpsUrl(value.termsUrl);
    if (!value.available || !value.enabled || !privacyUrl || !termsUrl ||
        typeof value.disclosureVersion !== "string" || !value.disclosureVersion ||
        !senderIsValid) {
      availability.textContent = value.enabled
        ? `New text enrollment for ${brand} is closed until its approved privacy policy and messaging terms are configured.`
        : `New text enrollment for ${brand} is not open yet. The sender and program need approval.`;
      return;
    }

    document.querySelector("#form-sender-number").textContent = value.sender;
    document.querySelector("#privacy-link").href = privacyUrl;
    document.querySelector("#terms-link").href = termsUrl;
    program = value;
    form.hidden = false;
    button.disabled = false;
    availability.textContent = `Choose only the ${brand} text purposes you want. No promotional texts are included.`;
  } catch {
    availability.textContent = "Text enrollment is not available right now. Please request a current link from the business.";
  }
}

void loadProgram();
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!program?.available || !selector) return;
  button.disabled = true;
  result.textContent = "";
  try {
    const fields = new FormData(form);
    const response = await fetch(
      `/api/v1/public/sms/enroll?program=${encodeURIComponent(selector)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: fields.get("phone"),
          customerCare: fields.has("customerCare"),
          appointments: fields.has("appointments"),
          ownPhone: fields.has("ownPhone"),
          disclosureVersion: program.disclosureVersion,
        }),
      },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Please try again.");
    result.textContent = `From your own phone, text ${data.verificationText} to ${data.sender} within 24 hours. If you previously sent STOP, send START first. No program consent is granted until this confirmation matches your customer number.`;
  } catch (error) {
    result.textContent = error.message ?? "Preferences could not be saved.";
  } finally {
    button.disabled = false;
  }
});
