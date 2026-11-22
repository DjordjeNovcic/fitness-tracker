// Telegram podsetnik za obroke (pokreće ga .github/workflows/telegram-reminders.yml
// svakih 10 minuta). Čita plan iz Firestore-a (users/{uid}/app/state, isti doc
// koji aplikacija sinhronizuje), i kad dođe vreme obroka iz „Satnica obroka“
// pošalje poruku sa stavkama tog obroka za današnji dan.
//
// Šta je već poslato pamti se u zasebnom doc-u (users/{uid}/app/telegram), da
// se ne dira doc aplikacije (njen „rev“ bi napravio konflikt sinhronizacije).
// Zato i kašnjenje GitHub cron-a (ume da kasni 5–20 min) ne pravi duplikate:
// šalje se svaki obrok čije je vreme prošlo u poslednjih 90 min, a još nije
// poslat danas.
//
// Tajne (GitHub → Settings → Secrets and variables → Actions):
//   TELEGRAM_BOT_TOKEN        token od @BotFather
//   TELEGRAM_CHAT_ID          tvoj chat id (vidi docs/telegram-bot.md)
//   FIREBASE_SERVICE_ACCOUNT  ceo JSON ključ servisnog naloga (Firebase konzola)
//   FIREBASE_UID              tvoj uid (Firebase → Authentication → Users)
// Bez tajni skripta samo napiše šta fali i izađe bez greške, da cron ne
// zatrpava mejl neuspešnim pokretanjima pre podešavanja.

const WEEKDAYS = ["Ponedeljak", "Utorak", "Sreda", "Cetvrtak", "Petak", "Subota", "Nedelja"];
const WEEK_TRACK_EPOCH_MONDAY_UTC = Date.UTC(2024, 0, 1);
const DAY_MS = 86400000;
const TIME_ZONE = "Europe/Belgrade";
const SEND_WINDOW_MIN = 90;

const env = process.env;
const token = env.TELEGRAM_BOT_TOKEN || "";
const chatId = env.TELEGRAM_CHAT_ID || "";
const testMode = env.REMINDER_TEST === "true";

