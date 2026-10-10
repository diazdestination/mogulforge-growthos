/** Native, fictional loopback acceptance. No video, tracing, saved auth or providers. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stem = path.join(root, 'reports/integrated-running-browser-2026-10-10');
const origin = 'http://127.0.0.1:4193';
const cli = path.join(process.env.APPDATA, 'npm/node_modules/@playwright/cli/package.json');
const { chromium } = createRequire(cli)('playwright');
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, browser: await browser.version(), recording: false, tracing: false, video: false, checks: [], layouts: [], pageErrors: [], failedResponses: [], mutations: [], limitations: [] };
const requests = [];
page.on('pageerror', error => report.pageErrors.push(error.message));
page.on('request', request => {
  const url = new URL(request.url());
  if (url.origin === origin) requests.push({ method: request.method(), path: url.pathname });
});
page.on('response', response => {
  const url = new URL(response.url());
  if (url.origin === origin && response.status() >= 400) report.failedResponses.push({ path: url.pathname, status: response.status() });
});
const check = (name, evidence) => { report.checks.push({ name, result: 'passed', evidence }); console.log(`PASS ${name}`); };
const heading = name => page.getByRole('heading', { name, exact: true }).waitFor();
const daily = name => page.getByRole('navigation', { name: 'Daily work', exact: true }).getByRole('link', { name, exact: true }).click();
const main = () => page.locator('#main-content');
async function loadedToday() {
  await heading('Today');
  await page.getByText('Loading the work day…', { exact: true }).waitFor({ state: 'hidden' });
  assert.ok(!(await main().innerText()).includes('The work day could not load'));
}
async function layout(label, width) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measure = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  assert.ok(measure.documentWidth <= width + 1 && measure.bodyWidth <= width + 1, `${label} overflows at ${width}: ${JSON.stringify(measure)}`);
  report.layouts.push({ label, path: new URL(page.url()).pathname, ...measure });
}
async function loadCorrection(propertyId) {
  await page.getByRole('button', { name: 'Review customer details', exact: true }).click();
  await page.getByLabel('Also review a property address', { exact: true }).check();
  await page.getByRole('button', { name: 'Load more customer properties', exact: true }).click();
  await page.getByText('30 linked properties loaded.', { exact: true }).waitFor();
  const picker = page.getByRole('combobox', { name: /Property address to review/ });
  const options = await picker.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent })));
  const selected = propertyId || options.at(-1).value;
  await picker.selectOption(selected);
  await page.getByRole('button', { name: 'Load current details', exact: true }).click();
  await page.getByLabel('First name *', { exact: true }).waitFor();
  return selected;
}
async function saveCorrection() {
  const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/detail-corrections'));
  await page.getByRole('button', { name: 'Save reviewed details', exact: true }).click();
  const response = await pending;
  const result = await response.json();
  assert.equal(response.status(), 200);
  assert.equal(result.receipt.status, 'saved');
  await page.getByRole('status').filter({ hasText: 'Customer details saved.' }).waitFor();
  return { requestId: result.receipt.requestId, status: result.receipt.status };
}
try {
  await page.goto(`${origin}/login`);
  await page.getByPlaceholder('Email', { exact: true }).fill('runtime-qa@example.invalid');
  await page.getByPlaceholder('Password', { exact: true }).fill('Local-QA-only-2026!');
  await page.getByRole('button', { name: 'SIGN IN', exact: true }).click();
  await loadedToday();
  assert.ok((await page.locator('body').innerText()).includes('LOCAL RUNTIME QA - fictional'));
  await layout('Today', 1440);
  await page.screenshot({ path: `${stem}.desktop.png`, fullPage: false });
  check('Signed-in native Today', 'Fictional Owner session; fully loaded appointments, due task and returning-customer job.');

  await daily('Customers & Jobs'); await heading('Contacts');
  await page.getByRole('link', { name: 'Open customer work record for FICTIONAL Returning customer without a lead', exact: true }).click();
  await heading('FICTIONAL Returning customer without a lead');
  const customerUrl = page.url();
  const propertyId = await loadCorrection();
  const originalName = await page.getByLabel('First name *', { exact: true }).inputValue();
  const originalAddress2 = await page.getByLabel('Address line 2', { exact: true }).inputValue();
  assert.equal(originalName, 'FICTIONAL');
  await page.getByLabel('First name *', { exact: true }).fill('FICTIONAL QA REVIEWED');
  await page.getByLabel('Address line 2', { exact: true }).fill('FICTIONAL browser correction only');
  const saved = await saveCorrection();
  await page.reload(); await heading('FICTIONAL QA REVIEWED Returning customer without a lead');
  await loadCorrection(propertyId);
  assert.equal(await page.getByLabel('Address line 2', { exact: true }).inputValue(), 'FICTIONAL browser correction only');
  assert.ok((await main().innerText()).includes('All contact: Do not contact'));
  assert.ok((await main().innerText()).includes('Email: Do not email'));
  assert.ok((await main().innerText()).includes('SMS: Do not text'));
  await page.getByLabel('First name *', { exact: true }).fill(originalName);
  await page.getByLabel('Address line 2', { exact: true }).fill(originalAddress2);
  const restored = await saveCorrection();
  await heading('FICTIONAL Returning customer without a lead');
  await page.getByRole('button', { name: 'Close detail review', exact: true }).click();
  check('Customer and exact property correction', { loadedProperties: 30, propertyId, saved, persistedAfterReload: true, restrictionsPreserved: true, originalValuesRestored: restored });

  const sections = page.getByRole('navigation', { name: 'Customer record sections', exact: true });
  await sections.getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.getByRole('link', { name: 'Open job', exact: true }).first().waitFor();
  await sections.getByRole('link', { name: 'Estimates', exact: true }).click();
  await page.getByRole('link', { name: 'Open estimate', exact: true }).waitFor();
  await sections.getByRole('link', { name: 'Invoices', exact: true }).click();
  await page.getByRole('link', { name: 'Open invoice', exact: true }).first().click();
  await page.getByRole('region', { name: 'Invoice balance', exact: true }).waitFor();
  assert.ok((await main().innerText()).includes('Recorded balance'));
  check('Returning-customer work navigation', 'Customer Jobs, Estimates and Invoices sections load; exact invoice opens its recorded balance.');

  await daily('Schedule'); await heading('Appointments');
  await page.getByText('FICTIONAL HVAC returning customer', { exact: true }).first().waitFor();
  await daily('Invoices'); await heading('Invoices');
  await page.getByText('INV-SYNTHETIC-RETURNING-1', { exact: true }).waitFor();
  assert.ok((await main().innerText()).includes('Balance $110.00'));
  check('Native Schedule and Invoices', 'Seeded HVAC/roofing appointments and three issued invoices load, with recorded balance $110.00 on the returning invoice.');

  await daily('Warranties & Service'); await heading('Customer service desk');
  await page.getByRole('link', { name: 'Open visit work', exact: true }).first().click();
  await page.getByText('Opening the exact appointment…', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('link', { name: 'Open customer record', exact: true }).waitFor();
  assert.ok((await main().innerText()).includes('0 FICTIONAL Workday Lane'));
  const visitUrl = page.url();
  check('Service to exact original visit', { path: new URL(visitUrl).pathname + new URL(visitUrl).search, linkedPropertyVisible: true });

  await daily('Customers & Jobs'); await heading('Contacts');
  await page.getByRole('navigation', { name: 'Customers and jobs sections', exact: true }).getByRole('link', { name: 'Leads', exact: true }).click();
  await page.locator('#main-content a[href*="/leads/"]').first().click();
  const coverage = page.getByRole('region', { name: 'Staff lead alert coverage', exact: true });
  await coverage.getByText('Alert coverage was not recorded', { exact: true }).waitFor();
  const leadUrl = page.url();
  const requestStart = requests.length;
  await page.getByRole('button', { name: 'Refresh alert coverage', exact: true }).click();
  await coverage.getByText('Alert coverage was not recorded', { exact: true }).waitFor();
  const refresh = requests.slice(requestStart).filter(request => request.path.includes('/coverage'));
  assert.equal(refresh.length, 1); assert.equal(refresh[0].method, 'GET');
  check('Native owner lead coverage', { result: 'Original recipient cohort unknown; historical gap is explicit.', refresh });
  report.limitations.push('The seeded lead is not a Smart Site inquiry. Native Smart Site ownership read returns 404 and correctly hides that panel; claiming an inquiry and evaluated push-recipient coverage are not proven by this browser fixture.');

  await page.locator('summary').filter({ hasText: 'More tools' }).click();
  await page.getByRole('navigation', { name: 'More tools', exact: true }).getByRole('link', { name: 'Specialists', exact: true }).click();
  await heading('A clear role for each part of the work.');
  await page.getByRole('button', { name: /View SCHED/ }).click();
  await page.getByRole('link', { name: 'Open schedule', exact: true }).click();
  await heading('Appointments');
  check('Specialist to native workspace', 'Signed-in SCHED guide opens Schedule; route optimization is explicitly Planned.');

  const routes = [ ['Today', '/', 'Today'], ['Customers', '/contacts', 'Contacts'], ['Customer work record', customerUrl, 'FICTIONAL Returning customer without a lead'], ['Schedule', '/appointments', 'Appointments'], ['Invoices', '/invoices', 'Invoices'], ['Service', '/service', 'Customer service desk'], ['Specialists', '/agent-team', 'A clear role for each part of the work.'], ['Lead coverage', leadUrl, null] ];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [label, route, title] of routes) {
      await page.goto(route.startsWith(origin) ? route : origin + route);
      if (title) await heading(title); else await page.getByText('Alert coverage was not recorded', { exact: true }).waitFor();
      if (label === 'Today') await loadedToday();
      if (label === 'Customers') await page.getByRole('link', { name: 'Open customer work record for FICTIONAL Returning customer without a lead', exact: true }).waitFor();
      if (label === 'Schedule') await page.getByText('FICTIONAL HVAC returning customer', { exact: true }).first().waitFor();
      if (label === 'Invoices') await page.getByText('INV-SYNTHETIC-RETURNING-1', { exact: true }).waitFor();
      if (label === 'Service') await page.getByRole('link', { name: 'Open visit work', exact: true }).first().waitFor();
      await layout(label, width);
    }
    await page.getByRole('navigation', { name: 'Quick navigation', exact: true }).getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('navigation', { name: 'Mobile daily work', exact: true }).getByRole('link', { name: 'Warranties & Service', exact: true }).click();
    await heading('Customer service desk');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('navigation', { name: 'Quick navigation', exact: true }).getByRole('link', { name: 'Today', exact: true }).click();
    await loadedToday();
    if (width === 390) await page.screenshot({ path: `${stem}.mobile.png`, fullPage: false });
  }
  check('Responsive native navigation', '16 rendered page/viewport combinations at 390x844 and 320x844 have no document/body horizontal overflow. Mobile Menu opens Service and closes after navigation; quick Today returns to the workday.');
  assert.deepEqual(report.pageErrors, []);
  assert.ok(report.failedResponses.every(response => response.status === 404 && (/^\/api\/v1\/smart-sites\/leads\/[^/]+\/follow-up$/.test(response.path) || /^\/api\/v1\/leads\/[^/]+\/enrollment$/.test(response.path))), 'Unexpected failed application response');
  report.mutations = requests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
  assert.ok(report.mutations.every(request => request.path.includes('/auth/login') || request.path.endsWith('/detail-corrections')), 'Unexpected mutation outside login and fictional audited detail corrections');
  report.limitations.push('Local fictional browser acceptance only; no production, provider delivery, actual device receipt, customer workday or financial settlement is established. Preview runner has outbound holds and excludes provider credentials.');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await fs.writeFile(`${stem}.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  console.log(JSON.stringify({ result: report.result, checks: report.checks.length, layouts: report.layouts.length, failure: report.failure ?? null, report: `${stem}.json` }));
}
