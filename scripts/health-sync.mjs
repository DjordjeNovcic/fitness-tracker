// Podaci sa Apple Watch-a (Apple Health) → Fit Tracker, bez otvaranja app-a.
//
// iPhone Prečica (Shortcuts) svako veče pročita Health i pošalje POST na
// GitHub API (repository_dispatch, event_type "health"). To pokrene
// .github/workflows/health-sync.yml, koji pokrene ovu skriptu sa podacima u
// HEALTH_PAYLOAD. Skripta ih upiše u zaseban doc users/{uid}/app/health
// (po datumu), a aplikacija ih pri otvaranju / povratku / na 5 min primeni
// istim applyActivityImport kao uvoz iz Prečice. Doc aplikacije (state) se
// ne dira, pa slanje na pola sata ne pravi konflikt sinhronizacije.
// Telegram: jednom dnevno uveče (prvo slanje posle 21h) i na ručnu probu.
// Uputstvo: docs/apple-watch.md.
//
// Polja (sva opciona, brojevi smeju sa zarezom i jedinicom, kao iz Prečice):
//   move  aktivne kcal (Move)     steps  koraci        sleep  sati sna
//   weight  kg                    ex     min vežbanja   stand  sati stajanja
//   dist  km hodanja/trčanja      date   YYYY-MM-DD (podrazumevano danas)

const WEEKDAYS = ["Ponedeljak", "Utorak", "Sreda", "Cetvrtak", "Petak", "Subota", "Nedelja"];
const TIME_ZONE = "Europe/Belgrade";

const env = process.env;
const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
const chatId = String(env.TELEGRAM_CHAT_ID || "").trim();

function log(...args) {
  console.log("[health]", ...args);
}

// „8.432“ i „1.234.567“ su hiljade, sve ostalo posle poslednjeg separatora je
// decimalni deo. Zbir iz Prečice stiže neokrugljen („97,860526442568“,
// „26442,568“ sekundi sna), pa se hiljade prepoznaju samo po grupama od 3.
function parseNumber(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.,\-]/g, "");
  if (!cleaned) {
    return 0;
  }
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(cleaned)) {
    return Number(cleaned.replace(/[.,]/g, "")) || 0;
  }
  const lastSep = Math.max(cleaned.lastIndexOf(","), cleaned.lastIndexOf("."));
  if (lastSep === -1) {
    return Number(cleaned) || 0;
  }
  const intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, "");
  return Number(`${intPart}.${cleaned.slice(lastSep + 1)}`) || 0;
}

const round = (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;

function belgradeToday() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : "";
}

function weekdayOf(dateValue) {
  const [y, m, d] = dateValue.split("-").map(Number);
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}

function buildRecord(fields) {
  const pick = (...keys) => keys.map((key) => fields[key]).find((value) => value !== undefined && value !== null && value !== "");
  const moveKcal = Math.round(parseNumber(pick("move", "kcal", "active", "aktivne")));
  const exerciseMin = Math.round(parseNumber(pick("ex", "exercise", "vezbanje")));
  const standHours = Math.round(parseNumber(pick("stand", "stajanje")));
  const steps = Math.round(parseNumber(pick("steps", "koraci")));
  const distanceKm = round(parseNumber(pick("dist", "distance", "km")), 2);
  const weightKg = round(parseNumber(pick("weight", "tezina", "kg")), 1);
  // Prečica ume da pošalje trajanje sna u minutima ili sekundama, ne u satima.
  const sleepRaw = parseNumber(pick("sleep", "san"));
  const sleepHours = round(sleepRaw > 960 ? sleepRaw / 3600 : sleepRaw > 16 ? sleepRaw / 60 : sleepRaw, 1);
  const date = normalizeDate(pick("date", "datum")) || belgradeToday();
  const record = {
    date,
    moveKcal: moveKcal > 0 ? moveKcal : null,
    exerciseMin: exerciseMin > 0 ? exerciseMin : null,
    standHours: standHours > 0 ? standHours : null,
    steps: steps > 0 ? steps : null,
    distanceKm: distanceKm > 0 ? distanceKm : null,
    workouts: [],
    weightKg: weightKg >= 25 && weightKg <= 350 ? weightKg : null,
    sleepHours: sleepHours > 0 && sleepHours <= 16 ? sleepHours : null,
  };
  const hasAny = ["moveKcal", "exerciseMin", "standHours", "steps", "distanceKm", "weightKg", "sleepHours"].some((key) => record[key] != null);
  return hasAny ? record : null;
}