function log(...args) {
  console.log("[telegram]", ...args);
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description || response.status}`);
  }
  return data.result;
}

// Bez TELEGRAM_CHAT_ID: pošalji botu bilo šta u Telegramu, pa pokreni ovaj
// workflow ručno — u logu piše tvoj chat id.
async function printChatIds() {
  const updates = await telegram("getUpdates", {});
  const chats = new Map();
  updates.forEach((update) => {
    const chat = update.message?.chat || update.my_chat_member?.chat;
    if (chat) {
      chats.set(chat.id, chat.first_name || chat.title || chat.username || "");
    }
  });
  if (!chats.size) {
    log("Nema poruka botu. Pošalji mu /start u Telegramu pa pokreni ponovo.");
    return;
  }
  chats.forEach((name, id) => log(`chat id: ${id} (${name}) → upiši ga kao TELEGRAM_CHAT_ID`));
}

function belgradeNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  const weekdayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[weekdayIndex],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    // Ista računica kao getCurrentWeekTrack() u app.js, ali po beogradskom datumu.
    weekTrack: (() => {
      const mondayUtc = Date.UTC(year, month - 1, day - weekdayIndex);
      const weeks = Math.floor(Math.round((mondayUtc - WEEK_TRACK_EPOCH_MONDAY_UTC) / DAY_MS) / 7);
      return ((weeks % 2) + 2) % 2;
    })(),
  };
}

const normalizeWeekTrack = (value) => (Number(value) === 1 ? 1 : 0);
const normalizeMealLabel = (label) => String(label || "").trim();
const mealTitle = (label) => normalizeMealLabel(label).replace(/^\d+\.\s*/, "");
const escapeHtml = (text) => String(text ?? "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
const round = (value, digits = 0) => Math.round(Number(value || 0) * 10 ** digits) / 10 ** digits;
const toMinutes = (time) => {
  const match = String(time || "").match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

function entryTotals(food, grams) {
  if (!food) {
    return { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  }
  const base = Number(food.servingBaseGrams) || (food.servingUnit === "piece" ? 1 : 100);
  const ratio = Number(grams || 0) / base;
  return {
    kcal: Number(food.kcal || 0) * ratio,
    protein: Number(food.protein || 0) * ratio,
    carbs: Number(food.carbs || 0) * ratio,
    fat: Number(food.fat || 0) * ratio,
  };
}

function formatAmount(food, grams) {
  if (food?.servingUnit === "piece") {
    return `${round(grams, 1)} kom`;
  }
  return `${round(grams, 0)} g`;
}

function buildMealMessage(appState, mealLabel, time, entries, now) {
  const foods = appState.foods || [];
  const lines = [];
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const groups = new Map();
  entries.forEach((entry) => {
    const food = foods.find((item) => item.id === entry.foodId);
    const part = entryTotals(food, entry.grams);
    Object.keys(totals).forEach((key) => (totals[key] += part[key]));
    if (entry.recipeGroupId) {
      const group = groups.get(entry.recipeGroupId) || { name: entry.recipeName || "Recept", grams: Number(entry.recipeGrams) || 0, kcal: 0, sum: 0 };
      group.kcal += part.kcal;
      group.sum += food?.servingUnit === "piece" ? 0 : Number(entry.grams || 0);
      if (!groups.has(entry.recipeGroupId)) {
        groups.set(entry.recipeGroupId, group);
        lines.push(group);
      }
      return;
    }
    const swap = food?.swap && food.swap.grams > 0 && food.servingUnit !== "piece" ? Math.round((Number(entry.grams) / food.swap.grams) * 2) / 2 : 0;
    lines.push({
      text: `• ${escapeHtml(entry.foodName)} — ${formatAmount(food, entry.grams)}${swap >= 0.5 ? ` (ili ${swap} ${escapeHtml(food.swap.name)})` : ""} · ${round(part.kcal)} kcal`,
    });
  });
  const body = lines
    .map((line) => line.text || `• ${escapeHtml(line.name)} — ${round(line.grams || line.sum)} g · ${round(line.kcal)} kcal`)
    .join("\n");
  const note = (appState.mealNotes || {})[`${now.weekTrack}|${now.weekday}|${mealLabel}`];
  return [
    `🍽 <b>${escapeHtml(mealTitle(mealLabel))}</b> · ${time}`,
    body,
    `<b>≈ ${round(totals.kcal)} kcal</b> · P ${round(totals.protein)} · UH ${round(totals.carbs)} · M ${round(totals.fat)} g`,
    note ? `📝 ${escapeHtml(note)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  if (!token) {
    log("TELEGRAM_BOT_TOKEN nije podešen — preskačem.");
    return;
  }
  if (!chatId) {
    await printChatIds();
    return;
  }
  if (testMode && !env.FIREBASE_SERVICE_ACCOUNT) {
    await telegram("sendMessage", { chat_id: chatId, text: "✅ Fit Tracker bot radi. Još fali FIREBASE_SERVICE_ACCOUNT i FIREBASE_UID za obroke." });
    log("Test poruka poslata.");
    return;
  }
  if (!env.FIREBASE_SERVICE_ACCOUNT || !env.FIREBASE_UID) {
    log("FIREBASE_SERVICE_ACCOUNT ili FIREBASE_UID nije podešen — preskačem.");
    return;
  }

  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
  initializeApp({ credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();
  const uid = env.FIREBASE_UID.trim();

  const stateDoc = await db.doc(`users/${uid}/app/state`).get();
  const appState = stateDoc.exists ? stateDoc.data()?.state : null;
  if (!appState) {
    log("Nema stanja aplikacije za ovaj uid.");
    return;
  }

  const now = belgradeNow();
  const schedule = appState.mealSchedule || {};
  const times = schedule.times || {};
  const dayEntries = (appState.weeklyPlanEntries || []).filter(
    (entry) => entry.weekday === now.weekday && normalizeWeekTrack(entry.weekTrack) === now.weekTrack
  );

  if (testMode) {
    const next = Object.entries(times).sort((a, b) => toMinutes(a[1]) - toMinutes(b[1]))[0];
    const label = next ? normalizeMealLabel(next[0]) : "";
    const entries = dayEntries.filter((entry) => normalizeMealLabel(entry.mealLabel) === label);
    const text = label && entries.length
      ? `✅ Bot radi. Ovako izgleda podsetnik:\n\n${buildMealMessage(appState, label, next[1], entries, now)}`
      : "✅ Fit Tracker bot radi i vidi tvoj nalog. Upiši satnicu obroka u Ciljevi → Satnica obroka.";
    await telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
    log("Test poruka poslata.");
    return;
  }

  if (schedule.remindersOn === false) {
    log("Podsetnici su isključeni u aplikaciji.");
    return;
  }

  const sentRef = db.doc(`users/${uid}/app/telegram`);
  const sentDoc = await sentRef.get();
  const sent = (sentDoc.exists && sentDoc.data()?.sent) || {};
  const newlySent = {};

  for (const [rawLabel, time] of Object.entries(times)) {
    const label = normalizeMealLabel(rawLabel);
    const due = toMinutes(time);
    const key = `${now.dateKey}|${label}`;
    if (due === null || sent[key] || now.minutes < due || now.minutes - due > SEND_WINDOW_MIN) {
      continue;
    }
    const entries = dayEntries.filter((entry) => normalizeMealLabel(entry.mealLabel) === label);
    // Prazan ili već pojeden obrok: nema šta da se podseća.
    if (!entries.length || entries.every((entry) => entry.done)) {
      newlySent[key] = "skipped";
      continue;
    }
    await telegram("sendMessage", { chat_id: chatId, text: buildMealMessage(appState, label, time, entries, now), parse_mode: "HTML" });
    newlySent[key] = new Date().toISOString();
    log(`Poslato: ${label} (${time})`);
  }

  if (Object.keys(newlySent).length) {
    // Čuvaju se samo poslednja 3 dana.
    const cutoff = new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10);
    const kept = Object.fromEntries(Object.entries({ ...sent, ...newlySent }).filter(([key]) => key.slice(0, 10) >= cutoff));
    await sentRef.set({ sent: kept, updatedAt: FieldValue.serverTimestamp() });
  } else {
    log(`Ništa za slanje (${now.weekday} ${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")}).`);
  }
}

main().catch((error) => {
  console.error("[telegram]", error.message);
  process.exit(1);
});
