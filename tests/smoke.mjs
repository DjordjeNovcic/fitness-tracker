// Smoke test celog app-a u pravom pregledaču (Playwright + Chromium), bez
// pravog Firebase-a: tests/stubs/ glumi prijavu i Firestore u memoriji.
//
//   node tests/smoke.mjs [folder]        # podrazumevano: koren repoa
//   node tests/smoke.mjs _site           # sabijena verzija za Pages
//
// Proverava:
//  - svaki tab u svetloj i tamnoj temi, na 390px i 360px: bez JS grešaka,
//    bez vodoravnog skrola, ekran nije prazan;
//  - novi nalog: uvod u tri koraka → Danas;
//  - odjavljen korisnik: ekran za prijavu;
//  - glavne radnje: dodavanje namirnice, tajmer odmora, mapa tela.
// Izlazi sa kodom 1 ako bilo šta ne prođe, pa zaustavlja deploy.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// require (ne import) da bi radio i sa globalno instaliranim Playwright-om.
const { chromium } = createRequire(import.meta.url)("playwright");
const root = resolve(process.argv[2] || join(here, ".."));
const stubs = join(here, "stubs");
const TABS = ["plan", "recipes", "foods", "training", "running", "routine", "progress", "goals"];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = join(root, path);
    if (!file.startsWith(root)) throw new Error("outside root");
    await stat(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
const fail = (where, what) => {
  failures.push(`${where}: ${what}`);
  console.log(`  ✗ ${where}: ${what}`);
};

const browser = await chromium.launch();

async function openPage({ width = 390, theme = "light", mode = "demo" } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: theme, serviceWorkers: "block", hasTouch: true });
  await context.route(/gstatic\.com\/firebasejs\/.*\/(firebase-[a-z]+\.js)/, async (route) => {
    const name = route.request().url().match(/(firebase-[a-z]+\.js)/)[1];
    route.fulfill({ contentType: "application/javascript", body: await readFile(join(stubs, name)) });
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(
    ({ theme, mode }) => {
      try {
        if (!sessionStorage.getItem("smoke-init")) {
          sessionStorage.setItem("smoke-init", "1");
          localStorage.setItem("ft-theme", theme);
          localStorage.setItem("stub-mode", mode);
        }
      } catch {}
    },
    { theme, mode }
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, errors, close: () => context.close() };
}

async function checkTabs(width, theme, mode) {
  const label = `${mode} ${theme} ${width}px`;
  const { page, errors, close } = await openPage({ width, theme, mode });
  await page.goto(`${base}#plan`);
  await page.waitForTimeout(1500);
  if (mode === "new") {
    await finishOnboarding(page, label);
  }
  for (const tab of TABS) {
    await page.evaluate((t) => (location.hash = t), tab);
    await page.waitForTimeout(450);
    const state = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      height: document.querySelector("main")?.getBoundingClientRect().height || 0,
    }));
    if (state.overflow > 1) fail(`${label} #${tab}`, `vodoravni skrol ${state.overflow}px`);
    if (state.height < 150) fail(`${label} #${tab}`, `ekran skoro prazan (${Math.round(state.height)}px)`);
  }
  errors.forEach((message) => fail(label, `JS greška: ${message}`));
  await close();
  console.log(`  ✓ ${label}`);
}

async function finishOnboarding(page, label) {
  if (!(await page.$(".onboarding-card"))) {
    fail(label, "nema uvoda za nov nalog");
    return;
  }
  await page.click('[data-sex="male"]');
  await page.fill("#ob-age", "32");
  await page.fill("#ob-height", "180");
  await page.fill("#ob-weight", "82");
  for (let step = 0; step < 3; step += 1) {
    await page.click(".onboarding-cta");
    await page.waitForTimeout(300);
  }
  if (await page.$(".onboarding-card")) fail(label, "uvod se nije završio");
}

async function checkActions() {
  const { page, errors, close } = await openPage();
  await page.goto(`${base}#plan`);
  await page.waitForTimeout(1500);

  // Dodavanje namirnice u obrok.
  const before = await page.$$eval(".plan-meals-section .meal-entry", (rows) => rows.length);
  await page.click(".meal-card [data-action='start-add-to-meal']");
  await page.waitForTimeout(500);
  await page.fill("#food-search-input", "banana");
  await page.waitForTimeout(400);
  // Tačan naziv app izabere sam (čip), inače se bira prvi predlog.
  const suggestion = await page.$(".food-suggest-item");
  if (suggestion) {
    await suggestion.click();
    await page.waitForTimeout(300);
  }
  if (await page.$(".food-match-chip")) {
    await page.click(".meal-composer-submit");
    await page.waitForTimeout(500);
    const after = await page.$$eval(".plan-meals-section .meal-entry", (rows) => rows.length);
    if (after !== before + 1) fail("Danas", `dodavanje namirnice: ${before} → ${after}`);
  } else {
    fail("Danas", "pretraga „banana“ ne nalazi namirnicu");
  }

  // Trening: tajmer odmora i mapa tela.
  await page.evaluate(() => (location.hash = "training"));
  await page.waitForTimeout(600);
  await page.click(".training-exercise-row .training-rest:not(.training-swap)");
  await page.waitForTimeout(400);
  if (!(await page.$(".training-rest.is-running"))) fail("Trening", "tajmer odmora ne kreće");
  if (!(await page.$(".training-week-map"))) {
    await page.click("[data-action='toggle-training-map']");
    await page.waitForTimeout(1200);
  }
  await page.click("button.training-week-volume-name");
  await page.waitForTimeout(400);
  if (!(await page.$(".muscle-sheet-dialog"))) fail("Trening", "tap na mišić ne otvara vežbe");

  errors.forEach((message) => fail("radnje", `JS greška: ${message}`));
  await close();
  console.log("  ✓ radnje (namirnica, tajmer, mapa tela)");
}

async function checkSignedOut() {
  const { page, errors, close } = await openPage({ mode: "out" });
  await page.goto(base);
  await page.waitForTimeout(1200);
  if (!(await page.$("#auth-form"))) fail("prijava", "nema forme za prijavu");
  errors.forEach((message) => fail("prijava", `JS greška: ${message}`));
  await close();
  console.log("  ✓ prijava");
}

console.log(`Smoke test: ${root}`);
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 360]) {
      await checkTabs(width, theme, "demo");
    }
  }
  await checkTabs(390, "light", "new");
  await checkSignedOut();
  await checkActions();
} catch (error) {
  fail("test", error.message);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} problem(a). Deploy se zaustavlja.`);
  process.exit(1);
}
console.log("\nSve prošlo.");