function describe(record) {
  const parts = [];
  if (record.steps != null) parts.push(`${record.steps.toLocaleString("de-DE")} koraka`);
  if (record.moveKcal != null) parts.push(`${record.moveKcal} kcal aktivnosti`);
  if (record.exerciseMin != null) parts.push(`${record.exerciseMin} min vežbanja`);
  if (record.sleepHours != null) parts.push(`${String(record.sleepHours).replace(".", ",")} h sna`);
  if (record.weightKg != null) parts.push(`${String(record.weightKg).replace(".", ",")} kg`);
  return parts.join(", ");
}

async function notify(text) {
  if (!token || !chatId) {
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (error) {
    log("Telegram poruka nije poslata:", error.message);
  }
}

async function main() {
  let fields = {};
  try {
    fields = JSON.parse(env.HEALTH_PAYLOAD || "{}") || {};
  } catch (error) {
    log("HEALTH_PAYLOAD nije ispravan JSON.");
    process.exitCode = 1;
    return;
  }
  // Ključevi malim slovima, kao u uvozu iz aplikacije.
  fields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [String(key).trim().toLowerCase(), value]));
  const record = buildRecord(fields);
  if (!record) {
    // Nule su normalne (posle ponoći, ujutru pre hodanja): tada se samo ćuti.
    // Upozorenje ide samo kad nijedno poznato polje nije ni stiglo, jer je to
    // greška u Prečici.
    const known = ["move", "kcal", "active", "steps", "koraci", "sleep", "san", "weight", "tezina", "ex", "stand", "dist"];
    const anyKnown = Object.keys(fields).some((key) => known.includes(key));
    log(anyKnown ? "Stigle su samo nule — ništa za upis." : "Nijedno poznato polje. Ključevi:", Object.keys(fields).join(", ") || "(prazno)");
    if (!anyKnown) {
      await notify("⌚ Prečica je stigla, ali bez polja steps/move/sleep/weight. Proveri client_payload u „Get Contents of URL“.");
    }
    return;
  }
  if (!String(env.FIREBASE_SERVICE_ACCOUNT || "").trim() || !String(env.FIREBASE_UID || "").trim()) {
    log("FIREBASE_SERVICE_ACCOUNT ili FIREBASE_UID nije podešen.");
    process.exitCode = 1;
    return;
  }

  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
  initializeApp({ credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();
  const ref = db.doc(`users/${env.FIREBASE_UID.trim()}/app/health`);
  const receivedAt = new Date().toISOString();
  const testRun = env.HEALTH_TEST === "true";

  let shouldNotify = testRun;
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const data = snapshot.exists ? snapshot.data() || {} : {};
    const days = data.days && typeof data.days === "object" ? data.days : {};
    days[record.date] = { ...record, receivedAt };
    // Čuva se poslednjih 14 dana; aplikacija primeni sve što još nije videla.
    Object.keys(days)
      .sort()
      .slice(0, -14)
      .forEach((date) => delete days[date]);
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    const today = belgradeToday();
    if (!testRun && hour >= 21 && data.notifiedDate !== today) {
      shouldNotify = true;
    }
    tx.set(ref, {
      days,
      updatedAt: FieldValue.serverTimestamp(),
      notifiedDate: shouldNotify && !testRun ? today : data.notifiedDate || null,
    });
  });

  const summary = describe(record);
  log(`Upisano za ${record.date}: ${summary}`);
  if (shouldNotify) {
    await notify(`⌚ Sat → Fit Tracker (${record.date.split("-").reverse().slice(0, 2).join(".")}.): ${summary}`);
  }
}

main().catch((error) => {
  console.error("[health]", error.message);
  process.exitCode = 1;
});
