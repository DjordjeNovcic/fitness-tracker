import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const STORAGE_KEY = "fitness-tracker-state-v1";
const CLOUD_SCHEMA_VERSION = 1;
const DEMO_RECIPE_SEED_VERSION = 1;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBvfd2HVPJlfA1XvXaEKf8_FpvQZcESPzg",
  authDomain: "fitness-tracker-c90f7.firebaseapp.com",
  projectId: "fitness-tracker-c90f7",
  storageBucket: "fitness-tracker-c90f7.firebasestorage.app",
  messagingSenderId: "573104342048",
  appId: "1:573104342048:web:626332b425b77051756845",
};
const WEEKDAYS = ["Ponedeljak", "Utorak", "Sreda", "Cetvrtak", "Petak", "Subota", "Nedelja"];
const TABS = [
  { id: "plan", label: "Plan", icon: "🍽" },
  { id: "recipes", label: "Recepti", icon: "🥣" },
  { id: "nutrition", label: "Nutricionista", icon: "🗂" },
  { id: "foods", label: "Namirnice", icon: "🥚" },
  { id: "training", label: "Trening", icon: "🏋️" },
  { id: "routine", label: "Rutina", icon: "✅" },
  { id: "progress", label: "Napredak", icon: "📏" },
  { id: "goals", label: "Ciljevi", icon: "🎯" },
  { id: "settings", label: "Podešavanja", icon: "⚙️" },
];

const ACTIVITY_LEVELS = [
  { id: "sedentary", label: "Sedeći posao", multiplier: 1.2 },
  { id: "light", label: "Lagana aktivnost", multiplier: 1.375 },
  { id: "moderate", label: "Umerena aktivnost", multiplier: 1.55 },
  { id: "active", label: "Aktivan trening", multiplier: 1.725 },
  { id: "very-active", label: "Vrlo aktivan", multiplier: 1.9 },
];

const GOAL_MODES = [
  { id: "lose", label: "Smršaj", calorieFactor: 0.85, proteinFactor: 2.2, fatFactor: 0.8 },
  { id: "maintain", label: "Održavanje", calorieFactor: 1, proteinFactor: 2, fatFactor: 0.9 },
  { id: "gain", label: "Ugoji se", calorieFactor: 1.12, proteinFactor: 1.8, fatFactor: 1 },
];

const SUPPLEMENT_TIMINGS = [
  { id: "morning", label: "Ujutru" },
  { id: "breakfast", label: "Uz doručak" },
  { id: "lunch", label: "Uz ručak" },
  { id: "postworkout", label: "Posle treninga" },
  { id: "evening", label: "Uveče" },
];

const defaultMeals = [
  "1. Doručak",
  "2. Prva užina",
  "3. Obrok 2h pre treninga",
  "4. Obrok posle treninga",
  "5. Večera",
];

const measurementFields = [
  { id: "trainingType", label: "Trening", type: "text", placeholder: "npr. noge" },
  { id: "calorieDeficit", label: "Kalorije deficit", type: "number", step: "1", unit: "kcal" },
  { id: "weightKg", label: "Težina", type: "number", step: "0.1", unit: "kg" },
  { id: "thighCm", label: "Butine", type: "number", step: "0.1", unit: "cm" },
  { id: "upperWaistCm", label: "Stomak gornji", type: "number", step: "0.1", unit: "cm" },
  { id: "lowerWaistCm", label: "Stomak donji", type: "number", step: "0.1", unit: "cm" },
  { id: "chestCm", label: "Grudi", type: "number", step: "0.1", unit: "cm" },
  { id: "armCm", label: "Ruke", type: "number", step: "0.1", unit: "cm" },
];

const PHOTO_TAGS = ["front", "side", "back"];
const FOOD_MACRO_FILTERS = ["Sve", "Proteini", "UH", "Masti", "Ostalo"];
const IMPORT_AMOUNT_PATTERN =
  "(?:\\d+(?:[.,]\\d+)?\\s*-\\s*\\d+(?:[.,]\\d+)?|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?|[¼½¾])";
const IMPORT_UNIT_PATTERN =
  "kg|g|gr|grama?|ml|l|dl|litr[aeu]?|kom(?:ada)?|ka[sš]ik(?:a|e|om|u)|ka[sš]i?[čc]ic(?:a|e|om|u)|meric(?:a|e|om)|šolj[ae]|solj[ae]|ča[sš](?:a|e|i)?|cup|kri[sš]k(?:a|e)|pakovanj(?:e|a)|kesic(?:a|e)|konzerv(?:a|e)|par[cč]e|par[cč]eta|glavic(?:a|e)|čena?|cena?|komad(?:a)?|list(?:a|ova)?|kolut(?:a|ova)?";
const MEAL_LABEL_MAP = {
  "1. Dorucak": "1. Doručak",
  "2. Uzina": "2. Prva užina",
  "2. Užina": "2. Prva užina",
  "2. Prva uzina": "2. Prva užina",
  "3. Obrok pre treninga": "3. Obrok 2h pre treninga",
  "3. Obrok pred trening": "3. Obrok 2h pre treninga",
  "3. Obrok 2h pre treninga": "3. Obrok 2h pre treninga",
  "4. Obrok posle treninga": "4. Obrok posle treninga",
  "5. Vecera": "5. Večera",
};

const state = {
  activeTab: getInitialTab(),
  selectedWeekday: getTodayWeekday(),
  foodSearch: "",
  foodMacroFilter: "Sve",
  editingEntryId: "",
  editingMealLabel: "",
  planDraft: {
    mealLabel: "",
    foodId: "",
    grams: "",
  },
  editingFavoriteItem: {
    favoriteId: "",
    itemId: "",
    itemIndex: -1,
  },
  favoriteDraft: {
    favoriteName: "",
    mealLabel: "",
    description: "",
    servings: "1",
    prepTimeMinutes: "",
    instructions: "",
    foodId: "",
    grams: "",
  },
  isPlanHeroCompact: false,
  progressCompareTag: PHOTO_TAGS[0],
  progressCompareLeftId: "",
  progressCompareRightId: "",
  deletedPlanEntry: null,
  editingFoodId: "",
  nutritionEditingFoodId: "",
  nutritionSelectedPlanId: "",
  editingHabitId: "",
  editingTaskId: "",
  editingSupplementId: "",
  nutritionImportPending: false,
  nutritionImportStatus: "",
  authReady: false,
  authPending: false,
  authMode: "login",
  authUser: null,
  authError: "",
  syncStatus: "Lokalno čuvanje",
  navMenuOpen: false,
  updateReady: false,
};

let undoDeleteTimer = null;
let cloudSaveTimer = null;
let isHydratingCloudState = false;
let serviceWorkerRegistration = null;
let lockedScrollY = 0;
let feedbackToastTimer = null;
let heroScrollFrame = 0;
let foodSearchRenderTimer = null;
const externalScriptPromises = new Map();

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const firebaseAuth = getAuth(firebaseApp);
const firebaseDb = getFirestore(firebaseApp);

function cloneSeed() {
  return JSON.parse(JSON.stringify(window.SEED_DATA || {}));
}

function normalizeStoreSnapshot(rawStore = {}, fallback = cloneSeed()) {
  const fallbackUi = {
    plan: {
      hideDaySuggestion: false,
      collapsedMealsByWeekday: {},
    },
  };

  const profileDefaults = {
    sex: "",
    heightCm: null,
    activityLevel: "moderate",
  };

  const goalDefaults = {
    targetMode: "lose",
  };

  return {
    ...fallback,
    ...rawStore,
    profile: { ...profileDefaults, ...fallback.profile, ...(rawStore.profile || {}) },
    goals: { ...goalDefaults, ...fallback.goals, ...(rawStore.goals || {}) },
    meta: { ...fallback.meta, ...(rawStore.meta || {}) },
    foods: Array.isArray(rawStore.foods) ? rawStore.foods : fallback.foods,
    weeklyPlanEntries: Array.isArray(rawStore.weeklyPlanEntries)
      ? rawStore.weeklyPlanEntries
      : fallback.weeklyPlanEntries,
    trainingTemplates: Array.isArray(rawStore.trainingTemplates)
      ? rawStore.trainingTemplates
      : fallback.trainingTemplates,
    habits: Array.isArray(rawStore.habits) ? rawStore.habits : [],
    dayTasks: Array.isArray(rawStore.dayTasks) ? rawStore.dayTasks : [],
    favoriteTrainings: Array.isArray(rawStore.favoriteTrainings) ? rawStore.favoriteTrainings : [],
    trainingLogs: Array.isArray(rawStore.trainingLogs) ? rawStore.trainingLogs : [],
    trainingProgressLogs: Array.isArray(rawStore.trainingProgressLogs) ? rawStore.trainingProgressLogs : [],
    trainingBurnByWeekday:
      rawStore.trainingBurnByWeekday && typeof rawStore.trainingBurnByWeekday === "object"
        ? rawStore.trainingBurnByWeekday
        : {},
    measurements: Array.isArray(rawStore.measurements) ? rawStore.measurements : [],
    progressPhotos: Array.isArray(rawStore.progressPhotos) ? rawStore.progressPhotos : [],
    favoriteMeals: Array.isArray(rawStore.favoriteMeals) ? rawStore.favoriteMeals : fallback.favoriteMeals || [],
    favoriteFoods: Array.isArray(rawStore.favoriteFoods) ? rawStore.favoriteFoods : [],
    supplements: Array.isArray(rawStore.supplements) ? rawStore.supplements : [],
    nutritionLibrary: {
      documents: Array.isArray(rawStore.nutritionLibrary?.documents) ? rawStore.nutritionLibrary.documents : [],
      recommendations: Array.isArray(rawStore.nutritionLibrary?.recommendations)
        ? rawStore.nutritionLibrary.recommendations
        : [],
      plans: Array.isArray(rawStore.nutritionLibrary?.plans) ? rawStore.nutritionLibrary.plans : [],
      importedFoodIds: Array.isArray(rawStore.nutritionLibrary?.importedFoodIds)
        ? rawStore.nutritionLibrary.importedFoodIds
        : [],
      importedRecipeIds: Array.isArray(rawStore.nutritionLibrary?.importedRecipeIds)
        ? rawStore.nutritionLibrary.importedRecipeIds
        : [],
      lastImportedAt: String(rawStore.nutritionLibrary?.lastImportedAt || ""),
    },
    ui: {
      ...fallbackUi,
      ...(rawStore.ui || {}),
      plan: {
        ...fallbackUi.plan,
        ...((rawStore.ui && rawStore.ui.plan) || {}),
      },
    },
  };
}

function normalizeDateValue(value) {
  if (!value) {
    return "";
  }

  const normalizedValue = String(value).trim();
  if (!normalizedValue) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    return normalizedValue;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(normalizedValue)) {
    return normalizedValue.slice(0, 10);
  }

  const parsedDate = new Date(normalizedValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return "";
  }

  return `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, "0")}-${String(
    parsedDate.getDate()
  ).padStart(2, "0")}`;
}

function normalizeHabitRecord(habit = {}) {
  const trackingMode = habit?.trackingMode === "streak" ? "streak" : "weekly";
  const fallbackStartDate = normalizeDateValue(habit?.createdAt) || getTodayDateValue();

  return {
    ...habit,
    trackingMode,
    note: String(habit?.note || "").trim(),
    completions: trackingMode === "weekly" && habit?.completions && typeof habit.completions === "object" ? habit.completions : {},
    streakStartDate: trackingMode === "streak" ? normalizeDateValue(habit?.streakStartDate) || fallbackStartDate : "",
    bestStreakDays: Math.max(0, toNumber(habit?.bestStreakDays)),
    resetCount: Math.max(0, toNumber(habit?.resetCount)),
    lastResetAt: trackingMode === "streak" ? normalizeDateValue(habit?.lastResetAt) : "",
  };
}

function readLocalSnapshot() {
  const seed = cloneSeed();
  const storedRaw = localStorage.getItem(STORAGE_KEY);
  if (!storedRaw) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    return seed;
  }

  try {
    return normalizeStoreSnapshot(JSON.parse(storedRaw), seed);
  } catch (error) {
    console.error("State hydration failed", error);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    return seed;
  }
}

function hydrateStore() {
  return readLocalSnapshot();
}

function ensureStoreCollections(targetStore) {
  targetStore.trainingLogs = targetStore.trainingLogs || [];
  targetStore.favoriteTrainings = targetStore.favoriteTrainings || [];
  targetStore.habits = (targetStore.habits || []).map((habit) => normalizeHabitRecord(habit));
  targetStore.dayTasks = targetStore.dayTasks || [];
  targetStore.trainingProgressLogs = targetStore.trainingProgressLogs || [];
  targetStore.trainingBurnByWeekday = targetStore.trainingBurnByWeekday || {};
  targetStore.measurements = targetStore.measurements || [];
  targetStore.progressPhotos = targetStore.progressPhotos || [];
  targetStore.favoriteMeals = targetStore.favoriteMeals || [];
  targetStore.favoriteFoods = targetStore.favoriteFoods || [];
  targetStore.nutritionLibrary = targetStore.nutritionLibrary || {};
  targetStore.nutritionLibrary.documents = Array.isArray(targetStore.nutritionLibrary.documents)
    ? targetStore.nutritionLibrary.documents
    : [];
  targetStore.nutritionLibrary.recommendations = Array.isArray(targetStore.nutritionLibrary.recommendations)
    ? targetStore.nutritionLibrary.recommendations
    : [];
  targetStore.nutritionLibrary.plans = Array.isArray(targetStore.nutritionLibrary.plans) ? targetStore.nutritionLibrary.plans : [];
  targetStore.nutritionLibrary.importedFoodIds = Array.isArray(targetStore.nutritionLibrary.importedFoodIds)
    ? targetStore.nutritionLibrary.importedFoodIds
    : [];
  targetStore.nutritionLibrary.importedRecipeIds = Array.isArray(targetStore.nutritionLibrary.importedRecipeIds)
    ? targetStore.nutritionLibrary.importedRecipeIds
    : [];
  targetStore.nutritionLibrary.lastImportedAt = String(targetStore.nutritionLibrary.lastImportedAt || "");
  targetStore.supplements = (targetStore.supplements || []).map((supplement) => ({
    ...supplement,
    weekdays: Array.isArray(supplement.weekdays) && supplement.weekdays.length ? supplement.weekdays : [...WEEKDAYS],
    completions: supplement.completions && typeof supplement.completions === "object" ? supplement.completions : {},
  }));
  targetStore.ui = targetStore.ui || {};
  targetStore.ui.plan = targetStore.ui.plan || {};
  if (typeof targetStore.ui.plan.hideDaySuggestion !== "boolean") {
    targetStore.ui.plan.hideDaySuggestion = false;
  }
  if (!targetStore.ui.plan.collapsedMealsByWeekday || typeof targetStore.ui.plan.collapsedMealsByWeekday !== "object") {
    targetStore.ui.plan.collapsedMealsByWeekday = {};
  }
  targetStore.weeklyPlanEntries = (targetStore.weeklyPlanEntries || []).map((entry) => ({
    ...entry,
    mealLabel: normalizeMealLabel(entry.mealLabel),
    done: Boolean(entry.done),
  }));
  targetStore.favoriteMeals = targetStore.favoriteMeals.map((favorite) => normalizeFavoriteMealRecord(favorite));
  seedDemoFavoriteMeals(targetStore);
  cleanupNutritionImportedFoods(targetStore);
}

function replaceStore(nextStore) {
  Object.keys(store).forEach((key) => {
    delete store[key];
  });
  Object.assign(store, normalizeStoreSnapshot(nextStore));
  ensureStoreCollections(store);
}

function getSerializableStoreSnapshot(source = store) {
  return JSON.parse(JSON.stringify(source));
}

function getCloudStoreSnapshot(source = store) {
  const snapshot = getSerializableStoreSnapshot(source);
  delete snapshot.progressPhotos;
  return snapshot;
}

function getUserStateRef(uid) {
  return doc(firebaseDb, "users", uid, "app", "state");
}

function getAuthErrorMessage(error) {
  switch (error?.code) {
    case "auth/email-already-in-use":
      return "Taj email je vec zauzet. Probaj prijavu.";
    case "auth/invalid-email":
      return "Email nije ispravan.";
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "Pogresan email ili lozinka.";
    case "auth/weak-password":
      return "Lozinka treba da ima bar 6 karaktera.";
    case "auth/network-request-failed":
      return "Nema veze sa internetom. Pokusaj ponovo.";
    default:
      return "Prijava nije uspela. Pokusaj ponovo.";
  }
}

async function saveCloudStateNow(options = {}) {
  if (!state.authUser || (isHydratingCloudState && !options.force)) {
    return false;
  }

  if (cloudSaveTimer) {
    window.clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }

  try {
    await setDoc(
      getUserStateRef(state.authUser.uid),
      {
        schemaVersion: CLOUD_SCHEMA_VERSION,
        updatedAt: serverTimestamp(),
        state: getCloudStoreSnapshot(),
      },
      { merge: true }
    );
    state.syncStatus = "Sync je ukljucen";
    if (options.renderAfterSave) {
      render();
    }
    return true;
  } catch (error) {
    console.error("Cloud persist failed", error);
    state.syncStatus = "Cloud sync nije uspeo";
    if (options.renderAfterSave) {
      render();
    }
    return false;
  }
}

function scheduleCloudPersist() {
  if (!state.authUser || isHydratingCloudState) {
    return;
  }

  if (cloudSaveTimer) {
    window.clearTimeout(cloudSaveTimer);
  }

  state.syncStatus = "Čuvam izmene u cloud...";
  cloudSaveTimer = window.setTimeout(() => {
    saveCloudStateNow({ renderAfterSave: true });
  }, 650);
}

async function hydrateStoreFromCloud(user) {
  isHydratingCloudState = true;
  state.syncStatus = "Ucitavam podatke iz clouda...";
  render();

  try {
    const localSnapshot = readLocalSnapshot();
    const localPhotos = Array.isArray(localSnapshot.progressPhotos) ? localSnapshot.progressPhotos : [];
    const snapshot = await getDoc(getUserStateRef(user.uid));

    if (snapshot.exists()) {
      const cloudData = snapshot.data()?.state || {};
      replaceStore({ ...cloudData, progressPhotos: localPhotos });
      persistLocal();
      state.syncStatus = "Sync je ukljucen";
      return;
    }

    replaceStore({ ...localSnapshot, progressPhotos: localPhotos });
    persistLocal();
    await saveCloudStateNow({ force: true });
    state.syncStatus = "Prvi sync je zavrsen";
  } catch (error) {
    console.error("Cloud hydration failed", error);
    state.syncStatus = "Cloud nije dostupan, radis lokalno";
  } finally {
    isHydratingCloudState = false;
  }
}

const store = hydrateStore();
ensureStoreCollections(store);

function persistLocal(rollback) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch (error) {
    if (typeof rollback === "function") {
      rollback();
    }
    console.error("Persist failed", error);
    window.alert("Ponestaje prostora za čuvanje podataka. Obriši neke slike ili napravi backup.");
    return false;
  }
}

function persist(rollback) {
  const savedLocal = persistLocal(rollback);
  if (savedLocal) {
    scheduleCloudPersist();
  }
  return savedLocal;
}

function clearDeletedPlanEntry() {
  state.deletedPlanEntry = null;
  if (undoDeleteTimer) {
    window.clearTimeout(undoDeleteTimer);
    undoDeleteTimer = null;
  }
}

function queueDeletedPlanEntry(entry, index) {
  clearDeletedPlanEntry();
  state.deletedPlanEntry = {
    entry,
    index,
  };
  undoDeleteTimer = window.setTimeout(() => {
    state.deletedPlanEntry = null;
    undoDeleteTimer = null;
    render();
  }, 7000);
}

function uid(prefix) {
  if (window.crypto?.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getTodayWeekday() {
  const weekday = new Intl.DateTimeFormat("sr-RS", { weekday: "long" }).format(new Date());
  const normalized = weekday
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^\w/, (letter) => letter.toUpperCase())
    .toLowerCase();
  const fallback = {
    ponedeljak: "Ponedeljak",
    utorak: "Utorak",
    sreda: "Sreda",
    cetvrtak: "Cetvrtak",
    petak: "Petak",
    subota: "Subota",
    nedelja: "Nedelja",
  };
  return fallback[normalized] || "Ponedeljak";
}

function getInitialTab() {
  const hash = window.location.hash.replace("#", "");
  return TABS.some((tab) => tab.id === hash) ? hash : "plan";
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMealLabel(label) {
  const normalized = String(label || "").trim();
  return MEAL_LABEL_MAP[normalized] || normalized;
}

function normalizeFavoriteMealRecord(favorite = {}) {
  const prepTimeMinutes = toNumber(favorite.prepTimeMinutes);
  const servings = Math.max(1, roundValue(toNumber(favorite.servings || favorite.portions || 1), 0)) || 1;
  return {
    ...favorite,
    mealLabel: normalizeMealLabel(favorite.mealLabel),
    description: String(favorite.description || "").trim(),
    instructions: String(favorite.instructions || "").trim(),
    servings,
    prepTimeMinutes: prepTimeMinutes > 0 ? roundValue(prepTimeMinutes, 0) : null,
  };
}

function seedDemoFavoriteMeals(targetStore) {
  const seedFavorites = Array.isArray(window.SEED_DATA?.favoriteMeals) ? cloneSeed().favoriteMeals || [] : [];
  targetStore.meta = targetStore.meta || {};
  const alreadySeeded = Number(targetStore.meta.favoriteRecipesSeedVersion || 0) >= DEMO_RECIPE_SEED_VERSION;
  if (targetStore.favoriteMeals.length || alreadySeeded || !seedFavorites.length) {
    return;
  }
  targetStore.favoriteMeals = seedFavorites.map((favorite) => normalizeFavoriteMealRecord(favorite));
  targetStore.meta.favoriteRecipesSeedVersion = DEMO_RECIPE_SEED_VERSION;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeLookupValue(value) {
  return String(value || "")
    .replace(/đ/g, "dj")
    .replace(/Đ/g, "Dj")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mergeUniqueStrings(...collections) {
  const merged = new Set();
  collections.flat().forEach((value) => {
    const normalizedValue = String(value || "").trim();
    if (normalizedValue) {
      merged.add(normalizedValue);
    }
  });
  return [...merged];
}

function parseDecimal(value) {
  const normalizedValue = String(value ?? "")
    .replace(/½/g, " 1/2")
    .replace(/¼/g, " 1/4")
    .replace(/¾/g, " 3/4")
    .replace(",", ".")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedValue) {
    return 0;
  }

  if (/^\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?$/.test(normalizedValue)) {
    const [fromValue, toValue] = normalizedValue.split("-").map((entry) => Number(entry.trim()));
    if (Number.isFinite(fromValue) && Number.isFinite(toValue)) {
      return (fromValue + toValue) / 2;
    }
  }

  if (/^\d+\s+\d+\/\d+$/.test(normalizedValue)) {
    const [whole, fraction] = normalizedValue.split(" ");
    const [numerator, denominator] = fraction.split("/").map(Number);
    if (denominator) {
      return Number(whole) + numerator / denominator;
    }
  }

  if (/^\d+\/\d+$/.test(normalizedValue)) {
    const [numerator, denominator] = normalizedValue.split("/").map(Number);
    if (denominator) {
      return numerator / denominator;
    }
  }

  const parsed = Number(normalizedValue.replace(/\s+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getFileExtension(name) {
  const parts = String(name || "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function getFileSizeLabel(size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes >= 1024 * 1024) {
    return `${roundValue(bytes / (1024 * 1024), 1)} MB`;
  }
  if (bytes >= 1024) {
    return `${roundValue(bytes / 1024, 1)} KB`;
  }
  return `${bytes} B`;
}

function normalizeNutritionImportText(rawText) {
  return String(rawText || "")
    .replace(/\u0000/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function trimDocumentSnippet(text, limit = 220) {
  const normalizedText = normalizeNutritionImportText(text).replace(/\n+/g, " ");
  if (normalizedText.length <= limit) {
    return normalizedText;
  }
  return `${normalizedText.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function cleanImportLine(line) {
  return String(line || "")
    .replace(/^(?:[\u2022*•\-–—]+|\d+[.)])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeImportedIngredientName(name) {
  return cleanImportLine(name)
    .replace(/\([^)]*\)/g, "")
    .replace(
      /\b(?:samlevenih|samlevene|samleveno|samleven|mlevenih|mlevene|mleveno|mleven|seckanih|seckane|seckano|seckan|isecenih|isecene|iseceno|isecen|iseckanih|iseckane|iseckano|iseckan|usitnjenih|usitnjene|usitnjeno|usitnjen|krupno|sitno|domaci|domaca|domace|domaćih|domacih)\b/gi,
      ""
    )
    .replace(
      /^(?:u\s+[a-zčćžšđ]+\s+)?(?:izgnjavimo|dodati|dodamo|staviti|stavimo|preko(?:\s+toga)?\s+staviti|premazati|napraviti(?:\s+omlet)?\s+od|napraviti|umutiti|pome[sš]ati|prome[sš]ati|posuti|preliti|poređati|poredjati|iseci|iseći|iseckati|isjeći|izgrilovati|spremiti|salata sa|preko)\s+/i,
      ""
    )
    .replace(/\bpo ukusu\b.*$/i, "")
    .replace(/\bpo želji\b.*$/i, "")
    .replace(/\bukoliko.*$/i, "")
    .replace(/\bkada\b.*$/i, "")
    .replace(/\bdok\b.*$/i, "")
    .replace(/\bda\s+(?:se|bi)\b.*$/i, "")
    .replace(
      /\bi\s+(?:dodati|dodamo|staviti|stavimo|umešati|umesati|izmešati|izmesati|pomešati|promešati|poređati|poredjati|peći|peci|kuvati|premazati|posuti|preliti|spremiti)\b.*$/i,
      ""
    )
    .replace(/\bili\b.+$/i, "")
    .replace(/\bna\s+(?:kockice|kolutove|rebarca|listiće|listice|veće komade|manje delove)\b.*$/i, "")
    .replace(/\biseckan(?:e|og|a|o)?\b.*$/i, "")
    .replace(/\bglavice\s+glavice\b/gi, "glavice")
    .replace(/\bsitno\b/gi, "")
    .replace(/[/"“”]+/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[;:,.]+$/, "")
    .trim();
}

function getImportedIngredientDisplayName(name) {
  return cleanImportLine(name)
    .replace(
      /^(?:u\s+[a-zčćžšđ]+\s+)?(?:izgnjavimo|dodati|dodamo|staviti|stavimo|preko(?:\s+toga)?\s+staviti|premazati|napraviti(?:\s+omlet)?\s+od|napraviti|umutiti|pome[sš]ati|prome[sš]ati|posuti|preliti|poređati|poredjati|iseci|iseći|iseckati|isjeći|izgrilovati|spremiti)\s+/i,
      ""
    )
    .replace(/\bpo ukusu\b.*$/i, "")
    .replace(/\bpo želji\b.*$/i, "")
    .replace(/\bukoliko.*$/i, "")
    .replace(/\bkada\b.*$/i, "")
    .replace(/\bdok\b.*$/i, "")
    .replace(/\bda\s+(?:se|bi)\b.*$/i, "")
    .replace(/\bglavice\s+glavice\b/gi, "glavice")
    .replace(/\bsitno\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[;:,.]+$/, "")
    .trim();
}

function canonicalizeImportedFoodName(name) {
  const cleanedName = normalizeImportedIngredientName(name) || cleanImportLine(name);
  const normalizedName = normalizeLookupValue(cleanedName);

  if (!normalizedName) {
    return "";
  }

  const directMappings = [
    { pattern: /^(?:celo jaje|jaje|jaja|jajeta)$/, value: "jaje" },
    { pattern: /^(?:belance|belanca)$/, value: "belance" },
    { pattern: /^(?:piletine|pileceg belog mesa|pilecih prsa|pileceg mesa)$/, value: "piletina" },
    { pattern: /^(?:mlevenog juneceg mesa)$/, value: "mleveno juneće meso" },
    { pattern: /^(?:crnog luka|glavice crnog luka|crnog luka isecenog|luka)$/, value: "crni luk" },
    { pattern: /^(?:belog luka|seckanog belog luka)$/, value: "beli luk" },
    { pattern: /^(?:ovsenih pahuljica|samlevenih ovsenih pahuljica)$/, value: "ovsene pahuljice" },
    { pattern: /^(?:jogurta)$/, value: "jogurt" },
    { pattern: /^(?:sargarepe|sargarepe isecene)$/, value: "šargarepa" },
    { pattern: /^(?:paradajza)$/, value: "paradajz" },
    { pattern: /^(?:paradajz soka|soka od paradajza)$/, value: "sok od paradajza" },
    { pattern: /^(?:pecuraka)$/, value: "pečurke" },
    { pattern: /^(?:mleka)$/, value: "mleko" },
    { pattern: /^(?:krompira)$/, value: "krompir" },
    { pattern: /^(?:kupusa)$/, value: "kupus" },
    { pattern: /^(?:korena persuna)$/, value: "koren peršuna" },
    { pattern: /^(?:gaude)$/, value: "gauda" },
    { pattern: /^(?:fete)$/, value: "feta" },
    { pattern: /^(?:sira)$/, value: "sir" },
    { pattern: /^(?:susama)$/, value: "susam" },
    { pattern: /^(?:suncokreta)$/, value: "suncokret" },
    { pattern: /^(?:mlevenog lana)$/, value: "mleveni lan" },
    { pattern: /^(?:soli)$/, value: "so" },
    { pattern: /^(?:vode)$/, value: "voda" },
    { pattern: /^(?:ulja od kospica grozdja)$/, value: "ulje od košpica grožđa" },
    { pattern: /^(?:maslinovog ulja)$/, value: "maslinovo ulje" },
    { pattern: /^(?:speltinog brasna)$/, value: "speltino brašno" },
    { pattern: /^(?:integralnog speltinog)$/, value: "integralno speltino brašno" },
    { pattern: /^(?:int pirinca)$/, value: "integralni pirinač" },
    { pattern: /^(?:kisele vode)$/, value: "kisela voda" },
    { pattern: /^(?:lovora|lovorov list)$/, value: "lovorov list" },
    { pattern: /^(?:zacini)$/, value: "začini" },
  ];

  const directMatch = directMappings.find(({ pattern }) => pattern.test(normalizedName));
  if (directMatch) {
    return directMatch.value;
  }

  if (normalizedName.includes("grcki jogurt")) {
    return "grčki jogurt";
  }
  if (normalizedName.includes("ovs") && normalizedName.includes("pahulj")) {
    return "ovsene pahuljice";
  }
  if (normalizedName.includes("piletin")) {
    return normalizedName.includes("prsa") ? "pileća prsa" : "piletina";
  }
  if (normalizedName.includes("pecur")) {
    return "pečurke";
  }
  if (normalizedName.includes("paradajz") && normalizedName.includes("sok")) {
    return "sok od paradajza";
  }
  if (normalizedName.includes("paradajz")) {
    return "paradajz";
  }
  if (normalizedName.includes("sargarep")) {
    return "šargarepa";
  }
  if (normalizedName.includes("kupus")) {
    return "kupus";
  }
  if (normalizedName.includes("luk")) {
    if (normalizedName.includes("beli")) {
      return "beli luk";
    }
    if (normalizedName.includes("crni")) {
      return "crni luk";
    }
  }
  if (normalizedName === "so" || normalizedName.includes(" soli")) {
    return "so";
  }
  if (normalizedName.includes("voda")) {
    return normalizedName.includes("kisela") ? "kisela voda" : "voda";
  }
  if (normalizedName.includes("krem sira meggle classic") || normalizedName.includes("sirni namaz meggle classik")) {
    return "meggle cream cheese classic";
  }
  if (normalizedName.includes("president 5 m m")) {
    return "president 5% m.m.";
  }
  if (normalizedName.includes("cottage sira")) {
    return "cottage sir";
  }
  if (normalizedName.includes("mocarel")) {
    return "mocarela";
  }
  if (normalizedName.includes("protein")) {
    return "protein";
  }

  return cleanedName.replace(/\s+/g, " ").trim();
}

function inferImportedFoodCategory(name, existingFood) {
  const existingCategory = String(existingFood?.category || "").trim();
  if (existingCategory && normalizeLookupValue(existingCategory) !== "nutri import") {
    return existingCategory;
  }

  const normalizedName = normalizeLookupValue(name);
  if (!normalizedName) {
    return "Ostalo";
  }

  if (
    /(pilet|june|riba|losos|pastrm|orada|brancin|oslic|bakalar|tunjev|skamp|jaje|belance|sir|jogurt|mocarel|cottage|gaud|feta|protein|puding|mleko)/.test(
      normalizedName
    )
  ) {
    return "Proteini";
  }

  if (
    /(ovs|pirin|testen|brasn|krompir|hleb|tortil|grasak|banana|jabuk|mandarin|kivi|visnj|bobicast|paradajz pire|sok od paradajza|agava|kakao)/.test(
      normalizedName
    )
  ) {
    return "UH";
  }

  if (
    /(maslinovo ulje|ulje od kospica|kikiriki puter|badem|lesnik|orah|lan|susam|suncokret|chia|kokos|avokad)/.test(
      normalizedName
    )
  ) {
    return "Masti";
  }

  return "Ostalo";
}

function extractEmbeddedWeight(name) {
  const match = String(name || "").match(new RegExp(`(${IMPORT_AMOUNT_PATTERN})\\s*(kg|g|gr|grama?|ml|l|dl)\\b`, "i"));
  if (!match) {
    return null;
  }
  return {
    amount: parseDecimal(match[1]),
    unit: match[2],
  };
}

function extractRecipeServings(text) {
  const normalizedText = String(text || "");
  const directMatch = normalizedText.match(
    /(?:za\s*)?(\d+(?:[.,]\d+)?)\s*(?:obroka?|porcij[aeu]?|par[cč]i[cć]a|pala[cč]inki|mafina|servings?|serving)\b/i
  );
  if (directMatch) {
    return Math.max(1, roundValue(parseDecimal(directMatch[1]), 0));
  }
  return 1;
}

function isMealHeadingLine(line) {
  const normalizedLine = normalizeLookupValue(line);
  return (
    normalizedLine.startsWith("dorucak") ||
    normalizedLine.startsWith("rucak") ||
    normalizedLine.startsWith("vecera") ||
    normalizedLine.startsWith("uzina1") ||
    normalizedLine.startsWith("uzina 1") ||
    normalizedLine.startsWith("uzina2") ||
    normalizedLine.startsWith("uzina 2") ||
    normalizedLine.startsWith("uzina")
  );
}

function formatImportedDayMealName(dayTitle, mealTitle) {
  const normalizedDayTitle = cleanImportLine(dayTitle).replace(/\s+/g, " ").trim();
  const normalizedMealTitle = cleanImportLine(mealTitle).replace(/\s+/g, " ").trim();
  return `${normalizedDayTitle} · ${normalizedMealTitle}`;
}

function mergeImportedIngredientCandidates(primary = [], supplemental = []) {
  const merged = new Map();

  [...primary, ...supplemental].forEach((candidate) => {
    const key = normalizeLookupValue(candidate?.name || "");
    if (!key || !candidate?.grams || merged.has(key)) {
      return;
    }

    merged.set(key, {
      name: candidate.name,
      displayName: candidate.displayName || candidate.name,
      grams: candidate.grams,
    });
  });

  return [...merged.values()];
}

function isLikelyCleanImportedIngredient(candidate) {
  const originalName = String(candidate?.name || "").trim();
  const normalizedName = normalizeLookupValue(originalName);
  if (!normalizedName || normalizedName.length < 2) {
    return false;
  }

  if (["1", "int", "u tiganj po", "preko", "salata sa", "posuti", "pa preko toga", "u", "m"].includes(normalizedName)) {
    return false;
  }

  if (
    /(videti recept|na bilo koji od dozvoljenih|iseci|iseći|iseckati|spremiti|preko|pore[dđ]ati|pome[sš]ati|iscekati|izgrilovati|napraviti)/i.test(
      originalName
    )
  ) {
    return false;
  }

  return true;
}

function extractEmbeddedIngredientsFromText(text) {
  const normalizedText = normalizeNutritionImportText(text)
    .replace(
      new RegExp(`([A-Za-zČĆŽŠĐčćžšđ% .,\"“”'()/-]{3,}?)\\s*-\\s*(${IMPORT_AMOUNT_PATTERN})\\s*(${IMPORT_UNIT_PATTERN})?\\b`, "gi"),
      (_, rawName, rawAmount, rawUnit = "") => `${rawAmount}${rawUnit ? ` ${rawUnit}` : ""} ${cleanImportLine(rawName)}`
    )
    .replace(/\bpo\s+(?=\d|[¼½¾])/gi, "")
    .replace(/\s+-\s+/g, "; ");
  const splitPattern = new RegExp(
    `\\s*;\\s*|\\s*\\+\\s*|(?<!\\d),\\s*(?=(?:${IMPORT_AMOUNT_PATTERN}|malo|so|biber|cimet|origano|bosiljak|za[cč]ini)\\b)|\\s+i\\s+(?=(?:${IMPORT_AMOUNT_PATTERN}|malo)\\b)`,
    "i"
  );
  const candidatePattern = new RegExp(
    `(?:^|\\b(?:od|sa|dodati|dodamo|staviti|stavimo|uzeti|napraviti|izgnjavimo|premazati|preko(?:\\s+toga)?\\s+staviti|pome[sš]ati\\s+sa|pome[sš]ati|umutiti|naliti\\s+sa)\\s+)(?<candidate>(?:${IMPORT_AMOUNT_PATTERN}|malo)\\s*(?:${IMPORT_UNIT_PATTERN})?\\s+[^.;\\n]+)`,
    "gi"
  );
  const candidates = [];

  normalizedText
    .split(/\n|[;]+|(?<=[.!?])\s+/)
    .map((part) => cleanImportLine(part))
    .filter(Boolean)
    .forEach((fragment) => {
      const colonParts = fragment.split(/\s*:\s*/).filter(Boolean);
      const candidateFragment =
        colonParts.length > 1 && new RegExp(IMPORT_AMOUNT_PATTERN).test(colonParts.slice(1).join(" : "))
          ? colonParts.slice(1).join(" : ")
          : fragment;
      const shouldTryDirectCandidate =
        new RegExp(`^(?:${IMPORT_AMOUNT_PATTERN}|malo)\\b`, "i").test(candidateFragment) ||
        /^(so|biber|cimet|origano|bosiljak|za[cč]ini|lovorov list)\b/i.test(candidateFragment);
      const hasCompoundSeparators =
        /[+,]/.test(candidateFragment) || new RegExp(`\\s+i\\s+(?=(?:${IMPORT_AMOUNT_PATTERN}|malo)\\b)`, "i").test(candidateFragment);
      const directCandidate = shouldTryDirectCandidate && !hasCompoundSeparators ? parseIngredientCandidate(candidateFragment) : null;
      if (directCandidate) {
        candidates.push(directCandidate);
        return;
      }

      [...candidateFragment.matchAll(candidatePattern)].forEach((match) => {
        const candidateText = cleanImportLine(match.groups?.candidate || "");
        if (!candidateText) {
          return;
        }

        candidateText
          .split(splitPattern)
          .map((part) => cleanImportLine(part))
          .filter(Boolean)
          .forEach((part) => {
            const parsedCandidate = parseIngredientCandidate(part);
            if (parsedCandidate) {
              candidates.push(parsedCandidate);
            }
          });
      });
    });

  return mergeImportedIngredientCandidates(candidates).filter((candidate) => isLikelyCleanImportedIngredient(candidate));
}

function inferMealLabelFromText(text) {
  const normalizedText = normalizeLookupValue(text);

  if (normalizedText.includes("dorucak") || normalizedText.includes("breakfast")) {
    return defaultMeals[0];
  }
  if (normalizedText.includes("uzina") || normalizedText.includes("snack")) {
    return defaultMeals[1];
  }
  if (normalizedText.includes("pre trening") || normalizedText.includes("pred trening") || normalizedText.includes("pre workout")) {
    return defaultMeals[2];
  }
  if (normalizedText.includes("posle trening") || normalizedText.includes("nakon trening") || normalizedText.includes("post workout")) {
    return defaultMeals[3];
  }
  if (normalizedText.includes("vecera") || normalizedText.includes("dinner")) {
    return defaultMeals[4];
  }
  if (normalizedText.includes("rucak") || normalizedText.includes("lunch")) {
    return "Ručak";
  }

  const cleanText = String(text || "").trim();
  return cleanText && cleanText.length <= 34 ? cleanText : defaultMeals[0];
}

function getNutritionDocuments() {
  return [...(store.nutritionLibrary?.documents || [])].sort(
    (left, right) => new Date(right.importedAt || 0) - new Date(left.importedAt || 0)
  );
}

function getNutritionRecommendations() {
  return [...(store.nutritionLibrary?.recommendations || [])].sort(
    (left, right) => new Date(right.importedAt || 0) - new Date(left.importedAt || 0)
  );
}

function getNutritionPlans() {
  return [...(store.nutritionLibrary?.plans || [])].sort((left, right) => {
    const dayDiff = toNumber(left.dayNumber) - toNumber(right.dayNumber);
    if (dayDiff !== 0) {
      return dayDiff;
    }
    return String(left.title || "").localeCompare(String(right.title || ""), "sr");
  });
}

function getNutritionPlanById(planId) {
  return getNutritionPlans().find((plan) => plan.id === planId) || null;
}

function getNutritionPlanMealApplyItems(meal) {
  if (Array.isArray(meal.items) && meal.items.length) {
    return meal.items.filter((item) => item.foodId);
  }

  if (meal.linkedRecipeId) {
    const linkedRecipe = getFavoriteMealsDetailed().find((recipe) => recipe.id === meal.linkedRecipeId);
    if (linkedRecipe) {
      return (linkedRecipe.items || []).filter((item) => item.foodId);
    }
  }

  return [];
}

function applyNutritionPlanDayToSelectedWeekday(planId, mode = "replace") {
  const plan = getNutritionPlanById(planId);
  if (!plan) {
    return { appliedCount: 0, skippedMeals: 0 };
  }

  if (mode === "replace") {
    store.weeklyPlanEntries = store.weeklyPlanEntries.filter((entry) => entry.weekday !== state.selectedWeekday);
  }

  let appliedCount = 0;
  let skippedMeals = 0;

  (plan.meals || []).forEach((meal) => {
    const mealLabel = normalizeMealLabel(meal.mealLabel || meal.title);
    const applyItems = getNutritionPlanMealApplyItems(meal);
    if (!applyItems.length) {
      skippedMeals += 1;
      return;
    }

    applyItems.forEach((item) => {
      store.weeklyPlanEntries.push({
        id: uid("plan"),
        weekday: state.selectedWeekday,
        mealLabel,
        foodId: item.foodId,
        foodName: item.foodName || item.displayName || "",
        grams: roundValue(item.grams, 1),
        done: false,
      });
      appliedCount += 1;
    });
  });

  return { appliedCount, skippedMeals };
}

function getNutritionImportedFoodsDetailed() {
  const importedIds = new Set(store.nutritionLibrary?.importedFoodIds || []);
  return getFoods().filter((food) => importedIds.has(food.id));
}

function getNutritionImportedRecipesDetailed() {
  const importedIds = new Set(store.nutritionLibrary?.importedRecipeIds || []);
  return getFavoriteMealsDetailed().filter((recipe) => importedIds.has(recipe.id));
}

function findFoodByExactName(name) {
  const normalizedName = normalizeLookupValue(canonicalizeImportedFoodName(name) || name);
  if (!normalizedName) {
    return null;
  }
  return (
    store.foods.find(
      (food) => normalizeLookupValue(canonicalizeImportedFoodName(food.name) || food.name) === normalizedName
    ) || null
  );
}

function findBestFoodMatchByName(name, category = "") {
  const canonicalName = canonicalizeImportedFoodName(name) || name;
  const normalizedName = normalizeLookupValue(canonicalName);
  if (!normalizedName) {
    return null;
  }

  const scoredFoods = getSelectableFoods()
    .map((food) => {
      const foodCanonicalName = normalizeLookupValue(canonicalizeImportedFoodName(food.name) || food.name);
      const exactCanonicalMatch = Number(foodCanonicalName === normalizedName);
      const partialCanonicalMatch = Number(
        Boolean(foodCanonicalName) &&
          foodCanonicalName !== normalizedName &&
          (foodCanonicalName.includes(normalizedName) || normalizedName.includes(foodCanonicalName))
      );
      const hasNutrition = Number(toNumber(food.kcal) > 0 || toNumber(food.protein) > 0 || toNumber(food.carbs) > 0 || toNumber(food.fat) > 0);
      const sameCategory = Number(Boolean(category) && String(food.category || "").trim() === String(category || "").trim());
      const isBaseFood = Number(food.importSource !== "nutrition-import");

      return {
        food,
        score: exactCanonicalMatch * 100 + partialCanonicalMatch * 40 + hasNutrition * 20 + sameCategory * 5 + isBaseFood * 3,
      };
    })
    .sort((left, right) => right.score - left.score || String(left.food.name || "").localeCompare(String(right.food.name || ""), "sr"));

  const bestMatch = scoredFoods[0];
  if (!bestMatch || bestMatch.score < 60) {
    return null;
  }

  return bestMatch.food;
}

function getImportValueOrFallback(nextValue, currentValue) {
  const normalizedNextValue = parseDecimal(nextValue);
  if (normalizedNextValue > 0) {
    return roundValue(normalizedNextValue, 1);
  }
  return roundValue(toNumber(currentValue), 1);
}

function matchesImportedDocumentName(value, documentName) {
  return normalizeLookupValue(value) === normalizeLookupValue(documentName);
}

function collectReferencedFoodIds() {
  const referencedFoodIds = new Set();

  (store.weeklyPlanEntries || []).forEach((entry) => {
    if (entry?.foodId) {
      referencedFoodIds.add(entry.foodId);
    }
  });

  (store.favoriteMeals || []).forEach((favorite) => {
    (favorite.items || []).forEach((item) => {
      if (item?.foodId) {
        referencedFoodIds.add(item.foodId);
      }
    });
  });

  return referencedFoodIds;
}

function pruneNutritionImportIndexes() {
  const validFoodIds = new Set(store.foods.filter((food) => food.importSource === "nutrition-import").map((food) => food.id));
  const validRecipeIds = new Set(
    store.favoriteMeals.filter((recipe) => recipe.importSource === "nutrition-import").map((recipe) => recipe.id)
  );

  store.nutritionLibrary.importedFoodIds = (store.nutritionLibrary.importedFoodIds || []).filter((foodId) => validFoodIds.has(foodId));
  store.nutritionLibrary.importedRecipeIds = (store.nutritionLibrary.importedRecipeIds || []).filter((recipeId) => validRecipeIds.has(recipeId));
}

function removeNutritionImportDataForDocument(documentName) {
  const normalizedDocumentName = normalizeLookupValue(documentName);
  if (!normalizedDocumentName) {
    return;
  }

  const removedDocumentIds = new Set(
    (store.nutritionLibrary.documents || [])
      .filter((documentRecord) => matchesImportedDocumentName(documentRecord.name, documentName))
      .map((documentRecord) => documentRecord.id)
  );

  const removedRecipeIds = new Set();
  store.favoriteMeals = (store.favoriteMeals || []).filter((recipe) => {
    const hasDocumentMatch = (recipe.importSourceDocNames || []).some((entry) => matchesImportedDocumentName(entry, documentName));
    if (recipe.importSource === "nutrition-import" && hasDocumentMatch) {
      removedRecipeIds.add(recipe.id);
      return false;
    }
    return true;
  });

  const referencedFoodIds = collectReferencedFoodIds();
  const removedFoodIds = new Set();
  store.foods = (store.foods || []).filter((food) => {
    const hasDocumentMatch = (food.importSourceDocNames || []).some((entry) => matchesImportedDocumentName(entry, documentName));
    if (!(food.importSource === "nutrition-import" && hasDocumentMatch)) {
      return true;
    }

    const remainingDocNames = (food.importSourceDocNames || []).filter((entry) => !matchesImportedDocumentName(entry, documentName));
    const remainingDocIds = (food.importSourceDocIds || []).filter((docId) => !removedDocumentIds.has(docId));

    if (remainingDocNames.length || referencedFoodIds.has(food.id)) {
      food.importSourceDocNames = remainingDocNames;
      food.importSourceDocIds = remainingDocIds;
      return true;
    }

    removedFoodIds.add(food.id);
    return false;
  });

  store.favoriteFoods = (store.favoriteFoods || []).filter((foodId) => !removedFoodIds.has(foodId));
  store.nutritionLibrary.documents = (store.nutritionLibrary.documents || []).filter(
    (documentRecord) => !matchesImportedDocumentName(documentRecord.name, documentName)
  );
  store.nutritionLibrary.plans = (store.nutritionLibrary.plans || [])
    .map((plan) => ({
      ...plan,
      sourceDocNames: (plan.sourceDocNames || []).filter((entry) => !matchesImportedDocumentName(entry, documentName)),
      sourceDocIds: (plan.sourceDocIds || []).filter((docId) => !removedDocumentIds.has(docId)),
    }))
    .filter((plan) => (plan.sourceDocNames || []).length || (plan.sourceDocIds || []).length);
  store.nutritionLibrary.recommendations = (store.nutritionLibrary.recommendations || [])
    .map((recommendation) => {
      const sourceDocNames = (recommendation.sourceDocNames || []).filter((entry) => !matchesImportedDocumentName(entry, documentName));
      const sourceDocIds = (recommendation.sourceDocIds || []).filter((docId) => !removedDocumentIds.has(docId));
      return {
        ...recommendation,
        sourceDocNames,
        sourceDocIds,
      };
    })
    .filter((recommendation) => recommendation.sourceDocNames.length || recommendation.sourceDocIds.length);

  pruneNutritionImportIndexes();
}

function resetNutritionImportWorkspace(targetStore) {
  (targetStore.foods || []).forEach((food) => {
    if (food.importSource === "nutrition-import" && !getFoodNutritionStatus(food).needsAttention) {
      food.importSource = "";
      food.importSourceDocIds = [];
      food.importSourceDocNames = [];
    }
  });

  const importedFoodIds = new Set(
    (targetStore.foods || []).filter((food) => food.importSource === "nutrition-import").map((food) => food.id)
  );
  const importedRecipeIds = new Set(
    (targetStore.favoriteMeals || []).filter((recipe) => recipe.importSource === "nutrition-import").map((recipe) => recipe.id)
  );

  targetStore.weeklyPlanEntries = (targetStore.weeklyPlanEntries || []).filter((entry) => !importedFoodIds.has(entry.foodId));
  targetStore.favoriteMeals = (targetStore.favoriteMeals || [])
    .filter((recipe) => !importedRecipeIds.has(recipe.id))
    .map((recipe) => ({
      ...recipe,
      items: (recipe.items || []).filter((item) => !importedFoodIds.has(item.foodId)),
    }));
  targetStore.foods = (targetStore.foods || []).filter((food) => !importedFoodIds.has(food.id));
  targetStore.favoriteFoods = (targetStore.favoriteFoods || []).filter((foodId) => !importedFoodIds.has(foodId));
  targetStore.nutritionLibrary.documents = [];
  targetStore.nutritionLibrary.plans = [];
  targetStore.nutritionLibrary.recommendations = [];
  targetStore.nutritionLibrary.importedFoodIds = [];
  targetStore.nutritionLibrary.importedRecipeIds = [];
  targetStore.nutritionLibrary.lastImportedAt = "";
}

function loadExternalScript(src, globalName) {
  if (globalName && window[globalName]) {
    return Promise.resolve(window[globalName]);
  }

  if (externalScriptPromises.has(src)) {
    return externalScriptPromises.get(src);
  }

  const promise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[data-external-src="${src}"]`);
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(globalName ? window[globalName] : true), { once: true });
      existingScript.addEventListener("error", () => reject(new Error(`Učitavanje biblioteke nije uspelo: ${src}`)), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.externalSrc = src;
    script.onload = () => resolve(globalName ? window[globalName] : true);
    script.onerror = () => reject(new Error(`Učitavanje biblioteke nije uspelo: ${src}`));
    document.head.appendChild(script);
  }).catch((error) => {
    externalScriptPromises.delete(src);
    throw error;
  });

  externalScriptPromises.set(src, promise);
  return promise;
}

async function ensureMammoth() {
  const mammoth = await loadExternalScript("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js", "mammoth");
  if (!mammoth) {
    throw new Error("DOCX parser nije dostupan.");
  }
  return mammoth;
}

async function ensurePdfJs() {
  const pdfjsLib = await loadExternalScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js", "pdfjsLib");
  if (!pdfjsLib) {
    throw new Error("PDF parser nije dostupan.");
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return pdfjsLib;
}

async function extractTextFromDocxFile(file) {
  const mammoth = await ensureMammoth();
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return normalizeNutritionImportText(result?.value || "");
}

async function extractTextFromPdfFile(file) {
  const pdfjsLib = await ensurePdfJs();
  const pdfDocument = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    let previousY = null;
    const lines = [];

    textContent.items.forEach((item) => {
      const fragment = String(item.str || "").trim();
      if (!fragment) {
        return;
      }
      const y = Math.round(item.transform?.[5] || 0);
      if (previousY !== null && Math.abs(previousY - y) > 4) {
        lines.push("\n");
      } else if (lines.length) {
        lines.push(" ");
      }
      lines.push(fragment);
      previousY = y;
    });

    pageTexts.push(lines.join("").replace(/\n{3,}/g, "\n\n"));
  }

  return normalizeNutritionImportText(pageTexts.join("\n\n"));
}

async function extractNutritionTextFromFile(file) {
  const extension = getFileExtension(file.name);

  if (["txt", "md", "csv", "json", "html", "htm"].includes(extension)) {
    return {
      text: normalizeNutritionImportText(await file.text()),
      parser: extension.toUpperCase(),
    };
  }

  if (extension === "docx") {
    return {
      text: await extractTextFromDocxFile(file),
      parser: "DOCX",
    };
  }

  if (extension === "pdf") {
    return {
      text: await extractTextFromPdfFile(file),
      parser: "PDF",
    };
  }

  throw new Error("Format trenutno nije podržan. Uvezi PDF, DOCX, TXT, MD, CSV ili JSON.");
}

function convertImportedPortionToGrams(amount, unit, ingredientName) {
  const normalizedUnit = normalizeLookupValue(unit);
  const normalizedName = normalizeLookupValue(ingredientName);
  if (!amount) {
    return 0;
  }

  const embeddedWeight = extractEmbeddedWeight(ingredientName);
  if (embeddedWeight && /(pakov|kesic|konzerv)/.test(normalizedUnit)) {
    return convertImportedPortionToGrams(amount * embeddedWeight.amount, embeddedWeight.unit, ingredientName);
  }

  if (["g", "gr", "gram", "grama", "grami"].includes(normalizedUnit)) {
    return roundValue(amount, 0);
  }
  if (normalizedUnit === "kg") {
    return roundValue(amount * 1000, 0);
  }
  if (["ml", "l", "dl", "litar", "litra", "litre"].includes(normalizedUnit)) {
    if (normalizedUnit === "l") {
      return roundValue(amount * 1000, 0);
    }
    if (normalizedUnit.startsWith("litr")) {
      return roundValue(amount * 1000, 0);
    }
    if (normalizedUnit === "dl") {
      return roundValue(amount * 100, 0);
    }
    return roundValue(amount, 0);
  }
  if (normalizedUnit.includes("kasic")) {
    return roundValue(amount * 5, 0);
  }
  if (normalizedUnit.includes("kasik")) {
    return roundValue(amount * 15, 0);
  }
  if (normalizedUnit.includes("meric")) {
    return roundValue(amount * 30, 0);
  }
  if (normalizedUnit.includes("solj") || normalizedUnit === "cup") {
    return roundValue(amount * 240, 0);
  }
  if (normalizedUnit.includes("cas") || normalizedUnit.includes("čaš")) {
    return roundValue(amount * 200, 0);
  }
  if (normalizedUnit.includes("krisk")) {
    return roundValue(amount * 30, 0);
  }
  if (normalizedUnit.includes("parce") || normalizedUnit.includes("parče")) {
    if (normalizedName.includes("hleb") || normalizedName.includes("tonus") || normalizedName.includes("vitas")) {
      return roundValue(amount * 20, 0);
    }
    return roundValue(amount * 35, 0);
  }
  if (normalizedUnit.includes("pakov") || normalizedUnit.includes("kesic")) {
    if (normalizedName.includes("puding")) return roundValue(amount * 200, 0);
    if (normalizedName.includes("cottage")) return roundValue(amount * 180, 0);
    return roundValue(amount * 200, 0);
  }
  if (normalizedUnit.includes("konzerv")) {
    if (normalizedName.includes("tunjev")) return roundValue(amount * 120, 0);
    return roundValue(amount * 150, 0);
  }
  if (normalizedUnit.includes("glavic")) {
    if (normalizedName.includes("luk")) return roundValue(amount * 120, 0);
    if (normalizedName.includes("kupus")) return roundValue(amount * 800, 0);
    return roundValue(amount * 100, 0);
  }
  if (normalizedUnit === "cen" || normalizedUnit === "cena" || normalizedUnit.includes("čen")) {
    return roundValue(amount * 5, 0);
  }
  if (normalizedUnit.includes("list")) {
    return roundValue(amount * 3, 0);
  }
  if (normalizedUnit.includes("kolut")) {
    if (normalizedName.includes("pilec")) return roundValue(amount * 15, 0);
    return roundValue(amount * 10, 0);
  }
  if (normalizedUnit.includes("kom")) {
    if (normalizedName.includes("jaje")) return roundValue(amount * 60, 0);
    if (normalizedName.includes("belance")) return roundValue(amount * 33, 0);
    if (normalizedName.includes("banana")) return roundValue(amount * 120, 0);
    if (normalizedName.includes("jabuk")) return roundValue(amount * 180, 0);
    if (normalizedName.includes("tortilj")) return roundValue(amount * 60, 0);
    if (normalizedName.includes("avokad")) return roundValue(amount * 150, 0);
    if (normalizedName.includes("mandarin")) return roundValue(amount * 80, 0);
    if (normalizedName.includes("limun")) return roundValue(amount * 100, 0);
    return roundValue(amount * 50, 0);
  }

  return roundValue(amount, 0);
}

function parseIngredientCandidate(rawLine) {
  const line = cleanImportLine(rawLine);
  if (!line || /kcal|protein|proteini|uh|ugljeni|masti/i.test(line)) {
    return null;
  }

  if (/^malo\b/i.test(line)) {
    const name = normalizeImportedIngredientName(line.replace(/^malo\b/i, "").trim());
    const grams = /(so|biber|za[cč]in|cimet|soda|pra[sš]ak|ren|susam|lan)/i.test(name)
      ? 2
      : /(mlek|voda|jogurt|sok)/i.test(name)
        ? 30
        : 15;
    if (!name) {
      return null;
    }
    return {
      name,
      displayName: getImportedIngredientDisplayName(line) || name,
      grams,
    };
  }

  if (/^(so|biber|cimet|origano|bosiljak|za[cč]ini(?: po [a-zčćžšđ]+)?|lovorov list)$/i.test(line)) {
    return {
      name: normalizeImportedIngredientName(line),
      displayName: getImportedIngredientDisplayName(line) || normalizeImportedIngredientName(line),
      grams: /lovor/i.test(line) ? 3 : 2,
    };
  }

  const patterns = [
    new RegExp(`^(?<amount>${IMPORT_AMOUNT_PATTERN})\\s*(?<unit>${IMPORT_UNIT_PATTERN})\\s+(?<name>.+)$`, "i"),
    new RegExp(
      `^(?<amount>${IMPORT_AMOUNT_PATTERN})\\s+(?<name>(?:celo|cela|cela?\\s+)?(?:jaje|jaja|jajeta|belance|belanca|avokado|avokada|limun|limuna|banana|banane|jabuka|jabuke|tortilja|tortilje|mandarina|mandarine|puding|glavica\\s+[^,;]+|glavice\\s+[^,;]+|čen\\s+[^,;]+|list\\s+[^,;]+|koluta\\s+[^,;]+).+?)$`,
      "i"
    ),
    new RegExp(`^(?<name>.+?)\\s*(?:[-–:x×]|=)?\\s*(?<amount>${IMPORT_AMOUNT_PATTERN})\\s*(?<unit>${IMPORT_UNIT_PATTERN})\\b`, "i"),
    new RegExp(`^(?<amount>${IMPORT_AMOUNT_PATTERN})\\s+(?<name>.+)$`, "i"),
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match?.groups) {
      continue;
    }

    const amount = parseDecimal(match.groups.amount);
    const rawName = String(match.groups.name || "");
    const name = normalizeImportedIngredientName(rawName);
    const inferredUnit =
      match.groups.unit ||
      (amount >= 20 && /(vod|mlek|jogurt|bra[sš]n|sir|pirin|testenin|krompir|pe[cč]ur|tikvic|kupus|mandarin|jabuk|kivi)/i.test(name)
        ? "g"
        : /lovor/i.test(name)
          ? "list"
          : "kom");
    const grams = convertImportedPortionToGrams(amount, inferredUnit, rawName);

    if (/(stepeni|minuta?|ringl|pe[cč]i|staviti|sa[cč]ekati|dodati|izme[sš]ati|prome[sš]ati|ostaviti|proklju[cč]a|skloniti|kuvati)/i.test(name)) {
      continue;
    }

    if (
      !name ||
      !grams ||
      /^[\d/.]+$/.test(name) ||
      new RegExp(`${IMPORT_AMOUNT_PATTERN}\\s*(?:${IMPORT_UNIT_PATTERN})\\b`, "i").test(name)
    ) {
      continue;
    }

    return {
      name,
      displayName: getImportedIngredientDisplayName(rawName) || name,
      grams,
      sourceAmount: amount,
      sourceUnit: String(match.groups.unit || "").trim(),
    };
  }

  return null;
}

function parseIngredientCandidatesFromBlock(block) {
  const candidates = [];
  const lines = String(block || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  lines.forEach((line) => {
    let normalizedLine = line.replace(/^(?:[\-\u2022*•]+\s*|\d+[.)]\s*)/, "").trim();
    const colonParts = normalizedLine.split(/\s*:\s*/).filter(Boolean);
    if (colonParts.length > 1 && colonParts.slice(1).some((part) => new RegExp(IMPORT_AMOUNT_PATTERN).test(part))) {
      normalizedLine = colonParts.slice(1).join(" : ");
    }
    const parts = normalizedLine
      .split(
        new RegExp(
          `\\s*;\\s*|\\s*\\+\\s*|(?<!\\d),\\s*(?=(?:${IMPORT_AMOUNT_PATTERN}|malo|so|biber|cimet|origano|bosiljak|za[cč]ini)\\b)|\\s+i\\s+(?=(?:${IMPORT_AMOUNT_PATTERN}|malo)\\b)`,
          "i"
        )
      )
      .filter(Boolean);
    if (parts.length > 1) {
      parts.forEach((part) => {
        const candidate = parseIngredientCandidate(part);
        if (candidate) {
          candidates.push(candidate);
        }
      });
      return;
    }

    const directCandidate = parseIngredientCandidate(normalizedLine);
    if (directCandidate) {
      candidates.push(directCandidate);
    }
  });

  return mergeImportedIngredientCandidates(candidates).filter((candidate) => isLikelyCleanImportedIngredient(candidate));
}

function parseMacroValue(line, labelPattern) {
  const match = line.match(new RegExp(`${labelPattern}\\s*[:=]?\\s*(\\d+(?:[.,]\\d+)?)`, "i"));
  return match ? parseDecimal(match[1]) : 0;
}

function parseFoodFromMacroLine(rawLine) {
  const line = cleanImportLine(rawLine);
  if (!line || !/(kcal|protein|proteini|uh|ugljeni|masti|fat)/i.test(line)) {
    return null;
  }

  const servingMatch = line.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grama?|ml|l)\b/i);
  const servingBaseGrams = servingMatch
    ? convertImportedPortionToGrams(parseDecimal(servingMatch[1]), servingMatch[2], "")
    : 100;
  const kcalMatch = line.match(/(\d+(?:[.,]\d+)?)\s*kcal/i);
  const protein = parseMacroValue(line, "(?:P|protein(?:i)?|proteini)");
  const carbs = parseMacroValue(line, "(?:UH|ugljeni(?:\\s*hidrati)?)");
  const fat = parseMacroValue(line, "(?:M|mast(?:i)?|masti|fat)");
  let name = line
    .split(/(?:\d+(?:[.,]\d+)?\s*kcal|\bP\b|\bUH\b|\bM\b|protein|proteini|ugljeni|masti|fat)/i)[0]
    .replace(/[|•]/g, " ")
    .replace(/\d+(?:[.,]\d+)?\s*(kg|g|gr|grama?|ml|l)\b/gi, " ")
    .replace(/[.,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name || name.length < 2) {
    const fallbackParts = line.split("|").map((part) => cleanImportLine(part)).filter(Boolean);
    name = fallbackParts[0] || "";
  }

  if (!name || name.length < 2) {
    return null;
  }

  return {
    name,
    category: "Nutri import",
    servingBaseGrams: servingBaseGrams || 100,
    kcal: kcalMatch ? parseDecimal(kcalMatch[1]) : 0,
    protein,
    carbs,
    fat,
  };
}

function createRecommendationRecord(text, documentRecord) {
  const normalizedText = cleanImportLine(text);
  if (!normalizedText) {
    return null;
  }

  const titleCandidate = normalizedText.split(/[:.]/)[0].trim();
  const title =
    titleCandidate.length >= 6 && titleCandidate.length <= 58
      ? titleCandidate
      : normalizedText.split(/\s+/).slice(0, 6).join(" ");

  return {
    id: uid("nutrition-rec"),
    title,
    text: normalizedText,
    sourceDocIds: [documentRecord.id],
    sourceDocNames: [documentRecord.name],
    importedAt: new Date().toISOString(),
  };
}

function findNutritionRecipeMatch(mealTitle, mealText = "") {
  const normalizedMealTitle = normalizeLookupValue(mealTitle);
  const normalizedMealText = normalizeLookupValue(mealText);
  if (!normalizedMealTitle && !normalizedMealText) {
    return null;
  }

  const favorites = getFavoriteMealsDetailed();
  return (
    favorites.find((favorite) => {
      const normalizedName = normalizeLookupValue(favorite.name);
      if (!normalizedName) {
        return false;
      }

      return (
        normalizedName === normalizedMealTitle ||
        (normalizedMealTitle && normalizedMealTitle.includes(normalizedName)) ||
        (normalizedMealText && normalizedMealText.includes(normalizedName))
      );
    }) || null
  );
}

function buildNutritionPlanMeal(mealTitle, mealText) {
  const normalizedText = mealText
    .split("\n")
    .map((line) => cleanImportLine(line))
    .filter(Boolean)
    .join("\n");
  const linkedRecipe = findNutritionRecipeMatch(mealTitle, normalizedText);
  const parsedItems = mergeImportedIngredientCandidates(
    parseIngredientCandidatesFromBlock(normalizedText),
    extractEmbeddedIngredientsFromText(normalizedText)
  );
  const recipeItems =
    !parsedItems.length && linkedRecipe
      ? (linkedRecipe.items || []).map((item) => ({
          name: item.foodName || item.displayName,
          displayName: item.displayName || item.foodName,
          grams: item.grams,
          foodId: item.foodId || "",
        }))
      : [];
  const rawItems = parsedItems.length ? parsedItems : recipeItems;
  const items = rawItems.map((item) => {
    const itemName = item.displayName || item.name || "";
    const exactFood = item.foodId ? getFoodById(item.foodId) : null;
    const canonicalItemName = canonicalizeImportedFoodName(item.name) || itemName;
    const matchedFood = exactFood || findFoodByExactName(canonicalItemName) || findBestFoodMatchByName(canonicalItemName) || null;
    const totals = matchedFood ? calculateEntry(matchedFood, item.grams) : { kcal: 0, protein: 0, carbs: 0, fat: 0 };

    return {
      foodId: matchedFood?.id || item.foodId || "",
      foodName: matchedFood?.name || itemName,
      displayName: itemName,
      grams: roundValue(item.grams, 1),
      totals,
    };
  });

  return {
    id: uid("nutrition-plan-meal"),
    mealLabel: normalizeMealLabel(mealTitle),
    title: mealTitle,
    text: normalizedText,
    notes: normalizedText.replace(/\n+/g, " "),
    linkedRecipeId: linkedRecipe?.id || "",
    linkedRecipeName: linkedRecipe?.name || "",
    instructions: linkedRecipe?.instructions || "",
    servings: linkedRecipe?.servings || 0,
    items,
    totals: linkedRecipe && !parsedItems.length ? linkedRecipe.perServingTotals : getDayTotals(items),
  };
}

function createNutritionPlanRecord(planDraft, documentRecord) {
  const meals = (planDraft.meals || []).map((meal) => buildNutritionPlanMeal(meal.title, meal.text)).filter((meal) => meal.title);
  if (!meals.length && !(planDraft.notes || []).length) {
    return null;
  }

  return {
    id: uid("nutrition-plan"),
    dayNumber: toNumber(planDraft.dayNumber),
    title: planDraft.title,
    weekdayLabel: planDraft.weekdayLabel || "",
    notes: (planDraft.notes || []).map((note) => cleanImportLine(note)).filter(Boolean),
    meals,
    sourceDocIds: [documentRecord.id],
    sourceDocNames: [documentRecord.name],
    importedAt: new Date().toISOString(),
  };
}

function detectNutritionDocumentKind(file, text) {
  const normalizedFileName = normalizeLookupValue(file?.name || "");
  const normalizedText = normalizeLookupValue(String(text || "").slice(0, 1200));

  if (normalizedFileName.includes("recept") || normalizedText.startsWith("recepti")) {
    return "recipes";
  }
  if (normalizedFileName.includes("preporuk") || normalizedText.includes("preporuke")) {
    return "recommendations";
  }
  if (normalizedFileName.includes("jelovnik") || normalizedText.startsWith("jelovnik za")) {
    return "meal-plan";
  }
  return "generic";
}

function parseRecommendationsDocument(text) {
  const lines = normalizeNutritionImportText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const startIndex = lines.findIndex((line) => /^preporuke:?$/i.test(cleanImportLine(line)));
  const relevantLines = startIndex >= 0 ? lines.slice(startIndex + 1) : lines;
  const recommendations = [];
  let currentTitle = "";
  let buffer = [];

  const flush = () => {
    const textValue = buffer.map((entry) => cleanImportLine(entry)).filter(Boolean).join(" ");
    if (!textValue) {
      buffer = [];
      return;
    }
    recommendations.push({
      title: currentTitle || textValue.split(/[:.]/)[0].trim().slice(0, 80),
      text: textValue,
    });
    buffer = [];
  };

  relevantLines.forEach((line) => {
    const trimmedLine = line.trim();
    const cleanLine = cleanImportLine(trimmedLine);
    if (!cleanLine) {
      return;
    }

    const isHeading =
      /^[A-ZČĆŽŠĐ0-9 .()\/,-]{5,}:?$/.test(trimmedLine) ||
      /:$/.test(trimmedLine) ||
      /^HIDRATACIJA:?$/i.test(cleanLine) ||
      /^SUPLEMENTACIJA:?$/i.test(cleanLine) ||
      /^FIZIČKA AKTIVNOST:?$/i.test(cleanLine) ||
      /^OPŠTE SMERNICE:?$/i.test(cleanLine);

    if (isHeading) {
      flush();
      currentTitle = cleanLine.replace(/[:.]+$/, "").trim();
      return;
    }

    buffer.push(cleanLine);
  });

  flush();

  return {
    recommendations,
    foods: [],
    recipes: [],
  };
}

function getImportedRecipeFallbackItems(recipeName, body) {
  const normalizedRecipeName = normalizeLookupValue(recipeName);
  if (!normalizedRecipeName.includes("sirni namaz")) {
    return [];
  }

  const fallbackItems = [];
  if (/semenki susama/i.test(body)) {
    fallbackItems.push({ name: "susama", grams: 15 });
  }
  if (/suncokreta/i.test(body)) {
    fallbackItems.push({ name: "suncokreta", grams: 15 });
  }
  if (/mlevenog lana/i.test(body)) {
    fallbackItems.push({ name: "mlevenog lana", grams: 15 });
  }
  if (/zrnasti sir/i.test(body)) {
    fallbackItems.push({ name: "zrnasti sir", grams: 100 });
  }
  if (/gr[čc]ki jogurt\s*-\s*100g/i.test(body)) {
    fallbackItems.push({ name: "grčki jogurt", grams: 100 });
  }

  return fallbackItems;
}

function parseRecipesDocument(text) {
  const normalizedText = normalizeNutritionImportText(text);
  const recipes = [];
  const sectionPattern =
    /(?:^|\n)(\d+\.\s*(?:[A-ZČĆŽŠĐ0-9][A-ZČĆŽŠĐ0-9 .,:\-\/]*)(?:\s*\([^)\n]*\))?:?)\n([\s\S]*?)(?=\n\d+\.\s*(?:[A-ZČĆŽŠĐ0-9][A-ZČĆŽŠĐ0-9 .,:\-\/]*)(?:\s*\([^)\n]*\))?:?\n|\s*$)/g;
  let match;

  while ((match = sectionPattern.exec(normalizedText))) {
    const rawHeading = cleanImportLine(match[1]);
    const body = String(match[2] || "").trim();
    if (!rawHeading || !body) {
      continue;
    }

    const servings = extractRecipeServings(`${rawHeading}\n${body}`);
    const name = rawHeading
      .replace(/\(\s*[^)]*(?:obroka?|porcij[aeu]?|par[cč]i[cć]a|pala[cč]inki|mafina|servings?)\s*\)\s*$/i, "")
      .replace(/[:.]+$/, "")
      .trim();
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const hasExplicitIngredientsHeading = lines.some((line) => /^sastojci:?$/i.test(cleanImportLine(line)));
    const ingredientLines = [];
    const instructionLines = [];
    let inIngredients = false;
    let inInstructions = false;

    lines.forEach((line) => {
      const cleanLine = cleanImportLine(line);
      if (!cleanLine) {
        return;
      }
      if (/^sastojci:?$/i.test(cleanLine)) {
        inIngredients = true;
        return;
      }
      if (/^priprema:?$/i.test(cleanLine)) {
        inIngredients = false;
        inInstructions = true;
        return;
      }

      if (/:$/.test(cleanLine) && !new RegExp(IMPORT_AMOUNT_PATTERN).test(cleanLine) && !/^sastojci:?$/i.test(cleanLine)) {
        return;
      }

      if (
        hasExplicitIngredientsHeading &&
        inIngredients &&
        !/^[\-\u2022*•]/.test(line) &&
        !new RegExp(`^${IMPORT_AMOUNT_PATTERN}\\s*(?:${IMPORT_UNIT_PATTERN})?\\b`, "i").test(cleanLine)
      ) {
        inIngredients = false;
        inInstructions = true;
      }

      if (
        !inInstructions &&
        ((inIngredients && (/^[\-\u2022*•]/.test(line) || new RegExp(`^${IMPORT_AMOUNT_PATTERN}`, "i").test(cleanLine))) ||
          (!hasExplicitIngredientsHeading && parseIngredientCandidate(cleanLine)))
      ) {
        ingredientLines.push(line);
        return;
      }

      inInstructions = true;
      instructionLines.push(cleanLine);
    });

    let items = mergeImportedIngredientCandidates(
      parseIngredientCandidatesFromBlock(ingredientLines.join("\n")),
      extractEmbeddedIngredientsFromText(
        `${!hasExplicitIngredientsHeading ? body : ""}\n${instructionLines
          .filter((line) => /:\s*(?:\d|[¼½¾]|malo\b)/i.test(line))
          .join("\n")}`
      )
    );
    items = mergeImportedIngredientCandidates(items, getImportedRecipeFallbackItems(name, body));
    if (!items.length) {
      continue;
    }

    recipes.push({
      name,
      mealLabel: inferMealLabelFromText(name),
      description: instructionLines[0] && instructionLines[0].length <= 140 ? instructionLines[0] : "",
      instructions: instructionLines.join("\n"),
      servings,
      prepTimeMinutes: (() => {
        const prepMatch = body.match(/(\d{1,3})\s*(?:min|minuta)/i);
        return prepMatch ? roundValue(parseDecimal(prepMatch[1]), 0) : 0;
      })(),
      items: items.map((item) => ({ name: item.name, displayName: item.displayName || item.name, grams: item.grams })),
    });
  }

  return {
    recommendations: [],
    foods: [],
    recipes,
  };
}

function parseMealPlanDocument(text) {
  const normalizedText = normalizeNutritionImportText(text);
  const daySections = normalizedText
    .split(/(?=^\d+\.\s*DAN\b)/im)
    .map((section) => section.trim())
    .filter(Boolean);
  const recommendations = [];
  const plans = [];

  daySections.forEach((section) => {
    const lines = section
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      return;
    }

    const dayHeaderMatch = lines[0].match(/^(\d+)\.\s*DAN\s*\(([^)]+)\)/i);
    const dayNumber = dayHeaderMatch ? parseInt(dayHeaderMatch[1], 10) : plans.length + 1;
    const weekdayLabel = dayHeaderMatch ? dayHeaderMatch[2].trim() : "";
    const dayTitle = dayHeaderMatch
      ? `${dayHeaderMatch[1]}. dan (${dayHeaderMatch[2].trim()})`
      : lines[0].replace(/\s+/g, " ").trim();
    const dayPlan = {
      dayNumber,
      weekdayLabel,
      title: dayTitle,
      meals: [],
      notes: [],
    };
    let currentMealTitle = "";
    let mealBuffer = [];
    let noteBuffer = [];

    const flushNotes = () => {
      const noteText = noteBuffer.map((line) => cleanImportLine(line)).filter(Boolean).join(" ");
      if (noteText) {
        dayPlan.notes.push(noteText);
        recommendations.push({
          title: `${dayTitle} · Napomene`,
          text: noteText,
        });
      }
      noteBuffer = [];
    };

    const flushMeal = () => {
      if (!currentMealTitle || !mealBuffer.length) {
        mealBuffer = [];
        return;
      }

      const mealText = mealBuffer.map((line) => cleanImportLine(line)).filter(Boolean).join("\n");
      dayPlan.meals.push({
        title: currentMealTitle,
        text: mealText,
      });

      mealBuffer = [];
    };

    lines.slice(1).forEach((line) => {
      const cleanLine = cleanImportLine(line);
      if (!cleanLine) {
        return;
      }

      if (/^(predlog satnice|pošto imaš|posto imas|prve dve nedelje|druge dve nedelje)/i.test(cleanLine)) {
        flushMeal();
        currentMealTitle = "";
        noteBuffer.push(cleanLine);
        return;
      }

      if (isMealHeadingLine(cleanLine)) {
        flushNotes();
        flushMeal();
        currentMealTitle = cleanLine.replace(/\s*\d{1,2}:\d{2}\s*h?$/i, "").replace(/[:.]+$/, "").trim();
        mealBuffer = [];
        return;
      }

      if (currentMealTitle) {
        mealBuffer.push(cleanLine);
      } else {
        noteBuffer.push(cleanLine);
      }
    });

    flushNotes();
    flushMeal();
    if (dayPlan.meals.length || dayPlan.notes.length) {
      plans.push(dayPlan);
    }
  });

  return {
    recommendations,
    plans,
    foods: [],
    recipes: [],
  };
}

function parseStructuredNutritionJson(text) {
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const recommendations = Array.isArray(payload.recommendations)
      ? payload.recommendations
          .map((entry) => (typeof entry === "string" ? { text: entry } : entry))
          .filter((entry) => String(entry?.text || entry?.note || "").trim())
          .map((entry) => ({
            title: String(entry.title || entry.label || entry.text || entry.note).trim().slice(0, 80),
            text: String(entry.text || entry.note || "").trim(),
          }))
      : [];

    const foods = Array.isArray(payload.foods)
      ? payload.foods
          .filter((entry) => String(entry?.name || "").trim())
          .map((entry) => ({
            name: String(entry.name || "").trim(),
            category: String(entry.category || "Nutri import").trim() || "Nutri import",
            servingBaseGrams: Math.max(1, roundValue(parseDecimal(entry.servingBaseGrams || entry.grams || 100), 0)),
            kcal: parseDecimal(entry.kcal),
            protein: parseDecimal(entry.protein),
            carbs: parseDecimal(entry.carbs),
            fat: parseDecimal(entry.fat),
          }))
      : [];

    const recipes = Array.isArray(payload.recipes)
      ? payload.recipes
          .filter((entry) => String(entry?.name || "").trim())
          .map((entry) => ({
            name: String(entry.name || "").trim(),
            mealLabel: inferMealLabelFromText(entry.mealLabel || entry.name),
            description: String(entry.description || "").trim(),
            instructions: String(entry.instructions || "").trim(),
            servings: Math.max(1, roundValue(parseDecimal(entry.servings || entry.portions || 1), 0)),
            prepTimeMinutes: Math.max(0, roundValue(parseDecimal(entry.prepTimeMinutes), 0)),
            items: Array.isArray(entry.items)
              ? entry.items
                  .filter((item) => String(item?.foodName || item?.name || "").trim())
                  .map((item) => ({
                    name: String(item.foodName || item.name || "").trim(),
                    displayName: String(item.displayName || item.foodDisplayName || item.foodName || item.name || "").trim(),
                    grams: Math.max(1, roundValue(parseDecimal(item.grams || item.amount || 0), 0)),
                  }))
              : [],
          }))
          .filter((recipe) => recipe.items.length)
      : [];

    if (!recommendations.length && !foods.length && !recipes.length) {
      return null;
    }

    return { recommendations, foods, recipes };
  } catch (error) {
    return null;
  }
}

function parseNutritionTextPayload(text) {
  const blocks = normalizeNutritionImportText(text)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const recipes = [];
  const foods = [];
  const recommendations = [];
  const consumedBlockIndexes = new Set();
  const recipeKeys = new Set();

  blocks.forEach((block, index) => {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      return;
    }

    const firstLine = cleanImportLine(lines[0]);
    const inlineMealMatch = firstLine.match(/^([^:]{2,40})\s*:\s*(.+)$/);
    const inlineIngredients = inlineMealMatch ? parseIngredientCandidatesFromBlock(inlineMealMatch[2]) : [];
    const blockIngredients = parseIngredientCandidatesFromBlock(block);
    const ingredients = inlineIngredients.length >= 2 ? inlineIngredients : blockIngredients;
    const hasRecipeSignal = /(sastojci|priprema|recept|obrok|dorucak|doručak|ručak|rucak|večera|vecera|užina|uzina|smoothie|salata|omlet|kaša|kasa)/i.test(
      block
    );

    if (ingredients.length >= 2 && (hasRecipeSignal || firstLine.length <= 56)) {
      const recipeNameBase = inlineMealMatch
        ? cleanImportLine(inlineMealMatch[1])
        : !parseIngredientCandidate(firstLine) && firstLine.length <= 56
          ? firstLine
          : "";
      const mealLabel = inferMealLabelFromText(recipeNameBase || firstLine);
      const recipeName =
        recipeNameBase ||
        `${mealLabel} ${recipes.length + 1}`;
      const prepTimeMatch = block.match(/(\d{1,3})\s*(min|minuta)/i);
      const servingsMatch = block.match(/(\d{1,2})\s*(?:porcij[aeiou]?|porcije|porcija|servings?|serving)/i);
      const instructionLines = lines.filter((line) => {
        const normalizedLine = cleanImportLine(line);
        return normalizedLine && !parseIngredientCandidate(normalizedLine) && normalizedLine !== recipeNameBase;
      });
      const recipeKey = `${normalizeLookupValue(recipeName)}::${ingredients
        .map((item) => `${normalizeLookupValue(item.name)}:${roundValue(item.grams, 0)}`)
        .sort((left, right) => left.localeCompare(right))
        .join("|")}`;

      if (!recipeKeys.has(recipeKey)) {
        recipes.push({
          name: recipeName,
          mealLabel,
          description: instructionLines[0] && instructionLines[0].length <= 140 ? cleanImportLine(instructionLines[0]) : "",
          instructions: instructionLines.join("\n"),
          servings: servingsMatch ? Math.max(1, roundValue(parseDecimal(servingsMatch[1]), 0)) : 1,
          prepTimeMinutes: prepTimeMatch ? roundValue(parseDecimal(prepTimeMatch[1]), 0) : 0,
          items: ingredients.map((item) => ({ name: item.name, grams: item.grams })),
        });
        recipeKeys.add(recipeKey);
      }
      consumedBlockIndexes.add(index);
    }

    lines.forEach((line) => {
      const food = parseFoodFromMacroLine(line);
      if (food) {
        foods.push(food);
      }
    });
  });

  blocks.forEach((block, index) => {
    if (consumedBlockIndexes.has(index)) {
      return;
    }

    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const bulletLines = lines.filter((line) => /^(?:[\u2022*•\-–—]|\d+[.)])\s*/.test(line));
    const candidates = bulletLines.length ? bulletLines : [block];

    candidates.forEach((candidate) => {
      const normalizedCandidate = cleanImportLine(candidate);
      if (!normalizedCandidate) {
        return;
      }
      if (parseIngredientCandidate(normalizedCandidate) || parseFoodFromMacroLine(normalizedCandidate)) {
        return;
      }
      if (normalizedCandidate.split(/\s+/).length < 4) {
        return;
      }
      recommendations.push({
        title: normalizedCandidate.split(/[:.]/)[0].trim().slice(0, 80),
        text: normalizedCandidate,
      });
    });
  });

  return { recommendations, foods, recipes };
}

function parseNutritionImportPayload(file, text) {
  const extension = getFileExtension(file?.name || "");
  if (extension === "json") {
    return parseStructuredNutritionJson(text) || { recommendations: [], foods: [], recipes: [] };
  }

  const documentKind = detectNutritionDocumentKind(file, text);
  if (documentKind === "recipes") {
    const parsedRecipes = parseRecipesDocument(text);
    if (parsedRecipes.recipes.length || parsedRecipes.recommendations.length || parsedRecipes.foods.length) {
      return parsedRecipes;
    }
  }

  if (documentKind === "recommendations") {
    const parsedRecommendations = parseRecommendationsDocument(text);
    if (
      parsedRecommendations.recipes.length ||
      parsedRecommendations.recommendations.length ||
      parsedRecommendations.foods.length
    ) {
      return parsedRecommendations;
    }
  }

  if (documentKind === "meal-plan") {
    const parsedMealPlan = parseMealPlanDocument(text);
    if (parsedMealPlan.recipes.length || parsedMealPlan.recommendations.length || parsedMealPlan.foods.length) {
      return parsedMealPlan;
    }
  }

  return parseNutritionTextPayload(text);
}

function buildNutritionDocumentRecord(file, text, parserLabel) {
  return {
    id: uid("nutrition-doc"),
    name: String(file.name || "Dokument"),
    type: (file.type || getFileExtension(file.name) || "text").toLowerCase(),
    parserLabel,
    size: Number(file.size) || 0,
    importedAt: new Date().toISOString(),
    excerpt: trimDocumentSnippet(text),
    recommendationCount: 0,
    foodCount: 0,
    recipeCount: 0,
    status: "Obrađeno",
  };
}

function upsertNutritionFood(foodDraft = {}, documentRecord) {
  const foodName = String(foodDraft.name || "").trim();
  if (!foodName) {
    return null;
  }

  const canonicalFoodName = canonicalizeImportedFoodName(foodName) || foodName;
  const existingFood = findFoodByExactName(canonicalFoodName) || findBestFoodMatchByName(canonicalFoodName, foodDraft.category || "");
  const isExistingBaseFood = Boolean(existingFood && existingFood.importSource !== "nutrition-import");
  const draftCategory = String(foodDraft.category || "").trim();
  const inferredCategory = inferImportedFoodCategory(canonicalFoodName, existingFood);
  const nextFoodFields = {
    name: isExistingBaseFood ? existingFood.name : canonicalFoodName,
    category:
      (draftCategory && normalizeLookupValue(draftCategory) !== "nutri import" ? draftCategory : existingFood?.category || inferredCategory) ||
      inferredCategory,
    servingBaseGrams: Math.max(1, roundValue(parseDecimal(foodDraft.servingBaseGrams || existingFood?.servingBaseGrams || 100), 0)),
    kcal: getImportValueOrFallback(foodDraft.kcal, existingFood?.kcal),
    protein: getImportValueOrFallback(foodDraft.protein, existingFood?.protein),
    carbs: getImportValueOrFallback(foodDraft.carbs, existingFood?.carbs),
    fat: getImportValueOrFallback(foodDraft.fat, existingFood?.fat),
    importSource: isExistingBaseFood ? existingFood.importSource || "" : "nutrition-import",
    importSourceDocIds: isExistingBaseFood
      ? existingFood.importSourceDocIds || []
      : mergeUniqueStrings(existingFood?.importSourceDocIds || [], [documentRecord.id]),
    importSourceDocNames: isExistingBaseFood
      ? existingFood.importSourceDocNames || []
      : mergeUniqueStrings(existingFood?.importSourceDocNames || [], [documentRecord.name]),
    updatedAt: new Date().toISOString(),
  };

  if (existingFood) {
    Object.assign(existingFood, nextFoodFields);
    return existingFood;
  }

  const nextFood = {
    id: uid("food"),
    ...nextFoodFields,
    createdAt: new Date().toISOString(),
  };
  store.foods.push(nextFood);
  return nextFood;
}

function getUniqueImportedRecipeName(baseName, documentRecord) {
  const normalizedBaseName = String(baseName || "").trim() || "Nutri recept";
  const existingRecipe = getFavoriteMealByName(normalizedBaseName);
  if (!existingRecipe) {
    return normalizedBaseName;
  }

  if (existingRecipe.importSource === "nutrition-import") {
    return normalizedBaseName;
  }

  const suffixBase = documentRecord?.name ? documentRecord.name.replace(/\.[^.]+$/, "") : "Import";
  return `${normalizedBaseName} · ${suffixBase}`;
}

function upsertNutritionRecipe(recipeDraft = {}, documentRecord) {
  const recipeName = getUniqueImportedRecipeName(recipeDraft.name, documentRecord);
  const existingRecipe = getFavoriteMealByName(recipeName);
  const items = (recipeDraft.items || [])
    .map((item) => {
      const food = upsertNutritionFood(
        {
          name: item.name,
          servingBaseGrams: 100,
        },
        documentRecord
      );
      if (!food) {
        return null;
      }

      return {
        id: uid("favorite-item"),
        foodId: food.id,
        foodName: food.name,
        displayName: String(item.displayName || item.name || food.name || "").trim(),
        grams: Math.max(1, roundValue(parseDecimal(item.grams), 0)),
      };
    })
    .filter(Boolean);

  if (!items.length) {
    return null;
  }

  const nextRecipeFields = {
    name: recipeName,
    mealLabel: normalizeMealLabel(recipeDraft.mealLabel || inferMealLabelFromText(recipeName)),
    description: String(recipeDraft.description || "").trim(),
    instructions: String(recipeDraft.instructions || "").trim(),
    servings: Math.max(1, roundValue(parseDecimal(recipeDraft.servings || recipeDraft.portions || existingRecipe?.servings || 1), 0)),
    prepTimeMinutes: Math.max(0, roundValue(parseDecimal(recipeDraft.prepTimeMinutes), 0)) || null,
    items,
    importSource: "nutrition-import",
    importSourceDocIds: mergeUniqueStrings(existingRecipe?.importSourceDocIds || [], [documentRecord.id]),
    importSourceDocNames: mergeUniqueStrings(existingRecipe?.importSourceDocNames || [], [documentRecord.name]),
    updatedAt: new Date().toISOString(),
  };

  if (existingRecipe) {
    Object.assign(existingRecipe, nextRecipeFields);
    return existingRecipe;
  }

  const nextRecipe = {
    id: uid("favorite-meal"),
    ...nextRecipeFields,
    createdAt: new Date().toISOString(),
  };
  store.favoriteMeals.unshift(nextRecipe);
  return nextRecipe;
}

function mergeNutritionImportResult(parsedResult, documentRecord) {
  const importedFoodIds = [];
  const importedRecipeIds = [];
  const importedRecommendationIds = [];
  const importedPlanIds = [];

  (parsedResult.foods || []).forEach((foodDraft) => {
    const importedFood = upsertNutritionFood(foodDraft, documentRecord);
    if (importedFood?.importSource === "nutrition-import") {
      importedFoodIds.push(importedFood.id);
    }
  });

  (parsedResult.recipes || []).forEach((recipeDraft) => {
    const importedRecipe = upsertNutritionRecipe(recipeDraft, documentRecord);
    if (importedRecipe) {
      importedRecipeIds.push(importedRecipe.id);
      importedRecipe.items.forEach((item) => {
        if (item.foodId && getFoodById(item.foodId)?.importSource === "nutrition-import") {
          importedFoodIds.push(item.foodId);
        }
      });
    }
  });

  (parsedResult.recommendations || []).forEach((entry) => {
    const recommendation = createRecommendationRecord(entry.text || entry, documentRecord);
    if (!recommendation) {
      return;
    }

    const existingRecommendation = (store.nutritionLibrary?.recommendations || []).find(
      (item) => normalizeLookupValue(item.text) === normalizeLookupValue(recommendation.text)
    );

    if (existingRecommendation) {
      existingRecommendation.sourceDocIds = mergeUniqueStrings(existingRecommendation.sourceDocIds || [], [documentRecord.id]);
      existingRecommendation.sourceDocNames = mergeUniqueStrings(
        existingRecommendation.sourceDocNames || [],
        [documentRecord.name]
      );
      importedRecommendationIds.push(existingRecommendation.id);
      return;
    }

    store.nutritionLibrary.recommendations.unshift(recommendation);
    importedRecommendationIds.push(recommendation.id);
  });

  (parsedResult.plans || []).forEach((planDraft) => {
    const nextPlan = createNutritionPlanRecord(planDraft, documentRecord);
    if (!nextPlan) {
      return;
    }

    const existingPlan = (store.nutritionLibrary?.plans || []).find(
      (item) =>
        toNumber(item.dayNumber) === toNumber(nextPlan.dayNumber) &&
        normalizeLookupValue(item.title) === normalizeLookupValue(nextPlan.title) &&
        (item.sourceDocNames || []).some((entry) => matchesImportedDocumentName(entry, documentRecord.name))
    );

    if (existingPlan) {
      Object.assign(existingPlan, nextPlan, { id: existingPlan.id });
      importedPlanIds.push(existingPlan.id);
      return;
    }

    store.nutritionLibrary.plans.unshift(nextPlan);
    importedPlanIds.push(nextPlan.id);
  });

  store.nutritionLibrary.importedFoodIds = mergeUniqueStrings(store.nutritionLibrary.importedFoodIds || [], importedFoodIds);
  store.nutritionLibrary.importedRecipeIds = mergeUniqueStrings(
    store.nutritionLibrary.importedRecipeIds || [],
    importedRecipeIds
  );
  store.nutritionLibrary.lastImportedAt = new Date().toISOString();

  return {
    importedFoodIds: mergeUniqueStrings(importedFoodIds),
    importedRecipeIds: mergeUniqueStrings(importedRecipeIds),
    importedRecommendationIds: mergeUniqueStrings(importedRecommendationIds),
    importedPlanIds: mergeUniqueStrings(importedPlanIds),
  };
}

async function importNutritionFiles(files = []) {
  const importedDocuments = [];
  const errors = [];
  let totalRecommendations = 0;
  let totalFoods = 0;
  let totalRecipes = 0;

  for (const file of files) {
    try {
      removeNutritionImportDataForDocument(file.name);
      const { text, parser } = await extractNutritionTextFromFile(file);
      if (!text) {
        throw new Error("U fajlu nema dovoljno teksta za obradu.");
      }

      const documentRecord = buildNutritionDocumentRecord(file, text, parser);
      const parsedResult = parseNutritionImportPayload(file, text);
      const mergeResult = mergeNutritionImportResult(parsedResult, documentRecord);

      documentRecord.recommendationCount = mergeResult.importedRecommendationIds.length;
      documentRecord.planCount = mergeResult.importedPlanIds.length;
      documentRecord.foodCount = mergeResult.importedFoodIds.length;
      documentRecord.recipeCount = mergeResult.importedRecipeIds.length;
      documentRecord.status =
        documentRecord.recipeCount || documentRecord.foodCount || documentRecord.recommendationCount || documentRecord.planCount
          ? "Spremno za korišćenje"
          : "Sačuvan dokument";

      store.nutritionLibrary.documents.unshift(documentRecord);
      importedDocuments.push(documentRecord);
      totalRecommendations += documentRecord.recommendationCount;
      totalFoods += documentRecord.foodCount;
      totalRecipes += documentRecord.recipeCount;
    } catch (error) {
      errors.push({
        fileName: file.name,
        message: error instanceof Error ? error.message : "Import nije uspeo.",
      });
      store.nutritionLibrary.documents.unshift({
        id: uid("nutrition-doc"),
        name: String(file.name || "Dokument"),
        type: (file.type || getFileExtension(file.name) || "file").toLowerCase(),
        parserLabel: "Greška",
        size: Number(file.size) || 0,
        importedAt: new Date().toISOString(),
        excerpt: trimDocumentSnippet(error instanceof Error ? error.message : "Import nije uspeo."),
        recommendationCount: 0,
        foodCount: 0,
        recipeCount: 0,
        status: "Import nije uspeo",
      });
    }
  }

  return {
    importedDocuments,
    totalRecommendations,
    totalFoods,
    totalRecipes,
    errors,
  };
}

function roundValue(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function formatFieldValue(field, value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "number") {
    return `${roundValue(value, 1)}${field.unit ? ` ${field.unit}` : ""}`;
  }
  return String(value);
}

function getFoods() {
  return [...store.foods].sort((a, b) => a.name.localeCompare(b.name, "sr"));
}

function getSelectableFoods() {
  return getFoods().filter((food) => !shouldHidePendingImportedFood(food));
}

function getFoodById(foodId) {
  return store.foods.find((food) => food.id === foodId);
}

function getFoodNutritionStatus(food = {}) {
  const kcal = toNumber(food.kcal);
  const protein = toNumber(food.protein);
  const carbs = toNumber(food.carbs);
  const fat = toNumber(food.fat);
  const hasKcal = kcal > 0;
  const hasAnyMacros = protein > 0 || carbs > 0 || fat > 0;
  const hasExplicitZeroNutrition = Boolean(food.nutritionZeroConfirmed);
  const estimatedKcal = hasAnyMacros ? roundValue(protein * 4 + carbs * 4 + fat * 9, 0) : 0;

  if (hasExplicitZeroNutrition && !hasKcal && !hasAnyMacros) {
    return {
      hasKcal,
      hasAnyMacros,
      displayKcal: 0,
      estimatedKcal: 0,
      isEstimatedKcal: false,
      needsAttention: false,
      statusLabel: "0 kcal potvrdeno",
      statusDetail: "Vrednosti su sacuvane kao nula na 100 g.",
      tone: "success",
    };
  }

  if (!hasKcal && !hasAnyMacros) {
    return {
      hasKcal,
      hasAnyMacros,
      displayKcal: 0,
      estimatedKcal,
      isEstimatedKcal: false,
      needsAttention: true,
      statusLabel: "Fale vrednosti",
      statusDetail: "Dodaj kcal ili makroe da namirnica bude upotrebljiva u planu.",
      tone: "warning",
    };
  }

  if (!hasAnyMacros) {
    return {
      hasKcal,
      hasAnyMacros,
      displayKcal: roundValue(kcal, 0),
      estimatedKcal,
      isEstimatedKcal: false,
      needsAttention: true,
      statusLabel: "Samo kcal",
      statusDetail: "Dodaj i P/UH/M kad ih nađeš, da plan i recepti budu precizniji.",
      tone: "warning",
    };
  }

  if (!hasKcal) {
    return {
      hasKcal,
      hasAnyMacros,
      displayKcal: estimatedKcal,
      estimatedKcal,
      isEstimatedKcal: true,
      needsAttention: false,
      statusLabel: "Kcal procena",
      statusDetail: `Koristim ${estimatedKcal} kcal iz upisanih makroa.`,
      tone: "info",
    };
  }

  return {
    hasKcal,
    hasAnyMacros,
    displayKcal: roundValue(kcal, 0),
    estimatedKcal,
    isEstimatedKcal: false,
    needsAttention: false,
    statusLabel: "Kompletno",
    statusDetail: "Kcal i makroi su sačuvani na 100 g.",
    tone: "success",
  };
}

function shouldHidePendingImportedFood(food = {}) {
  return food.importSource === "nutrition-import" && getFoodNutritionStatus(food).needsAttention;
}

function getImportedFoodLinkCandidates(importedFood) {
  if (!importedFood?.id) {
    return [];
  }

  const importedCanonicalName = normalizeLookupValue(canonicalizeImportedFoodName(importedFood.name) || importedFood.name);

  return getSelectableFoods()
    .filter((food) => food.id !== importedFood.id)
    .sort((left, right) => {
      const scoreCandidate = (food) => {
        const canonicalName = normalizeLookupValue(canonicalizeImportedFoodName(food.name) || food.name);
        const hasNutrition = Number(toNumber(food.kcal) > 0 || toNumber(food.protein) > 0 || toNumber(food.carbs) > 0 || toNumber(food.fat) > 0);
        const exactCanonicalMatch = Number(Boolean(importedCanonicalName) && canonicalName === importedCanonicalName);
        const partialCanonicalMatch = Number(
          Boolean(importedCanonicalName) &&
            canonicalName &&
            importedCanonicalName !== canonicalName &&
            (canonicalName.includes(importedCanonicalName) || importedCanonicalName.includes(canonicalName))
        );
        const sameCategory = Number(String(food.category || "").trim() === String(importedFood.category || "").trim());
        const isBaseFood = Number(food.importSource !== "nutrition-import");

        return exactCanonicalMatch * 100 + partialCanonicalMatch * 40 + hasNutrition * 20 + sameCategory * 5 + isBaseFood * 3;
      };

      return scoreCandidate(right) - scoreCandidate(left) || String(left.name || "").localeCompare(String(right.name || ""), "sr");
    });
}

function getImportedFoodSuggestedLink(importedFood) {
  const [suggestedFood] = getImportedFoodLinkCandidates(importedFood);
  if (!suggestedFood) {
    return null;
  }

  const importedCanonicalName = normalizeLookupValue(canonicalizeImportedFoodName(importedFood.name) || importedFood.name);
  const suggestedCanonicalName = normalizeLookupValue(canonicalizeImportedFoodName(suggestedFood.name) || suggestedFood.name);
  const hasNutrition = toNumber(suggestedFood.kcal) > 0 || toNumber(suggestedFood.protein) > 0 || toNumber(suggestedFood.carbs) > 0 || toNumber(suggestedFood.fat) > 0;
  const exactCanonicalMatch = Boolean(importedCanonicalName) && importedCanonicalName === suggestedCanonicalName;
  const partialCanonicalMatch =
    Boolean(importedCanonicalName) &&
    Boolean(suggestedCanonicalName) &&
    importedCanonicalName !== suggestedCanonicalName &&
    (suggestedCanonicalName.includes(importedCanonicalName) || importedCanonicalName.includes(suggestedCanonicalName));

  if (!(hasNutrition && (exactCanonicalMatch || partialCanonicalMatch))) {
    return null;
  }

  return suggestedFood;
}

function resetFoodEditing() {
  state.editingFoodId = "";
  state.nutritionEditingFoodId = "";
}

function resetRoutineEditing() {
  state.editingHabitId = "";
  state.editingTaskId = "";
}

function syncFoodNameAcrossStore(foodId, foodName) {
  syncFoodNameAcrossCollections(store, foodId, foodName);
}

function syncFoodNameAcrossCollections(targetStore, foodId, foodName) {
  targetStore.weeklyPlanEntries = (targetStore.weeklyPlanEntries || []).map((entry) =>
    entry.foodId === foodId
      ? {
          ...entry,
          foodName,
        }
      : entry
  );

  targetStore.favoriteMeals = (targetStore.favoriteMeals || []).map((favorite) => ({
    ...favorite,
    items: (favorite.items || []).map((item) =>
      item.foodId === foodId
        ? {
            ...item,
            foodName,
          }
        : item
    ),
  }));
}

function syncFoodReferenceAcrossCollections(targetStore, fromFoodId, nextFoodId, nextFoodName) {
  if (!fromFoodId || !nextFoodId) {
    return;
  }

  targetStore.weeklyPlanEntries = (targetStore.weeklyPlanEntries || []).map((entry) =>
    entry.foodId === fromFoodId
      ? {
          ...entry,
          foodId: nextFoodId,
          foodName: nextFoodName,
        }
      : entry
  );

  targetStore.favoriteMeals = (targetStore.favoriteMeals || []).map((favorite) => ({
    ...favorite,
    items: (favorite.items || []).map((item) =>
      item.foodId === fromFoodId
        ? {
            ...item,
            foodId: nextFoodId,
            foodName: nextFoodName,
          }
        : item
    ),
  }));

  targetStore.favoriteFoods = mergeUniqueStrings(
    (targetStore.favoriteFoods || []).map((foodId) => (foodId === fromFoodId ? nextFoodId : foodId)).filter(Boolean)
  );
}

function linkImportedFoodToExisting(targetStore, importedFoodId, existingFoodId) {
  const importedFood = (targetStore.foods || []).find((food) => food.id === importedFoodId);
  const existingFood = (targetStore.foods || []).find((food) => food.id === existingFoodId);
  if (!importedFood || !existingFood || importedFood.id === existingFood.id) {
    return null;
  }

  mergeNutritionFoodData(existingFood, importedFood);
  syncFoodReferenceAcrossCollections(targetStore, importedFood.id, existingFood.id, existingFood.name);

  targetStore.foods = (targetStore.foods || []).filter((food) => food.id !== importedFood.id);
  targetStore.favoriteFoods = mergeUniqueStrings((targetStore.favoriteFoods || []).filter((foodId) => foodId !== importedFood.id));
  targetStore.nutritionLibrary.importedFoodIds = mergeUniqueStrings(
    (targetStore.foods || []).filter((food) => food.importSource === "nutrition-import").map((food) => food.id)
  );

  return existingFood;
}

function promoteImportedFoodToLibrary(targetStore, importedFoodId) {
  const importedFood = (targetStore.foods || []).find((food) => food.id === importedFoodId);
  if (!importedFood) {
    return null;
  }

  if (importedFood.importSource === "nutrition-import") {
    importedFood.importSource = "";
    importedFood.importSourceDocIds = [];
    importedFood.importSourceDocNames = [];
  }

  targetStore.nutritionLibrary.importedFoodIds = mergeUniqueStrings(
    (targetStore.nutritionLibrary.importedFoodIds || []).filter((foodId) => foodId !== importedFood.id)
  );

  return importedFood;
}

function dismissImportedFoodReview(targetStore, importedFoodId) {
  const importedFood = (targetStore.foods || []).find((food) => food.id === importedFoodId);
  if (!importedFood) {
    return { status: "missing" };
  }

  const exactExistingFood = findFoodByExactName(importedFood.name);
  if (exactExistingFood && exactExistingFood.id !== importedFood.id) {
    const linkedFood = linkImportedFoodToExisting(targetStore, importedFood.id, exactExistingFood.id);
    return linkedFood ? { status: "linked", linkedFood } : { status: "missing" };
  }

  const isReferenced =
    (targetStore.weeklyPlanEntries || []).some((entry) => entry.foodId === importedFood.id) ||
    (targetStore.favoriteMeals || []).some((favorite) => (favorite.items || []).some((item) => item.foodId === importedFood.id)) ||
    (targetStore.favoriteFoods || []).includes(importedFood.id);

  if (isReferenced) {
    return { status: "blocked" };
  }

  targetStore.foods = (targetStore.foods || []).filter((food) => food.id !== importedFood.id);
  targetStore.favoriteFoods = mergeUniqueStrings((targetStore.favoriteFoods || []).filter((foodId) => foodId !== importedFood.id));
  targetStore.nutritionLibrary.importedFoodIds = mergeUniqueStrings(
    (targetStore.foods || []).filter((food) => food.importSource === "nutrition-import").map((food) => food.id)
  );

  return { status: "deleted" };
}

function mergeNutritionFoodData(targetFood, sourceFood) {
  if (!(toNumber(targetFood.kcal) > 0) && toNumber(sourceFood.kcal) > 0) {
    targetFood.kcal = roundValue(toNumber(sourceFood.kcal), 1);
  }
  if (!(toNumber(targetFood.protein) > 0) && toNumber(sourceFood.protein) > 0) {
    targetFood.protein = roundValue(toNumber(sourceFood.protein), 1);
  }
  if (!(toNumber(targetFood.carbs) > 0) && toNumber(sourceFood.carbs) > 0) {
    targetFood.carbs = roundValue(toNumber(sourceFood.carbs), 1);
  }
  if (!(toNumber(targetFood.fat) > 0) && toNumber(sourceFood.fat) > 0) {
    targetFood.fat = roundValue(toNumber(sourceFood.fat), 1);
  }
  if (!(toNumber(targetFood.servingBaseGrams) > 0) && toNumber(sourceFood.servingBaseGrams) > 0) {
    targetFood.servingBaseGrams = Math.max(1, roundValue(toNumber(sourceFood.servingBaseGrams), 0));
  }
  if (!String(targetFood.nutritionSource || "").trim() && String(sourceFood.nutritionSource || "").trim()) {
    targetFood.nutritionSource = String(sourceFood.nutritionSource).trim();
  }

  targetFood.importSourceDocIds = mergeUniqueStrings(targetFood.importSourceDocIds || [], sourceFood.importSourceDocIds || []);
  targetFood.importSourceDocNames = mergeUniqueStrings(
    targetFood.importSourceDocNames || [],
    sourceFood.importSourceDocNames || []
  );
}

function scoreFoodForNutritionCleanup(food = {}) {
  return (
    Number(toNumber(food.kcal) > 0) * 4 +
    Number(toNumber(food.protein) > 0) +
    Number(toNumber(food.carbs) > 0) +
    Number(toNumber(food.fat) > 0) +
    Number(Boolean(String(food.nutritionSource || "").trim())) * 2 +
    (Array.isArray(food.importSourceDocNames) ? food.importSourceDocNames.length : 0) * 0.1
  );
}

function cleanupNutritionImportedFoods(targetStore = store) {
  const importedFoods = (targetStore.foods || []).filter((food) => food.importSource === "nutrition-import");
  if (!importedFoods.length) {
    return false;
  }

  const baseFoodsByCanonicalName = new Map();
  (targetStore.foods || []).forEach((food) => {
    if (food.importSource === "nutrition-import") {
      return;
    }

    const canonicalName = canonicalizeImportedFoodName(food.name) || food.name;
    const canonicalKey = normalizeLookupValue(canonicalName);
    if (canonicalKey && !baseFoodsByCanonicalName.has(canonicalKey)) {
      baseFoodsByCanonicalName.set(canonicalKey, food);
    }
  });

  const importedByCanonicalName = new Map();
  const removedFoodIds = new Set();
  let didChange = false;

  importedFoods
    .sort((left, right) => scoreFoodForNutritionCleanup(right) - scoreFoodForNutritionCleanup(left))
    .forEach((food) => {
      const canonicalName = canonicalizeImportedFoodName(food.name) || food.name;
      const canonicalKey = normalizeLookupValue(canonicalName);
      const inferredCategory = inferImportedFoodCategory(canonicalName, food);

      if (food.name !== canonicalName) {
        food.name = canonicalName;
        didChange = true;
      }

      if (String(food.category || "").trim() !== inferredCategory) {
        food.category = inferredCategory;
        didChange = true;
      }

      syncFoodNameAcrossCollections(targetStore, food.id, food.name);

      const matchingBaseFood = canonicalKey ? baseFoodsByCanonicalName.get(canonicalKey) : null;
      if (matchingBaseFood) {
        syncFoodReferenceAcrossCollections(targetStore, food.id, matchingBaseFood.id, matchingBaseFood.name);
        removedFoodIds.add(food.id);
        didChange = true;
        return;
      }

      if (!canonicalKey) {
        return;
      }

      const keeper = importedByCanonicalName.get(canonicalKey);
      if (!keeper) {
        importedByCanonicalName.set(canonicalKey, food);
        return;
      }

      mergeNutritionFoodData(keeper, food);
      syncFoodReferenceAcrossCollections(targetStore, food.id, keeper.id, keeper.name);
      removedFoodIds.add(food.id);
      didChange = true;
    });

  if (removedFoodIds.size) {
    targetStore.foods = (targetStore.foods || []).filter((food) => !removedFoodIds.has(food.id));
  }

  targetStore.favoriteFoods = mergeUniqueStrings((targetStore.favoriteFoods || []).filter((foodId) => !removedFoodIds.has(foodId)));
  targetStore.nutritionLibrary.importedFoodIds = mergeUniqueStrings(
    (targetStore.foods || []).filter((food) => food.importSource === "nutrition-import").map((food) => food.id)
  );

  return didChange;
}

function getFoodMacroGroup(food) {
  const category = String(food.category || "").toLowerCase();
  if (category.includes("protein")) {
    return "Proteini";
  }
  if (category.includes("mast")) {
    return "Masti";
  }
  if (category.includes("uh") || category.includes("ugljeni")) {
    return "UH";
  }

  const macros = [
    { key: "protein", label: "Proteini", value: toNumber(food.protein) },
    { key: "carbs", label: "UH", value: toNumber(food.carbs) },
    { key: "fat", label: "Masti", value: toNumber(food.fat) },
  ].sort((a, b) => b.value - a.value);

  if (!macros[0] || macros[0].value <= 0) {
    return "Ostalo";
  }

  return macros[0].label;
}

function calculateEntry(food, grams) {
  const ratio = grams / (food.servingBaseGrams || 100);
  return {
    kcal: roundValue(food.kcal * ratio, 1),
    protein: roundValue(food.protein * ratio, 1),
    carbs: roundValue(food.carbs * ratio, 1),
    fat: roundValue(food.fat * ratio, 1),
  };
}

function getRecipeServingCount(recipe = {}) {
  return Math.max(1, roundValue(toNumber(recipe.servings || recipe.portions || 1), 0)) || 1;
}

function divideTotals(totals = {}, divisor = 1) {
  const safeDivisor = Math.max(1, toNumber(divisor) || 1);
  return {
    kcal: roundValue(toNumber(totals.kcal) / safeDivisor, 1),
    protein: roundValue(toNumber(totals.protein) / safeDivisor, 1),
    carbs: roundValue(toNumber(totals.carbs) / safeDivisor, 1),
    fat: roundValue(toNumber(totals.fat) / safeDivisor, 1),
  };
}

function getPlanEntriesForDay(weekday) {
  return store.weeklyPlanEntries
    .filter((entry) => entry.weekday === weekday)
    .map((entry) => {
      const food = getFoodById(entry.foodId) || store.foods.find((item) => item.name === entry.foodName);
      const totals = food ? calculateEntry(food, entry.grams) : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      return {
        ...entry,
        mealLabel: normalizeMealLabel(entry.mealLabel),
        done: Boolean(entry.done),
        food,
        totals,
      };
    });
}

function groupEntriesByMeal(entries) {
  const meals = new Map();

  entries.forEach((entry) => {
    if (!meals.has(entry.mealLabel)) {
      meals.set(entry.mealLabel, []);
    }
    meals.get(entry.mealLabel).push(entry);
  });

  return [...meals.entries()].sort((a, b) => a[0].localeCompare(b[0], "sr"));
}

function getDayTotals(entries) {
  return entries.reduce(
    (acc, entry) => {
      acc.kcal += entry.totals.kcal;
      acc.protein += entry.totals.protein;
      acc.carbs += entry.totals.carbs;
      acc.fat += entry.totals.fat;
      return acc;
    },
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
}

function getWeeklySummary() {
  return WEEKDAYS.map((weekday) => {
    const entries = getPlanEntriesForDay(weekday);
    return {
      weekday,
      totals: getDayTotals(entries),
      count: entries.length,
    };
  });
}

function getWeeklyOverview() {
  const days = getWeeklySummary().map((day) => {
    const trainingBurn = getTrainingBurnForDay(day.weekday);
    return {
      ...day,
      trainingBurn,
      netKcal: roundValue(day.totals.kcal - trainingBurn, 0),
      goalDelta: roundValue(day.totals.kcal - (store.goals.calories || 0), 0),
    };
  });

  const totals = days.reduce(
    (acc, day) => {
      acc.kcal += day.totals.kcal;
      acc.protein += day.totals.protein;
      acc.carbs += day.totals.carbs;
      acc.fat += day.totals.fat;
      acc.trainingBurn += day.trainingBurn;
      acc.count += day.count;
      return acc;
    },
    { kcal: 0, protein: 0, carbs: 0, fat: 0, trainingBurn: 0, count: 0 }
  );

  const goals = {
    kcal: (store.goals.calories || 0) * WEEKDAYS.length,
    protein: (store.goals.protein || 0) * WEEKDAYS.length,
    carbs: (store.goals.carbs || 0) * WEEKDAYS.length,
    fat: (store.goals.fat || 0) * WEEKDAYS.length,
  };

  return {
    days,
    totals,
    goals,
    netKcal: roundValue(totals.kcal - totals.trainingBurn, 0),
  };
}

function getTrainingForDay(weekday) {
  return store.trainingTemplates.filter((template) => template.weekday === weekday);
}

function getTrainingBurnForDay(weekday) {
  return toNumber(store.trainingBurnByWeekday?.[weekday]);
}

function getHabits() {
  return [...store.habits].sort((a, b) => a.name.localeCompare(b.name, "sr"));
}

function getWeeklyHabits() {
  return getHabits().filter((habit) => habit.trackingMode !== "streak");
}

function getStreakHabits() {
  return getHabits().filter((habit) => habit.trackingMode === "streak");
}

function getTasksForDay(weekday) {
  return store.dayTasks
    .filter((task) => task.weekday === weekday)
    .sort((a, b) => {
      if (a.done === b.done) {
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      }
      return Number(a.done) - Number(b.done);
    });
}

function getSupplementTimingLabel(timingId) {
  return SUPPLEMENT_TIMINGS.find((entry) => entry.id === timingId)?.label || "Kad ti odgovara";
}

function getSupplements() {
  const timingOrder = new Map(SUPPLEMENT_TIMINGS.map((entry, index) => [entry.id, index]));
  return [...store.supplements].sort((a, b) => {
    const timingDiff = (timingOrder.get(a.timing) ?? 99) - (timingOrder.get(b.timing) ?? 99);
    if (timingDiff !== 0) {
      return timingDiff;
    }
    return a.name.localeCompare(b.name, "sr");
  });
}

function isSupplementScheduledForDay(supplement, weekday) {
  const weekdays = Array.isArray(supplement?.weekdays) && supplement.weekdays.length ? supplement.weekdays : WEEKDAYS;
  return weekdays.includes(weekday);
}

function isSupplementDoneForDay(supplement, weekday) {
  return Boolean(supplement?.completions?.[weekday]);
}

function getSupplementsForDay(weekday) {
  return getSupplements().filter((supplement) => isSupplementScheduledForDay(supplement, weekday));
}

function getBmrEstimate(profile = store.profile) {
  const weightKg = toNumber(profile.weightKg);
  const heightCm = toNumber(profile.heightCm);
  const age = toNumber(profile.age);
  const sex = String(profile.sex || "").trim();

  if (!weightKg || !heightCm || !age || !sex) {
    return null;
  }

  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return roundValue(base + (sex === "female" ? -161 : 5), 0);
}

function getGoalRecommendation(profile = store.profile, goals = store.goals) {
  const bmr = getBmrEstimate(profile);
  if (!bmr) {
    return null;
  }

  const activity = ACTIVITY_LEVELS.find((entry) => entry.id === profile.activityLevel) || ACTIVITY_LEVELS[2];
  const goalMode = GOAL_MODES.find((entry) => entry.id === goals.targetMode) || GOAL_MODES[0];
  const weightKg = Math.max(0, toNumber(profile.weightKg));
  const maintenance = roundValue(bmr * activity.multiplier, 0);
  const targetCalories = roundValue(maintenance * goalMode.calorieFactor, 0);
  const protein = roundValue(weightKg * goalMode.proteinFactor, 1);
  const fat = roundValue(weightKg * goalMode.fatFactor, 1);
  const remainingCalories = Math.max(0, targetCalories - protein * 4 - fat * 9);
  const carbs = roundValue(remainingCalories / 4, 1);

  return {
    bmr,
    maintenance,
    targetCalories,
    protein,
    fat,
    carbs,
    activity,
    goalMode,
  };
}

function isHabitDoneForDay(habit, weekday) {
  return Boolean(habit?.completions?.[weekday]);
}

function getHabitWeeklyCount(habit) {
  return WEEKDAYS.reduce((count, weekday) => count + (isHabitDoneForDay(habit, weekday) ? 1 : 0), 0);
}

function getDateValueAsLocalDate(dateValue) {
  if (!dateValue) {
    return null;
  }

  const [year, month, day] = String(dateValue)
    .split("-")
    .map((part) => Number(part));
  if (!year || !month || !day) {
    return null;
  }

  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDayCountLabel(value) {
  const days = Math.max(0, Number(value) || 0);
  return `${days} ${days === 1 ? "dan" : "dana"}`;
}

function getHabitCurrentStreakDays(habit, referenceDateValue = getTodayDateValue()) {
  if (habit?.trackingMode !== "streak") {
    return 0;
  }

  const startDate = getDateValueAsLocalDate(normalizeDateValue(habit.streakStartDate) || referenceDateValue);
  const referenceDate = getDateValueAsLocalDate(normalizeDateValue(referenceDateValue) || getTodayDateValue());
  if (!startDate || !referenceDate) {
    return 0;
  }

  const diffInDays = Math.floor((referenceDate.getTime() - startDate.getTime()) / DAY_IN_MS);
  return Math.max(1, diffInDays + 1);
}

function getHabitBestStreakDays(habit) {
  return Math.max(Math.max(0, toNumber(habit?.bestStreakDays)), getHabitCurrentStreakDays(habit));
}

function formatDateValueLabel(dateValue) {
  const parsedDate = getDateValueAsLocalDate(normalizeDateValue(dateValue));
  if (!parsedDate) {
    return "";
  }

  return parsedDate.toLocaleDateString("sr-RS", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function getHabitStreakSentence(habit) {
  const currentStreakDays = getHabitCurrentStreakDays(habit);
  const habitLabel = String(habit?.name || "").trim();
  if (!habitLabel) {
    return getDayCountLabel(currentStreakDays);
  }

  const normalizedLabel = `${habitLabel.charAt(0).toLowerCase()}${habitLabel.slice(1)}`;
  return `${getDayCountLabel(currentStreakDays)} ${normalizedLabel}`;
}

function getRoutineSummaryForDay(weekday) {
  const habits = getWeeklyHabits();
  const streakHabits = getStreakHabits();
  const tasks = getTasksForDay(weekday);
  const doneHabits = habits.filter((habit) => isHabitDoneForDay(habit, weekday)).length;
  const doneTasks = tasks.filter((task) => task.done).length;
  const totalItems = habits.length + tasks.length;
  const doneItems = doneHabits + doneTasks;
  const longestStreakDays = streakHabits.reduce(
    (maxStreak, habit) => Math.max(maxStreak, getHabitCurrentStreakDays(habit)),
    0
  );

  return {
    habits,
    streakHabits,
    tasks,
    doneHabits,
    doneTasks,
    totalItems,
    doneItems,
    longestStreakDays,
    progress: totalItems ? roundValue((doneItems / totalItems) * 100, 0) : 0,
  };
}

function getTodayDateValue() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

function getWeeklyTrainingPlan() {
  return WEEKDAYS.map((weekday) => ({
    weekday,
    templates: getTrainingForDay(weekday),
    trainingBurn: getTrainingBurnForDay(weekday),
    progressCount: store.trainingProgressLogs.filter((log) => log.weekday === weekday).length,
  }));
}

function getFavoriteTrainingsDetailed() {
  return [...store.favoriteTrainings]
    .map((training) => ({
      ...training,
      exerciseCount: Array.isArray(training.exercises) ? training.exercises.length : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "sr"));
}

function getTrainingExerciseOptions() {
  const names = new Set();

  store.trainingTemplates.forEach((template) => {
    template.exercises.forEach((exercise) => {
      if (exercise.name) {
        names.add(exercise.name.trim());
      }
    });
  });

  store.trainingProgressLogs.forEach((log) => {
    if (log.exerciseName) {
      names.add(log.exerciseName.trim());
    }
  });

  store.favoriteTrainings.forEach((training) => {
    training.exercises.forEach((exercise) => {
      if (exercise.name) {
        names.add(exercise.name.trim());
      }
    });
  });

  return [...names].sort((a, b) => a.localeCompare(b, "sr"));
}

function getTrainingProgressGroups() {
  const groups = new Map();

  [...store.trainingProgressLogs]
    .sort((a, b) => {
      const dateDiff = new Date(a.date) - new Date(b.date);
      if (dateDiff !== 0) {
        return dateDiff;
      }
      return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    })
    .forEach((log) => {
      const exerciseName = String(log.exerciseName || "").trim();
      if (!exerciseName) {
        return;
      }

      const key = exerciseName.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, {
          exerciseName,
          logs: [],
        });
      }

      groups.get(key).logs.push(log);
    });

  return [...groups.values()]
    .map((group) => {
      const logs = group.logs;
      const latest = logs[logs.length - 1];
      const first = logs[0];
      const best = logs.reduce((highest, log) => (log.weightKg > highest.weightKg ? log : highest), logs[0]);

      return {
        ...group,
        logs,
        latest,
        first,
        best,
        delta: roundValue(latest.weightKg - first.weightKg, 1),
      };
    })
    .sort((a, b) => new Date(b.latest.date) - new Date(a.latest.date));
}

function getFavoriteMealsDetailed() {
  return [...store.favoriteMeals]
    .map((favorite) => {
      const normalizedFavorite = normalizeFavoriteMealRecord(favorite);
      const servings = getRecipeServingCount(normalizedFavorite);
      const items = (normalizedFavorite.items || []).map((item) => {
        const fallbackFoodName = item.foodName || item.displayName || "";
        const food =
          getFoodById(item.foodId) ||
          findFoodByExactName(fallbackFoodName) ||
          findBestFoodMatchByName(fallbackFoodName) ||
          store.foods.find((entry) => entry.name === item.foodName);
        const totals = food ? calculateEntry(food, item.grams) : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
        return {
          ...item,
          food,
          totals,
        };
      });
      const totals = getDayTotals(items);

      return {
        ...normalizedFavorite,
        servings,
        items,
        totals,
        perServingTotals: divideTotals(totals, servings),
        totalWeightGrams: roundValue(items.reduce((sum, item) => sum + toNumber(item.grams), 0), 1),
      };
    })
    .sort((a, b) => {
      const dateDiff = new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
      if (dateDiff !== 0) {
        return dateDiff;
      }
      return a.name.localeCompare(b.name, "sr");
    });
}

function getFavoriteMealByName(name) {
  const normalizedName = String(name || "").trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }
  return store.favoriteMeals.find((favorite) => String(favorite.name || "").trim().toLowerCase() === normalizedName) || null;
}

function buildRecipeSignature(items = []) {
  return [...items]
    .map((item) => `${item.foodId || item.foodName}:${roundValue(item.grams, 0)}`)
    .sort((a, b) => a.localeCompare(b, "sr"))
    .join("|");
}

function getRecipeMatchState(favorite, mealEntries = []) {
  if (!mealEntries.length) {
    return {
      label: "Spremno za ubacivanje",
      tone: "info",
      mode: "append",
      actionLabel: "Ubaci u plan",
    };
  }

  const currentSignature = buildRecipeSignature(mealEntries);
  const favoriteSignature = buildRecipeSignature(favorite.items);
  if (currentSignature && currentSignature === favoriteSignature) {
    return {
      label: "Već je u planu",
      tone: "success",
      mode: "append",
      actionLabel: "Ubaci opet",
    };
  }

  return {
    label: "Može kao zamena",
    tone: "warning",
    mode: "replace",
    actionLabel: "Zameni obrok",
  };
}

function getRecipesForMealLabel(mealLabel, favorites = getFavoriteMealsDetailed()) {
  const normalizedMealLabel = normalizeMealLabel(mealLabel);
  return favorites.filter((favorite) => normalizeMealLabel(favorite.mealLabel || favorite.name) === normalizedMealLabel);
}

function getFavoriteFoodsDetailed() {
  return store.favoriteFoods
    .map((foodId) => getFoodById(foodId))
    .filter(Boolean)
    .map((food) => ({
      ...food,
      macroGroup: getFoodMacroGroup(food),
    }));
}

function resetFavoriteDraft(options = {}) {
  const { preserveRecipeMeta = false } = options;
  const preservedDraft = preserveRecipeMeta
    ? {
        favoriteName: state.favoriteDraft.favoriteName,
        mealLabel: state.favoriteDraft.mealLabel,
        description: state.favoriteDraft.description,
        servings: state.favoriteDraft.servings,
        prepTimeMinutes: state.favoriteDraft.prepTimeMinutes,
        instructions: state.favoriteDraft.instructions,
      }
    : null;

  state.editingFavoriteItem = {
    favoriteId: "",
    itemId: "",
    itemIndex: -1,
  };
  state.favoriteDraft = {
    favoriteName: preservedDraft?.favoriteName || "",
    mealLabel: preservedDraft?.mealLabel || "",
    description: preservedDraft?.description || "",
    servings: preservedDraft?.servings || "1",
    prepTimeMinutes: preservedDraft?.prepTimeMinutes || "",
    instructions: preservedDraft?.instructions || "",
    foodId: "",
    grams: "",
  };
}

function setFavoriteDraftFromItem(favorite, item) {
  const normalizedFavorite = normalizeFavoriteMealRecord(favorite);
  state.editingFavoriteItem = {
    favoriteId: favorite.id,
    itemId: item.id || "",
    itemIndex: favorite.items.findIndex((entry) => entry === item),
  };
  state.favoriteDraft = {
    favoriteName: normalizedFavorite.name || "",
    mealLabel: normalizedFavorite.mealLabel || "",
    description: normalizedFavorite.description || "",
    servings: String(normalizedFavorite.servings || 1),
    prepTimeMinutes: normalizedFavorite.prepTimeMinutes ? String(normalizedFavorite.prepTimeMinutes) : "",
    instructions: normalizedFavorite.instructions || "",
    foodId: item.foodId || "",
    grams: item.grams ? String(roundValue(item.grams, 0)) : "",
  };
}

function setFavoriteDraftFromRecipe(favorite) {
  const normalizedFavorite = normalizeFavoriteMealRecord(favorite);
  const firstItem = normalizedFavorite.items?.[0] || null;

  if (firstItem) {
    setFavoriteDraftFromItem(normalizedFavorite, firstItem);
    return;
  }

  state.favoriteDraft = {
    favoriteName: normalizedFavorite.name || "",
    mealLabel: normalizedFavorite.mealLabel || "",
    description: normalizedFavorite.description || "",
    servings: String(normalizedFavorite.servings || 1),
    prepTimeMinutes: normalizedFavorite.prepTimeMinutes ? String(normalizedFavorite.prepTimeMinutes) : "",
    instructions: normalizedFavorite.instructions || "",
    foodId: "",
    grams: "",
  };
  state.editingFavoriteItem = { favoriteId: favorite.id, itemId: "", itemIndex: -1 };
}

function getFavoriteDraftPreview() {
  const favoriteName = String(state.favoriteDraft.favoriteName || "").trim();
  const mealLabel = String(state.favoriteDraft.mealLabel || "").trim();
  const hasDraftDescription = state.favoriteDraft.description !== "";
  const hasDraftInstructions = state.favoriteDraft.instructions !== "";
  const hasDraftServings = state.favoriteDraft.servings !== "";
  const hasDraftPrepTime = state.favoriteDraft.prepTimeMinutes !== "";
  const description = String(state.favoriteDraft.description || "").trim();
  const instructions = String(state.favoriteDraft.instructions || "").trim();
  const servings = Math.max(1, roundValue(toNumber(state.favoriteDraft.servings || 1), 0)) || 1;
  const prepTimeMinutes = toNumber(state.favoriteDraft.prepTimeMinutes);
  const food = getFoodById(state.favoriteDraft.foodId);
  const grams = toNumber(state.favoriteDraft.grams);
  const existingFavorite = state.editingFavoriteItem.favoriteId
    ? store.favoriteMeals.find((entry) => entry.id === state.editingFavoriteItem.favoriteId)
    : getFavoriteMealByName(favoriteName);

  let items = existingFavorite
    ? existingFavorite.items.map((item) => ({
        ...item,
        totals: calculateEntry(getFoodById(item.foodId) || { kcal: 0, protein: 0, carbs: 0, fat: 0, servingBaseGrams: 100 }, item.grams),
        isPending: false,
      }))
    : [];

  if (state.editingFavoriteItem.favoriteId && existingFavorite) {
    items = items.filter((_, index) => index !== state.editingFavoriteItem.itemIndex);
  }

  if (food && grams) {
    items = [
      ...items,
      {
        id: "pending",
        foodId: food.id,
        foodName: food.name,
        grams,
        totals: calculateEntry(food, grams),
        isPending: true,
      },
    ];
  }

  const totals = getDayTotals(items.map((item) => ({ totals: item.totals })));
  const effectiveServings = hasDraftServings ? servings : existingFavorite?.servings || 1;

  return {
    favoriteName,
    mealLabel: mealLabel || existingFavorite?.mealLabel || "",
    description: hasDraftDescription ? description : existingFavorite?.description || "",
    instructions: hasDraftInstructions ? instructions : existingFavorite?.instructions || "",
    servings: effectiveServings,
    prepTimeMinutes: hasDraftPrepTime ? (prepTimeMinutes || null) : existingFavorite?.prepTimeMinutes || null,
    items,
    totals,
    perServingTotals: divideTotals(totals, effectiveServings),
  };
}

function saveFavoriteMealMetadata(payload = {}) {
  const normalizedFavoriteName = String(payload.favoriteName || "").trim();
  const normalizedMealLabel = normalizeMealLabel(String(payload.mealLabel || "").trim());
  const normalizedDescription = String(payload.description || "").trim();
  const normalizedInstructions = String(payload.instructions || "").trim();
  const normalizedServings = Math.max(1, roundValue(toNumber(payload.servings || 1), 0)) || 1;
  const normalizedPrepTimeMinutes = toNumber(payload.prepTimeMinutes);

  if (!normalizedFavoriteName || !normalizedMealLabel) {
    return null;
  }

  const recipeDetails = {
    name: normalizedFavoriteName,
    mealLabel: normalizedMealLabel,
    description: normalizedDescription,
    instructions: normalizedInstructions,
    servings: normalizedServings,
    prepTimeMinutes: normalizedPrepTimeMinutes > 0 ? roundValue(normalizedPrepTimeMinutes, 0) : null,
    updatedAt: new Date().toISOString(),
  };

  const existingFavorite = state.editingFavoriteItem.favoriteId
    ? store.favoriteMeals.find((entry) => entry.id === state.editingFavoriteItem.favoriteId)
    : getFavoriteMealByName(normalizedFavoriteName);

  if (existingFavorite) {
    Object.assign(existingFavorite, recipeDetails);
    if (!Array.isArray(existingFavorite.items)) {
      existingFavorite.items = [];
    }
    return existingFavorite;
  }

  const nextFavorite = {
    id: uid("favorite-meal"),
    ...recipeDetails,
    createdAt: new Date().toISOString(),
    items: [],
  };
  store.favoriteMeals.unshift(nextFavorite);
  return nextFavorite;
}

function saveFavoriteMealItem(payload = {}) {
  const favorite = saveFavoriteMealMetadata(payload);
  const normalizedFoodId = String(payload.foodId || "").trim();
  const normalizedGrams = toNumber(payload.grams);
  const food = getFoodById(normalizedFoodId);

  if (!favorite || !food || !normalizedGrams) {
    return false;
  }

  const nextItem = {
    id: state.editingFavoriteItem.itemId || uid("favorite-item"),
    foodId: food.id,
    foodName: food.name,
    grams: normalizedGrams,
  };

  if (state.editingFavoriteItem.favoriteId) {
    favorite.items =
      state.editingFavoriteItem.itemIndex >= 0 && state.editingFavoriteItem.itemIndex < favorite.items.length
        ? favorite.items.map((item, index) => (index === state.editingFavoriteItem.itemIndex ? nextItem : item))
        : [...favorite.items, nextItem];
    favorite.updatedAt = new Date().toISOString();
    return true;
  }

  favorite.items = [...favorite.items, nextItem];
  favorite.updatedAt = new Date().toISOString();
  return true;
}

function resetPlanDraft() {
  state.editingEntryId = "";
  state.planDraft = {
    mealLabel: "",
    foodId: "",
    grams: "",
  };
}

function setPlanDraftFromEntry(entry) {
  state.editingEntryId = entry.id;
  state.editingMealLabel = entry.mealLabel || "";
  state.planDraft = {
    mealLabel: entry.mealLabel || "",
    foodId: entry.foodId || "",
    grams: entry.grams ? String(roundValue(entry.grams, 0)) : "",
  };
}

function getDraftFood() {
  return getFoodById(state.planDraft.foodId);
}

function getDraftTotals() {
  const food = getDraftFood();
  const grams = toNumber(state.planDraft.grams);
  if (!food || !grams) {
    return { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  }
  return calculateEntry(food, grams);
}

function getEffectiveDayTotals() {
  const baseEntries = getPlanEntriesForDay(state.selectedWeekday).filter((entry) => entry.id !== state.editingEntryId);
  const totals = getDayTotals(baseEntries);
  const draftTotals = getDraftTotals();
  return {
    kcal: totals.kcal + draftTotals.kcal,
    protein: totals.protein + draftTotals.protein,
    carbs: totals.carbs + draftTotals.carbs,
    fat: totals.fat + draftTotals.fat,
  };
}

function getMealEntriesForWeekday(weekday, mealLabel) {
  const normalizedMealLabel = normalizeMealLabel(mealLabel);
  return store.weeklyPlanEntries.filter(
    (entry) => entry.weekday === weekday && normalizeMealLabel(entry.mealLabel) === normalizedMealLabel
  );
}

function applyFavoriteMealToDay(favorite, options = {}) {
  if (!favorite?.items?.length) {
    return false;
  }

  const weekday = options.weekday || state.selectedWeekday;
  const targetMealLabel = normalizeMealLabel(options.mealLabel || favorite.mealLabel || favorite.name);
  const mode = options.mode || "append";
  const servings = getRecipeServingCount(favorite);
  const existingEntries = getMealEntriesForWeekday(weekday, targetMealLabel);

  if (isMealCompletedForWeekday(weekday, targetMealLabel)) {
    showFeedbackToast({
      title: "Obrok je zaključan",
      detail: "Skini čekiranje sa tog obroka pa onda ubaci ili zameni recept.",
      tone: "warning",
    });
    return false;
  }

  if (mode === "replace" && existingEntries.length) {
    const confirmed = window.confirm(`Da li želiš da zameniš sve stavke za "${targetMealLabel}" receptom "${favorite.name}"?`);
    if (!confirmed) {
      return false;
    }
    store.weeklyPlanEntries = store.weeklyPlanEntries.filter(
      (entry) => !(entry.weekday === weekday && normalizeMealLabel(entry.mealLabel) === targetMealLabel)
    );
  }

  favorite.items.forEach((item) => {
    store.weeklyPlanEntries.push({
      id: uid("plan"),
      weekday,
      mealLabel: targetMealLabel,
      foodId: item.foodId,
      foodName: item.foodName,
      grams: Math.max(0.1, roundValue(toNumber(item.grams) / servings, 1)),
      done: false,
    });
  });

  return true;
}

function isMealCompletedForWeekday(weekday, mealLabel) {
  const mealEntries = getMealEntriesForWeekday(weekday, mealLabel);
  return mealEntries.length > 0 && mealEntries.every((entry) => entry.done);
}

function isMealCollapsedForWeekday(weekday, mealLabel) {
  const collapsedMeals = store.ui?.plan?.collapsedMealsByWeekday?.[weekday];
  const normalizedMealLabel = normalizeMealLabel(mealLabel);
  return Array.isArray(collapsedMeals)
    ? collapsedMeals.includes(normalizedMealLabel)
    : Boolean(collapsedMeals?.[normalizedMealLabel]);
}

function toggleMealCollapsedState(weekday, mealLabel) {
  const normalizedMealLabel = normalizeMealLabel(mealLabel);
  const current = store.ui.plan.collapsedMealsByWeekday?.[weekday];
  const collapsedMeals = Array.isArray(current)
    ? [...current]
    : Object.keys(current || {}).filter((label) => current[label]);

  if (collapsedMeals.includes(normalizedMealLabel)) {
    store.ui.plan.collapsedMealsByWeekday[weekday] = collapsedMeals.filter((label) => label !== normalizedMealLabel);
    return;
  }

  store.ui.plan.collapsedMealsByWeekday[weekday] = [...collapsedMeals, normalizedMealLabel];
}

function getRemainingGoals(totals) {
  return {
    kcal: roundValue((store.goals.calories || 0) - totals.kcal, 1),
    protein: roundValue((store.goals.protein || 0) - totals.protein, 1),
    carbs: roundValue((store.goals.carbs || 0) - totals.carbs, 1),
    fat: roundValue((store.goals.fat || 0) - totals.fat, 1),
  };
}

function getMealPreviewRows(groupedEntries) {
  return groupedEntries.map(([mealLabel, mealEntries]) => ({
    mealLabel,
    totals: getDayTotals(mealEntries),
    count: mealEntries.length,
  }));
}

function getMealDisplayParts(mealLabel) {
  const normalizedLabel = String(mealLabel || "").trim();
  const match = normalizedLabel.match(/^(\d+\.)\s*(.+)$/);
  if (!match) {
    return {
      order: "",
      title: normalizedLabel,
    };
  }

  return {
    order: match[1],
    title: match[2],
  };
}

function findFoodByName(preferredNames = [], fallbackGroup) {
  const lowered = preferredNames.map((name) => name.toLowerCase());
  const exact = getSelectableFoods().find((food) => lowered.some((name) => food.name.toLowerCase().includes(name)));
  if (exact) {
    return exact;
  }
  if (fallbackGroup) {
    return getSelectableFoods().find((food) => getFoodMacroGroup(food) === fallbackGroup) || null;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function calculateGramsForTarget(food, macroKey, targetValue, fallbackGrams = 100, min = 20, max = 400) {
  if (!food) {
    return 0;
  }
  const baseMacro = toNumber(food[macroKey]);
  if (baseMacro <= 0) {
    return fallbackGrams;
  }
  return roundValue(clamp((targetValue / baseMacro) * 100, min, max), 0);
}

function generateDaySuggestion() {
  const breakfastProtein = findFoodByName(["przeno jaje", "kuvano jaje"], "Proteini");
  const breakfastCarb = findFoodByName(["ovsene pahuljice", "integralna tortilja"], "UH");
  const breakfastFruit = findFoodByName(["banana"], "UH");
  const snackProtein = findFoodByName(["ella sir", "grcki jogurt", "balans jogurt"], "Proteini");
  const snackFat = findFoodByName(["badem", "orah"], "Masti");
  const lunchProtein = findFoodByName(["piletina", "pileca prsa", "tunjevina"], "Proteini");
  const lunchCarb = findFoodByName(["beli pirinac", "beli krompir"], "UH");
  const lunchVeg = findFoodByName(["brokoli", "icebarg salata", "paradajz"], "Ostalo");
  const postProtein = findFoodByName(["protein"], "Proteini");
  const postCarb = findFoodByName(["banana", "jabuka"], "UH");
  const dinnerProtein = findFoodByName(["tunjevina", "piletina", "ella sir"], "Proteini");
  const dinnerFat = findFoodByName(["maslinovo ulje", "avokado"], "Masti");
  const dinnerVeg = findFoodByName(["icebarg salata", "brokoli", "zelena salata"], "Ostalo");

  const meals = [
    {
      mealLabel: "1. Dorucak",
      items: [
        breakfastProtein &&
          {
            food: breakfastProtein,
            grams: calculateGramsForTarget(breakfastProtein, "protein", store.goals.protein * 0.18, 150, 80, 250),
          },
        breakfastCarb &&
          {
            food: breakfastCarb,
            grams: calculateGramsForTarget(breakfastCarb, "carbs", store.goals.carbs * 0.28, 70, 40, 140),
          },
        breakfastFruit && {
          food: breakfastFruit,
          grams: calculateGramsForTarget(breakfastFruit, "carbs", store.goals.carbs * 0.16, 120, 80, 220),
        },
      ].filter(Boolean),
    },
    {
      mealLabel: "2. Prva užina",
      items: [
        snackProtein &&
          {
            food: snackProtein,
            grams: calculateGramsForTarget(snackProtein, "protein", store.goals.protein * 0.12, 150, 80, 250),
          },
        snackFat && {
          food: snackFat,
          grams: calculateGramsForTarget(snackFat, "fat", store.goals.fat * 0.18, 20, 10, 50),
        },
      ].filter(Boolean),
    },
    {
      mealLabel: "3. Obrok 2h pre treninga",
      items: [
        lunchProtein &&
          {
            food: lunchProtein,
            grams: calculateGramsForTarget(lunchProtein, "protein", store.goals.protein * 0.28, 200, 120, 320),
          },
        lunchCarb &&
          {
            food: lunchCarb,
            grams: calculateGramsForTarget(lunchCarb, "carbs", store.goals.carbs * 0.34, 120, 60, 220),
          },
        lunchVeg && {
          food: lunchVeg,
          grams: 200,
        },
      ].filter(Boolean),
    },
    {
      mealLabel: "4. Obrok posle treninga",
      items: [
        postProtein &&
          {
            food: postProtein,
            grams: calculateGramsForTarget(postProtein, "protein", store.goals.protein * 0.14, 30, 20, 60),
          },
        postCarb && {
          food: postCarb,
          grams: calculateGramsForTarget(postCarb, "carbs", store.goals.carbs * 0.14, 100, 80, 180),
        },
      ].filter(Boolean),
    },
    {
      mealLabel: "5. Vecera",
      items: [
        dinnerProtein &&
          {
            food: dinnerProtein,
            grams: calculateGramsForTarget(dinnerProtein, "protein", store.goals.protein * 0.22, 180, 100, 260),
          },
        dinnerVeg && {
          food: dinnerVeg,
          grams: 200,
        },
        dinnerFat && {
          food: dinnerFat,
          grams: calculateGramsForTarget(dinnerFat, "fat", store.goals.fat * 0.22, 10, 5, 30),
        },
      ].filter(Boolean),
    },
  ].filter((meal) => meal.items.length);

  const flattened = meals.flatMap((meal) =>
    meal.items.map((item) => ({
      mealLabel: meal.mealLabel,
      foodId: item.food.id,
      foodName: item.food.name,
      grams: item.grams,
      totals: calculateEntry(item.food, item.grams),
    }))
  );

  return {
    meals,
    totals: getDayTotals(flattened),
  };
}

function generateCompanionSuggestions() {
  const food = getDraftFood();
  const grams = toNumber(state.planDraft.grams);
  if (!food || !grams) {
    return [];
  }

  const effectiveTotals = getEffectiveDayTotals();
  const remaining = getRemainingGoals(effectiveTotals);
  const macroGroup = getFoodMacroGroup(food);
  const suggestions = [];

  const pushSuggestion = (candidate, gramsValue, reason) => {
    if (!candidate || candidate.id === food.id || gramsValue <= 0 || suggestions.some((item) => item.food.id === candidate.id)) {
      return;
    }
    suggestions.push({
      food: candidate,
      grams: roundValue(gramsValue, 0),
      reason,
      totals: calculateEntry(candidate, gramsValue),
    });
  };

  const deliMeat = findFoodByName(["prsuta", "pecenica"], "Proteini");
  const carbFood = findFoodByName(["beli pirinac", "integralna tortilja", "ovsene pahuljice"], "UH");
  const fatFood = findFoodByName(["maslinovo ulje", "badem"], "Masti");
  const vegFood = findFoodByName(["brokoli", "paradajz", "icebarg salata"], "Ostalo");
  const leanProtein = findFoodByName(["piletina", "tunjevina", "ella sir"], "Proteini");

  if (food.name.toLowerCase().includes("jaje")) {
    pushSuggestion(deliMeat, calculateGramsForTarget(deliMeat, "protein", Math.max(12, remaining.protein * 0.18), 30, 20, 80), "Ide uz jaja");
  }

  if (macroGroup === "Proteini") {
    pushSuggestion(carbFood, calculateGramsForTarget(carbFood, "carbs", Math.max(20, remaining.carbs * 0.35), 80, 40, 180), "Da zatvoris UH");
    pushSuggestion(vegFood, 150, "Laksi dodatak uz obrok");
  } else if (macroGroup === "UH") {
    pushSuggestion(leanProtein, calculateGramsForTarget(leanProtein, "protein", Math.max(20, remaining.protein * 0.25), 150, 80, 250), "Da podignes proteine");
    pushSuggestion(fatFood, calculateGramsForTarget(fatFood, "fat", Math.max(8, remaining.fat * 0.18), 10, 5, 30), "Da izbalansiras masti");
  } else if (macroGroup === "Masti") {
    pushSuggestion(leanProtein, calculateGramsForTarget(leanProtein, "protein", Math.max(18, remaining.protein * 0.22), 150, 80, 250), "Da dodas protein");
    pushSuggestion(carbFood, calculateGramsForTarget(carbFood, "carbs", Math.max(18, remaining.carbs * 0.25), 80, 40, 180), "Da dodas UH");
  } else {
    pushSuggestion(leanProtein, calculateGramsForTarget(leanProtein, "protein", Math.max(18, remaining.protein * 0.22), 150, 80, 250), "Dobar par");
    pushSuggestion(carbFood, calculateGramsForTarget(carbFood, "carbs", Math.max(18, remaining.carbs * 0.25), 80, 40, 180), "Za vise energije");
  }

  return suggestions.slice(0, 3);
}

function renderProgress(value, goal) {
  const ratio = goal ? Math.min((value / goal) * 100, 100) : 0;
  return `<div class="progress"><span style="width:${ratio}%"></span></div>`;
}

function formatPlanDelta(delta, unit) {
  if (Math.abs(delta) < 0.05) {
    return `Tacno po planu`;
  }
  if (delta > 0) {
    return `+${roundValue(delta, 1)} ${unit} preko plana`;
  }
  return `${roundValue(Math.abs(delta), 1)} ${unit} ispod plana`;
}

function renderMetricsGrid(metrics) {
  return `
    <div class="macro-grid">
      ${metrics
        .map(
          (metric) => `
            <article class="macro-card">
              <header>
                <h3>${metric.label}</h3>
                <span class="muted">${roundValue(metric.goal, 1)} ${metric.unit}</span>
              </header>
              <div class="macro-value">${metric.value} ${metric.unit}</div>
              ${renderProgress(metric.value, metric.goal)}
              ${metric.note ? `<div class="footer-note">${metric.note}</div>` : ""}
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderHero(entries, totals) {
  return `
    <section class="hero hero--plan">
      <div class="hero-top" data-role="hero-top">
        <div class="hero-copy">
          <span class="hero-tag">Plan</span>
          <div class="hero-copy-text">
            <h1>Nedeljni jelovnik</h1>
            <p>Izaberi dan i odmah sredi obroke za taj plan.</p>
          </div>
        </div>
        <div class="hero-status" aria-label="Aktivan dan">
          <span class="hero-status-label">Aktivan dan</span>
          <strong>${escapeHtml(state.selectedWeekday)}</strong>
        </div>
      </div>
      <div class="hero-day-picker">
        <div class="hero-picker-label">Promeni dan</div>
        <div class="chips hero-day-chips">
        ${WEEKDAYS.map(
          (weekday) => `
            <button class="chip ${weekday === state.selectedWeekday ? "is-active" : ""}" data-action="select-weekday" data-weekday="${weekday}">
              ${weekday.slice(0, 3)}
            </button>
          `
        ).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderLoadingShell() {
  return `
    <main class="shell auth-shell">
      <section class="section auth-card auth-card--centered">
        <div class="section-header">
          <div>
            <h2>Povezujem app</h2>
            <p>Proveravam nalog i spremam tvoje podatke.</p>
          </div>
        </div>
        <div class="empty">Sacekaj trenutak...</div>
      </section>
    </main>
  `;
}

function scrollPageTop(behavior = "smooth") {
  window.scrollTo({ top: 0, behavior });
}

function syncBodyScrollLock() {
  if (state.navMenuOpen) {
    if (!document.body.classList.contains("menu-open")) {
      lockedScrollY = window.scrollY;
    }
    document.body.classList.add("menu-open");
    document.body.style.position = "fixed";
    document.body.style.top = `-${lockedScrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    return;
  }

  if (!document.body.classList.contains("menu-open")) {
    return;
  }

  const topValue = document.body.style.top;
  document.body.classList.remove("menu-open");
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";

  if (topValue) {
    window.scrollTo(0, Math.abs(parseInt(topValue, 10)) || lockedScrollY || 0);
  }
}

function markUpdateReady(registration) {
  serviceWorkerRegistration = registration || serviceWorkerRegistration;
  if (!serviceWorkerRegistration?.waiting) {
    return;
  }
  state.updateReady = true;
  render();
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function dismissFeedbackToast() {
  const toast = document.querySelector(".feedback-toast");
  if (!toast) {
    return;
  }

  toast.classList.remove("is-visible");
  toast.classList.add("is-hiding");
  window.setTimeout(() => {
    if (toast.isConnected) {
      toast.remove();
    }
  }, 180);
}

function showFeedbackToast({ title, detail = "", tone = "success", duration = 2400 }) {
  if (feedbackToastTimer) {
    window.clearTimeout(feedbackToastTimer);
    feedbackToastTimer = null;
  }

  dismissFeedbackToast();

  const toast = document.createElement("div");
  toast.className = `feedback-toast feedback-toast--${tone}`;
  if (document.querySelector(".undo-banner, .update-banner")) {
    toast.classList.add("is-raised");
  }
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.innerHTML = `
    <div class="feedback-toast-title">${title}</div>
    ${detail ? `<div class="feedback-toast-detail">${detail}</div>` : ""}
  `;
  document.body.appendChild(toast);

  window.requestAnimationFrame(() => {
    toast.classList.add("is-visible");
  });

  feedbackToastTimer = window.setTimeout(() => {
    dismissFeedbackToast();
    feedbackToastTimer = null;
  }, duration);
}

function setButtonBusy(button, busyLabel = "Čuvam...") {
  if (!(button instanceof HTMLButtonElement)) {
    return () => {};
  }

  if (!button.dataset.originalHtml) {
    button.dataset.originalHtml = button.innerHTML;
  }

  button.disabled = true;
  button.classList.add("is-busy");
  button.innerHTML = renderButtonContent(busyLabel, "spinner");

  return () => {
    button.disabled = false;
    button.classList.remove("is-busy");
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  };
}

async function runButtonAction(button, task, options = {}) {
  const {
    busyLabel = "Čuvam...",
    minDuration = 360,
    successTitle = "",
    successDetail = "",
    errorTitle = "Nešto nije uspelo",
    errorDetail = "",
  } = options;

  const restoreButton = setButtonBusy(button, busyLabel);
  const startedAt = Date.now();

  try {
    const result = await task();
    const elapsed = Date.now() - startedAt;
    if (elapsed < minDuration) {
      await wait(minDuration - elapsed);
    }
    restoreButton();
    if (successTitle) {
      showFeedbackToast({ title: successTitle, detail: successDetail, tone: "success" });
    }
    return result;
  } catch (error) {
    restoreButton();
    showFeedbackToast({ title: errorTitle, detail: errorDetail, tone: "error" });
    throw error;
  }
}

function renderPasswordToggleIcon(isVisible) {
  return isVisible
    ? `
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M3.3 2.3 21.7 20.7l-1.4 1.4-3.1-3.1c-1.6.8-3.4 1.2-5.2 1.2-5.2 0-9.5-3-11.5-8 1-2.5 2.6-4.5 4.6-5.9L1.9 3.7l1.4-1.4Zm7.2 7.2 3.9 3.9a4 4 0 0 0-3.9-3.9Zm1.5-5.7c5.2 0 9.5 3 11.5 8a13.7 13.7 0 0 1-4.7 5.9l-1.5-1.5a11.5 11.5 0 0 0 3.7-4.4c-1.7-3.6-4.8-5.8-9-5.8-1.3 0-2.5.2-3.6.6L6.7 5.1c1.6-.8 3.4-1.3 5.3-1.3Zm0 4.2a4 4 0 0 1 4 4c0 .7-.2 1.4-.5 2l-5.5-5.5c.6-.3 1.3-.5 2-.5Z"/>
      </svg>
    `
    : `
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M12 5c5.2 0 9.5 3 11.5 8-2 5-6.3 8-11.5 8S2.5 18 0.5 13C2.5 8 6.8 5 12 5Zm0 2c-4.2 0-7.3 2.2-9 6 1.7 3.8 4.8 6 9 6s7.3-2.2 9-6c-1.7-3.8-4.8-6-9-6Zm0 2.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm0 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>
      </svg>
    `;
}

function renderMenuToggleIcon(isOpen) {
  return isOpen
    ? `
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M6.7 5.3 12 10.6l5.3-5.3 1.4 1.4-5.3 5.3 5.3 5.3-1.4 1.4-5.3-5.3-5.3 5.3-1.4-1.4 5.3-5.3-5.3-5.3 1.4-1.4Z"/>
      </svg>
    `
    : `
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M3 6.75h18v1.8H3v-1.8Zm0 4.35h18v1.8H3v-1.8Zm0 4.35h18v1.8H3v-1.8Z"/>
      </svg>
    `;
}

function renderActionIcon(kind) {
  const icons = {
    add: '<path fill="currentColor" d="M11 5h2v14h-2zM5 11h14v2H5z"/>',
    edit: '<path fill="currentColor" d="m4 16.25 9.7-9.7 4 4L8 20.25H4zm11.1-10.4 1.7-1.7a1.5 1.5 0 0 1 2.1 0l.95.95a1.5 1.5 0 0 1 0 2.1l-1.7 1.7-4-4Z"/>',
    delete: '<path fill="currentColor" d="M9 4h6l1 1h4v2H4V5h4l1-1Zm1 5h2v8h-2V9Zm4 0h2v8h-2V9ZM7 9h2v8H7V9Z"/>',
    save: '<path fill="currentColor" d="M5 4h11l3 3v13H5V4Zm2 2v4h8V6H7Zm0 12h10v-6H7v6Z"/>',
    copy: '<path fill="currentColor" d="M8 7V4h11v13h-3v3H5V7h3Zm2 0h6v8h1V6H10v1Zm-3 2v9h7V9H7Z"/>',
    open: '<path fill="currentColor" d="M4 7h7l2 2h7v10H4V7Zm2 2v8h12v-6h-6.2l-2-2H6Z"/>',
    undo: '<path fill="currentColor" d="M10 7V4L4 9l6 5v-3c3.7 0 6.1 1.3 7 4-0.1-5.1-2.8-8-7-8Z"/>',
    refresh: '<path fill="currentColor" d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h7V4l-2.3 2.3Z"/>',
    signout: '<path fill="currentColor" d="M10 4H5v16h5v-2H7V6h3V4Zm1.5 4.5 1.4-1.4L18.8 13l-5.9 5.9-1.4-1.4L14.97 14H9v-2h5.97L11.5 8.5Z"/>',
    apply: '<path fill="currentColor" d="M9 16.2 4.8 12l1.4-1.4L9 13.4l8.8-8.8L19.2 6 9 16.2Z"/>',
    spinner: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="34 16"/>',
  };
  return `<span class="button-icon ${kind === "spinner" ? "is-spinning" : ""}" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" focusable="false">${icons[kind] || icons.add}</svg></span>`;
}

function getSyncStatusTone(status = state.syncStatus) {
  const value = `${status || ""}`.toLowerCase();
  if (!value) return "info";
  if (value.includes("uspeo")) return "error";
  if (value.includes("nije dostupan") || value.includes("radis lokalno")) return "warning";
  if (value.includes("prijavi se") || value.includes("cuvam") || value.includes("učitavam") || value.includes("ucitavam")) return "info";
  if (value.includes("ukljucen") || value.includes("zavrsen") || value.includes("završen")) return "success";
  return "info";
}

function renderSectionLead(title, description, options = {}) {
  const { eyebrow = "" } = options;
  return `
    <div class="section-header ${eyebrow ? "section-header--eyebrow" : ""}">
      <div class="section-copy">
        ${eyebrow ? `<span class="section-eyebrow">${eyebrow}</span>` : ""}
        <h2>${title}</h2>
        <p>${description}</p>
      </div>
    </div>
  `;
}

function renderStatusSummaryCard({ title, detail = "", statusLabel = "", tone = "info", pills = [], actions = "" }) {
  return `
    <article class="status-summary-card">
      <div class="status-summary-top">
        <div class="status-summary-copy">
          <strong>${title}</strong>
          ${detail ? `<div class="footer-note">${detail}</div>` : ""}
        </div>
        ${statusLabel ? `<span class="pill strong pill--${tone}">${statusLabel}</span>` : ""}
      </div>
      ${
        pills.length
          ? `
            <div class="pill-row status-summary-pills">
              ${pills
                .map(
                  (pill) =>
                    `<span class="pill ${pill.strong ? "strong" : ""} ${pill.tone ? `pill--${pill.tone}` : ""}">${pill.label}</span>`
                )
                .join("")}
            </div>
          `
          : ""
      }
      ${actions ? `<div class="meta-row meta-row--compact status-summary-actions">${actions}</div>` : ""}
    </article>
  `;
}

function renderButtonContent(label, iconKind, labelClass = "") {
  return `${renderActionIcon(iconKind)}<span class="button-label ${labelClass}">${label}</span>`;
}

function renderAuthShell() {
  const submitLabel = state.authPending
    ? state.authMode === "register"
      ? "Pravim nalog..."
      : "Prijavljujem..."
    : state.authMode === "register"
      ? "Napravi nalog"
      : "Prijavi se";

  return `
    <main class="shell auth-shell">
      <section class="section auth-card">
        <div class="auth-layout">
          <div class="auth-hero">
            <span class="auth-badge">Cloud sync</span>
            <h1>${state.authMode === "register" ? "Napravi svoj nalog" : "Prijavi se u svoj tracker"}</h1>
            <p>Plan, obroci i trening biće sync-ovani između uređaja.</p>
            <div class="meta-row auth-highlights" aria-label="Prednosti aplikacije">
              <span class="pill strong">Plan + obroci</span>
              <span class="pill">Trening i rutina</span>
              <span class="pill">Sync između uređaja</span>
            </div>
          </div>

          <div class="auth-panel">
            <div class="auth-mode-switch" role="tablist" aria-label="Rezim prijave">
              <button
                class="auth-mode-chip ${state.authMode === "login" ? "is-active" : ""}"
                type="button"
                data-action="set-auth-mode"
                data-mode="login"
              >
                Prijava
              </button>
              <button
                class="auth-mode-chip ${state.authMode === "register" ? "is-active" : ""}"
                type="button"
                data-action="set-auth-mode"
                data-mode="register"
              >
                Novi nalog
              </button>
            </div>
            <form id="auth-form" class="form-grid auth-form">
              <div class="field">
                <label for="auth-email">Email</label>
                <input id="auth-email" name="email" type="email" placeholder="ime.prezime@email.com" autocomplete="email" required />
              </div>
              <div class="field password-field">
                <label for="auth-password">Lozinka</label>
                <div class="password-input-wrap">
                  <input id="auth-password" name="password" type="password" placeholder="Minimum 6 karaktera" autocomplete="${state.authMode === "register" ? "new-password" : "current-password"}" required />
                  <button class="ghost-button password-toggle" type="button" data-action="toggle-auth-password" aria-controls="auth-password" aria-label="Prikaži lozinku">
                    ${renderPasswordToggleIcon(false)}
                  </button>
                </div>
              </div>
              ${
                state.authError
                  ? `<div class="auth-feedback auth-feedback--error" role="alert">${state.authError}</div>`
                  : `<div class="auth-note">Slike ostaju lokalno. Plan, obroci, trening i rutina idu u cloud.</div>`
              }
              <button class="solid-button auth-submit" type="submit" ${state.authPending ? "disabled" : ""}>${submitLabel}</button>
            </form>
            <div class="meta-row auth-toggle-row">
              <span class="footer-note">
                ${
                  state.authMode === "register"
                    ? "Već imaš nalog?"
                    : "Prvi put ovde?"
                }
              </span>
              <button class="ghost-button auth-switch-button" type="button" data-action="set-auth-mode" data-mode="${state.authMode === "register" ? "login" : "register"}">
                ${state.authMode === "register" ? "Idi na prijavu" : "Napravi nalog"}
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  `;
}

function updateHeroScrollState() {
  if (heroScrollFrame) {
    window.cancelAnimationFrame(heroScrollFrame);
  }

  heroScrollFrame = window.requestAnimationFrame(() => {
    heroScrollFrame = 0;
    if (state.isPlanHeroCompact || document.body.classList.contains("plan-compact")) {
      state.isPlanHeroCompact = false;
      document.body.classList.remove("plan-compact");
    }
  });
}

function renderMacroCards(totals) {
  const metrics = [
    { label: "Kalorije", value: roundValue(totals.kcal, 0), goal: roundValue(store.goals.calories, 0), unit: "kcal" },
    { label: "Proteini", value: roundValue(totals.protein, 1), goal: store.goals.protein, unit: "g" },
    { label: "Ugljeni hidrati", value: roundValue(totals.carbs, 1), goal: store.goals.carbs, unit: "g" },
    { label: "Masti", value: roundValue(totals.fat, 1), goal: store.goals.fat, unit: "g" },
  ];

  return renderMetricsGrid(metrics);
}

function renderPlanEntryComposer(meals, companionSuggestions, draftFood) {
  const activeMealLabel = normalizeMealLabel(state.planDraft.mealLabel || state.editingMealLabel || defaultMeals[0]);
  const mealParts = getMealDisplayParts(activeMealLabel);
  const selectableFoods = getSelectableFoods();

  return `
    <form id="plan-entry-form" class="form-grid split meal-composer">
      <input id="mealLabel" name="mealLabel" type="hidden" value="${activeMealLabel}" />
      <div class="composer-context meal-composer-context">
        ${mealParts.order ? `<span class="meal-order">${mealParts.order}</span>` : ""}
        <div>
          <strong>${mealParts.title || activeMealLabel}</strong>
          <div class="footer-note">
            ${state.editingEntryId ? "Menjaš postojeću stavku u ovom obroku." : "Dodaješ novu namirnicu direktno u ovaj obrok."}
          </div>
        </div>
      </div>
      <div class="field meal-composer-field">
        <label for="foodId">Namirnica</label>
        <select id="foodId" name="foodId" required>
          <option value="">Izaberi namirnicu</option>
          ${selectableFoods
            .map((food) => `<option value="${food.id}" ${food.id === state.planDraft.foodId ? "selected" : ""}>${food.name}</option>`)
            .join("")}
        </select>
      </div>
      <div class="field meal-composer-field">
        <label for="grams">Količina u gramima</label>
        <input id="grams" name="grams" type="number" min="1" step="1" placeholder="100" value="${state.planDraft.grams}" required />
      </div>
      <div class="preview-box meal-composer-preview" id="entry-preview">
        <h3>Preview</h3>
        <p>Izaberi namirnicu i gramažu da odmah vidiš makroe.</p>
      </div>
      ${
        companionSuggestions.length
          ? `
            <div class="food-card suggestion-surface meal-composer-suggestions" id="companion-suggestions">
              <div class="food-card-top">
                <h3>Brzi predlozi uz ${draftFood?.name || "stavku"}</h3>
                <span class="pill strong">auto</span>
              </div>
              <div class="stack" style="margin-top:10px;">
                ${companionSuggestions
                  .map(
                    (suggestion) => `
                      <div class="suggestion-row">
                        <div>
                          <strong>${suggestion.food.name}</strong>
                          <div class="footer-note">${suggestion.reason}</div>
                          <div class="pill-row">
                            <span class="pill">${roundValue(suggestion.grams, 0)} g</span>
                            <span class="pill note">${roundValue(suggestion.totals.kcal, 0)} kcal</span>
                          </div>
                        </div>
                        <button class="ghost-button" type="button" data-action="add-companion-suggestion" data-food-id="${suggestion.food.id}" data-grams="${roundValue(suggestion.grams, 0)}">
                          Ubaci
                        </button>
                      </div>
                    `
                  )
                  .join("")}
              </div>
            </div>
          `
          : ""
      }
      <div class="entry-actions entry-actions--start meal-composer-actions">
        <button class="solid-button secondary-button" type="submit">${state.editingEntryId ? "Sačuvaj izmene" : "Dodaj namirnicu"}</button>
        ${
          state.editingEntryId
            ? `<button class="ghost-button" type="button" data-action="cancel-edit-entry">Odustani</button>`
            : `<button class="ghost-button" type="button" data-action="finish-edit-meal" data-meal-label="${state.editingMealLabel}">Zatvori</button>`
        }
      </div>
    </form>
  `;
}

function truncateText(value, maxLength = 140) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function renderPlanRecipesSection(planMeals, favorites) {
  const recipeGroups = planMeals
    .map(([mealLabel, mealEntries]) => ({
      mealLabel,
      mealEntries,
      recipes: getRecipesForMealLabel(mealLabel, favorites),
    }))
    .filter((group) => group.recipes.length);

  return `
    <section class="section plan-recipes-section">
      <div class="section-header">
        <div>
          <h2>Recepti u planu</h2>
          <p>Za svaki tip obroka imaš recepte koje možeš da ubaciš odmah ili da njima zameniš postojeći sastav.</p>
        </div>
      </div>
      ${
        recipeGroups.length
          ? `
            <div class="stack plan-recipes-groups">
              ${recipeGroups
                .map((group) => {
                  const mealParts = getMealDisplayParts(group.mealLabel);
                  return `
                    <div class="plan-recipes-group">
                      <div class="plan-recipes-group-head">
                        <div class="meal-heading-block">
                          ${mealParts.order ? `<span class="meal-order">${mealParts.order}</span>` : ""}
                          <div>
                            <h3 class="meal-title">${mealParts.title || group.mealLabel}</h3>
                            <div class="footer-note">${group.recipes.length} ${group.recipes.length === 1 ? "recept" : "recepta"} za ovaj obrok</div>
                          </div>
                        </div>
                      </div>
                      <div class="stack plan-recipes-grid">
                        ${group.recipes
                          .map((favorite) => {
                            const matchState = getRecipeMatchState(favorite, group.mealEntries);
                            const hasExistingMeal = group.mealEntries.length > 0;
                            return `
                              <article class="food-card suggestion-surface plan-recipe-card">
                                <div class="food-card-top plan-recipe-top">
                                  <div class="plan-recipe-copy">
                                    <h3>${favorite.name}</h3>
                                    <p>${truncateText(favorite.description || favorite.instructions || "Sačuvan recept koji možeš brzo da ubaciš u plan.", 132)}</p>
                                  </div>
                                  <span class="pill strong pill--${matchState.tone}">${matchState.label}</span>
                                </div>
                                <div class="pill-row plan-recipe-pills">
                                  <span class="pill">${favorite.mealLabel || favorite.name}</span>
                                  <span class="pill">${favorite.servings} ${favorite.servings === 1 ? "porcija" : favorite.servings < 5 ? "porcije" : "porcija"}</span>
                                  ${
                                    favorite.prepTimeMinutes
                                      ? `<span class="pill note">${favorite.prepTimeMinutes} min pripreme</span>`
                                      : `<span class="pill note">${favorite.items.length} sastojka</span>`
                                  }
                                  <span class="pill note">Po porciji ${roundValue(favorite.perServingTotals.kcal, 0)} kcal</span>
                                  <span class="pill">P ${roundValue(favorite.perServingTotals.protein, 1)} g</span>
                                  <span class="pill">UH ${roundValue(favorite.perServingTotals.carbs, 1)} g</span>
                                  <span class="pill">M ${roundValue(favorite.perServingTotals.fat, 1)} g</span>
                                </div>
                                <div class="plan-recipe-ingredient-list">
                                  ${favorite.items
                                    .slice(0, 4)
                                    .map(
                                      (item) => `
                                        <span class="plan-recipe-ingredient">
                                          <strong>${item.displayName || item.foodName}</strong>
                                          <span>${roundValue(item.grams, 0)} g</span>
                                        </span>
                                      `
                                    )
                                    .join("")}
                                  ${
                                    favorite.items.length > 4
                                      ? `<span class="plan-recipe-ingredient plan-recipe-ingredient--more">+${favorite.items.length - 4} još</span>`
                                      : ""
                                  }
                                </div>
                                ${
                                  favorite.instructions
                                    ? `<div class="plan-recipe-method">${truncateText(favorite.instructions, 170)}</div>`
                                    : ""
                                }
                                <div class="entry-actions entry-actions--start plan-recipe-actions">
                                  <button
                                    class="solid-button secondary-button button-with-icon"
                                    data-action="apply-recipe-to-meal"
                                    data-favorite-id="${favorite.id}"
                                    data-meal-label="${group.mealLabel}"
                                    data-mode="append"
                                  >
                                    ${renderButtonContent(favorite.servings > 1 ? "Dodaj 1 porciju" : "Dodaj u obrok", "add")}
                                  </button>
                                  ${
                                    hasExistingMeal
                                      ? `
                                        <button
                                          class="ghost-button button-with-icon"
                                          data-action="apply-recipe-to-meal"
                                          data-favorite-id="${favorite.id}"
                                          data-meal-label="${group.mealLabel}"
                                          data-mode="replace"
                                        >
                                          ${renderButtonContent("Zameni", "apply")}
                                        </button>
                                      `
                                      : ""
                                  }
                                  <button class="ghost-button button-with-icon" data-action="prefill-favorite-meal" data-favorite-id="${favorite.id}">
                                    ${renderButtonContent("Izmeni", "edit")}
                                  </button>
                                  <button class="danger-button button-with-icon" data-action="delete-favorite-meal" data-favorite-id="${favorite.id}">
                                    ${renderButtonContent("Obriši", "delete")}
                                  </button>
                                </div>
                              </article>
                            `;
                          })
                          .join("")}
                      </div>
                    </div>
                  `;
                })
                .join("")}
            </div>
          `
          : `
            <div class="empty">
              Još nema sačuvanih recepata po tipu obroka. Sačuvaj obrok iz plana ili otvori Recepti tab da napraviš prvi.
            </div>
          `
      }
    </section>
  `;
}

function renderPlanSupplementsSection() {
  const supplements = getSupplementsForDay(state.selectedWeekday);
  const doneCount = supplements.filter((supplement) => isSupplementDoneForDay(supplement, state.selectedWeekday)).length;

  return `
    <section class="section plan-supplements-section">
      <div class="section-header">
        <div>
          <h2>Vitamini i suplementi</h2>
          <p>Šta uzimaš za ${state.selectedWeekday}, da možeš brzo da čekiraš kroz dan.</p>
        </div>
      </div>
      <div class="stats-grid plan-supplement-summary">
        <article class="stat-card">
          <strong>Za danas</strong>
          <div class="macro-value">${supplements.length}</div>
          <div class="footer-note">Planiranih stavki</div>
        </article>
        <article class="stat-card">
          <strong>Označeno</strong>
          <div class="macro-value">${doneCount}/${supplements.length || 0}</div>
          <div class="footer-note">Čekirano za ${state.selectedWeekday}</div>
        </article>
      </div>
      <div class="stack" style="margin-top:14px;">
        ${
          supplements.length
            ? supplements
                .map(
                  (supplement) => `
                    <article class="food-card routine-card supplement-plan-card ${isSupplementDoneForDay(supplement, state.selectedWeekday) ? "is-done" : ""}">
                      <div class="routine-row">
                        <label class="routine-check">
                          <input
                            type="checkbox"
                            class="routine-checkbox"
                            data-action="toggle-supplement-day"
                            data-supplement-id="${supplement.id}"
                            ${isSupplementDoneForDay(supplement, state.selectedWeekday) ? "checked" : ""}
                          />
                          <span class="routine-check-ui" aria-hidden="true"></span>
                        </label>
                        <div class="routine-content">
                          <strong>${supplement.name}</strong>
                          <div class="footer-note">${supplement.note || "Bez dodatne napomene"}</div>
                          <div class="pill-row">
                            <span class="pill strong">${getSupplementTimingLabel(supplement.timing)}</span>
                            <span class="pill ${isSupplementDoneForDay(supplement, state.selectedWeekday) ? "pill--success" : "pill--info"}">
                              ${isSupplementDoneForDay(supplement, state.selectedWeekday) ? "Označeno" : "Čeka danas"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Dodaj vitamine u tabu Ciljevi, pa će se ovde pojaviti dnevna checklist-a.</div>`
        }
      </div>
    </section>
  `;
}

function renderPlanTab(entries) {
  const groupedEntries = groupEntriesByMeal(entries);
  const totals = getDayTotals(entries);
  const trainingBurn = getTrainingBurnForDay(state.selectedWeekday);
  const netCalories = roundValue(totals.kcal - trainingBurn, 0);
  const favorites = getFavoriteMealsDetailed();
  const meals = [
    ...new Set([
      ...defaultMeals,
      ...store.weeklyPlanEntries.map((entry) => normalizeMealLabel(entry.mealLabel)),
    ]),
  ];
  const planMeals = meals.map((mealLabel) => [mealLabel, entries.filter((entry) => entry.mealLabel === mealLabel)]);
  const favoriteFoods = getFavoriteFoodsDetailed();
  const mealPreviewRows = getMealPreviewRows(groupedEntries);
  const daySuggestion = generateDaySuggestion();
  const companionSuggestions = generateCompanionSuggestions();
  const draftFood = getDraftFood();
  const isDaySuggestionHidden = Boolean(store.ui?.plan?.hideDaySuggestion);

  return `
    <section class="section plan-summary-section">
      <div class="section-header">
        <div>
          <h2>Dnevni pregled</h2>
          <p>Tvoj plan po obrocima, makroi i recepti na jednom mestu.</p>
        </div>
      </div>
      <div class="plan-summary-layout">
        ${renderMacroCards(totals)}
        <div class="stats-grid plan-secondary-stats">
          <article class="stat-card">
            <strong>Potrošeno trening</strong>
            <div class="macro-value">${roundValue(trainingBurn, 0)} kcal</div>
            <div class="footer-note">Apple Watch unos za ${state.selectedWeekday}</div>
          </article>
          <article class="stat-card">
            <strong>Neto kcal</strong>
            <div class="macro-value">${netCalories} kcal</div>
            <div class="footer-note">Uneto minus potrošeno na treningu</div>
          </article>
        </div>
      </div>
    </section>

    <section class="section plan-preview-section">
      <div class="section-header">
        <div>
          <h2>Pregled po obrocima</h2>
          <p>Jasan mini pregled svakog obroka, da odmah vidiš kako izgleda ceo dan.</p>
        </div>
      </div>
      <div class="stack">
        ${
          mealPreviewRows.length
            ? mealPreviewRows
                .map((row) => {
                  const mealParts = getMealDisplayParts(row.mealLabel);
                  return `
                    <article class="food-card plan-preview-card">
                      <div class="meal-heading-block">
                        ${mealParts.order ? `<span class="meal-order">${mealParts.order}</span>` : ""}
                        <h3 class="meal-title">${mealParts.title || row.mealLabel}</h3>
                      </div>
                      <div class="pill-row">
                        <span class="pill note">${roundValue(row.totals.kcal, 0)} kcal</span>
                        <span class="pill">P ${roundValue(row.totals.protein, 1)} g</span>
                        <span class="pill">UH ${roundValue(row.totals.carbs, 1)} g</span>
                        <span class="pill">M ${roundValue(row.totals.fat, 1)} g</span>
                      </div>
                    </article>
                  `;
                })
                .join("")
            : `<div class="empty">Još nema stavki za preview dana.</div>`
        }
      </div>
    </section>

    ${renderPlanSupplementsSection()}

    <section class="section plan-quick-section">
      <div class="section-header">
        <div>
          <h2>Brze akcije</h2>
          <p>Kopiraj dan kad imaš sličan raspored i koristi omiljene namirnice za brz unos.</p>
        </div>
      </div>
      <div class="stack plan-quick-stack">
        <article class="food-card plan-quick-card">
          <div class="food-card-top">
            <h3>Kopiraj plan dana</h3>
            <span class="pill strong">${state.selectedWeekday}</span>
          </div>
          <form id="duplicate-day-form" class="form-grid split plan-quick-form">
            <div class="field">
              <label for="duplicate-target-weekday">Kopiraj ${state.selectedWeekday} u</label>
              <select id="duplicate-target-weekday" name="targetWeekday" required>
                <option value="">Izaberi dan</option>
                ${WEEKDAYS.filter((weekday) => weekday !== state.selectedWeekday)
                  .map((weekday) => `<option value="${weekday}">${weekday}</option>`)
                  .join("")}
              </select>
            </div>
            <div class="field">
              <label for="duplicate-mode">Način kopiranja</label>
              <select id="duplicate-mode" name="mode">
                <option value="append">Dodaj u plan</option>
                <option value="replace">Prepiši dan</option>
              </select>
            </div>
            <button class="solid-button button-with-icon" type="submit">${renderButtonContent("Kopiraj dan", "copy")}</button>
          </form>
        </article>

        <article class="food-card plan-quick-card">
          <div class="food-card-top">
            <h3>Omiljene namirnice</h3>
            <span class="pill strong">${favoriteFoods.length}</span>
          </div>
          ${
            favoriteFoods.length
              ? `
                <div class="chips plan-favorite-chips">
                  ${favoriteFoods
                    .map(
                      (food) => `
                        <button class="chip is-light" data-action="use-favorite-food" data-food-id="${food.id}">
                          ${food.name}
                        </button>
                      `
                    )
                    .join("")}
                </div>
              `
              : `<div class="empty">Dodaj omiljene namirnice iz taba Namirnice, pa ćeš ih ovde birati jednim tapom.</div>`
          }
        </article>

        ${
          isDaySuggestionHidden
            ? `
              <article class="food-card plan-quick-card plan-suggestion-card is-muted">
                <div class="food-card-top">
                  <h3>Predlog dana</h3>
                  <span class="pill">pauzirano</span>
                </div>
                <div class="footer-note">Sklonio si predlog sa ekrana. Možeš da ga vratiš kad ti zatreba.</div>
                <div class="entry-actions entry-actions--start" style="margin-top:12px;">
                  <button class="ghost-button button-with-icon" data-action="show-day-suggestion">${renderButtonContent("Prikaži opet", "refresh")}</button>
                </div>
              </article>
            `
            : `
              <article class="food-card suggestion-surface plan-suggestion-card">
                <div class="food-card-top">
                  <h3>Predlog celog dana</h3>
                  <button class="plan-skip-button" type="button" data-action="hide-day-suggestion">Skip</button>
                </div>
                <div class="pill-row">
                  <span class="pill note">${roundValue(daySuggestion.totals.kcal, 0)} kcal</span>
                  <span class="pill">P ${roundValue(daySuggestion.totals.protein, 1)} g</span>
                  <span class="pill">UH ${roundValue(daySuggestion.totals.carbs, 1)} g</span>
                  <span class="pill">M ${roundValue(daySuggestion.totals.fat, 1)} g</span>
                </div>
                <div class="footer-note">
                  ${daySuggestion.meals
                    .map((meal) => `${meal.mealLabel}: ${meal.items.map((item) => `${item.food.name} ${roundValue(item.grams, 0)}g`).join(", ")}`)
                    .join(" | ")}
                </div>
                <div class="entry-actions entry-actions--start plan-inline-actions">
                  <button class="solid-button secondary-button button-with-icon" data-action="apply-day-suggestion" data-mode="replace">
                    ${renderButtonContent("Primeni na dan", "apply")}
                  </button>
                  <button class="ghost-button button-with-icon" data-action="apply-day-suggestion" data-mode="append">
                    ${renderButtonContent("Dodaj u plan", "add")}
                  </button>
                </div>
              </article>
            `
        }
        <article class="food-card suggestion-surface plan-recipes-card">
          <div class="food-card-top">
            <h3>Sačuvani recepti</h3>
            <span class="pill strong">${favorites.length}</span>
          </div>
          <div class="footer-note">Kad ti zatreba gotov recept, otvori Recepti i ubaci ga direktno u ${state.selectedWeekday}.</div>
          <div class="entry-actions entry-actions--start" style="margin-top:12px;">
            <button class="solid-button secondary-button button-with-icon" data-action="switch-tab" data-tab="recipes">${renderButtonContent("Otvori Recepti", "open")}</button>
          </div>
        </article>
      </div>
    </section>

    <section class="section plan-meals-section">
      <div class="section-header">
        <div>
          <h2>Obroci za ${state.selectedWeekday}</h2>
          <p>${entries.length ? "Sve za taj dan je ovde: dodavanje, izmene i brzo čuvanje kao recept." : "Još nema stavki za ovaj dan."}</p>
        </div>
      </div>
      <div class="stack">
        ${
          planMeals.length
            ? planMeals
                .map(([mealLabel, mealEntries]) => {
                  const mealParts = getMealDisplayParts(mealLabel);
                  const isEditingMeal = state.editingMealLabel === mealLabel;
                  const isMealDone = mealEntries.length > 0 && mealEntries.every((entry) => entry.done);
                  const isMealCollapsed = isMealCollapsedForWeekday(state.selectedWeekday, mealLabel);
                  const mealTotals = getDayTotals(mealEntries);
                  return `
                    <article class="meal-card ${isEditingMeal ? "is-editing" : ""} ${isMealDone ? "is-done" : ""} ${isMealCollapsed ? "is-collapsed" : ""}">
                      <div class="meal-card-topline">
                        ${mealParts.order ? `<span class="meal-order">${mealParts.order}</span>` : ""}
                        <div class="meal-card-heading">
                          <h3 class="meal-title">${mealParts.title || mealLabel}</h3>
                          <div class="footer-note">${isEditingMeal ? "Uređuješ ovaj obrok" : `Obrok za ${state.selectedWeekday}`}</div>
                        </div>
                        ${
                          mealEntries.length
                            ? `
                              <button
                                class="ghost-button meal-collapse-toggle"
                                type="button"
                                data-action="toggle-plan-meal-collapse"
                                data-meal-label="${mealLabel}"
                                aria-expanded="${!isMealCollapsed}"
                                aria-label="${isMealCollapsed ? "Raširi obrok" : "Skupi obrok"}"
                              >
                                <span aria-hidden="true">${isMealCollapsed ? "▾" : "▴"}</span>
                              </button>
                            `
                            : ""
                        }
                        ${
                          mealEntries.length
                            ? `
                              <label class="meal-toggle">
                                <input class="meal-toggle-checkbox" type="checkbox" data-action="toggle-plan-meal-done" data-meal-label="${mealLabel}" ${isMealDone ? "checked" : ""} />
                                <span class="meal-toggle-ui" aria-hidden="true"></span>
                              </label>
                            `
                            : ""
                        }
                      </div>
                      <div class="meal-card-content ${isMealCollapsed ? "is-hidden" : ""}">
                        <div class="meal-card-toolbar ${mealEntries.length ? "has-summary" : ""} ${!isMealDone ? "has-actions" : ""}">
                          ${
                            mealEntries.length
                              ? `
                                <div class="pill-row meal-summary-pills">
                                  <span class="pill note">${roundValue(mealTotals.kcal, 0)} kcal</span>
                                  <span class="pill">P ${roundValue(mealTotals.protein, 1)} g</span>
                                  <span class="pill">UH ${roundValue(mealTotals.carbs, 1)} g</span>
                                  <span class="pill">M ${roundValue(mealTotals.fat, 1)} g</span>
                                </div>
                              `
                              : ""
                          }
                          ${
                            !isMealDone
                              ? `
                                <div class="entry-actions meal-card-actions">
                                  <button class="solid-button secondary-button button-with-icon" data-action="start-add-to-meal" data-meal-label="${mealLabel}">
                                    ${renderButtonContent("Dodaj stavku", "add")}
                                  </button>
                                  <button class="ghost-button button-with-icon" data-action="${isEditingMeal ? "finish-edit-meal" : "edit-meal"}" data-meal-label="${mealLabel}">
                                    ${renderButtonContent(isEditingMeal ? "Zavrsi uredjivanje" : "Uredi obrok", "edit")}
                                  </button>
                                  ${
                                    mealEntries.length
                                      ? `
                                        <button class="ghost-button button-with-icon" data-action="save-meal-as-favorite" data-meal-label="${mealLabel}">
                                          ${renderButtonContent("Sačuvaj kao recept", "save")}
                                        </button>
                                      `
                                      : ""
                                  }
                                </div>
                              `
                              : ""
                          }
                        </div>
                        ${
                          isMealDone
                            ? `
                              <div class="meal-done-note">
                                Ovaj obrok je označen kao završen. Skini čekiranje ako želiš da ga menjaš.
                              </div>
                            `
                            : ""
                        }
                        ${isEditingMeal && !isMealDone ? renderPlanEntryComposer(meals, companionSuggestions, draftFood) : ""}
                        ${
                          mealEntries.length
                            ? mealEntries
                                .map(
                                  (entry) => `
                                    <div class="meal-entry ${entry.done ? "is-done" : ""}">
                                    <div class="meal-entry-body">
                                      <div class="meal-entry-top">
                                        <div class="meal-entry-title-group">
                                          <strong>${entry.foodName}</strong>
                                          <span class="meal-entry-grams">${roundValue(entry.grams, 0)} g</span>
                                        </div>
                                      </div>
                                      <div class="pill-row meal-entry-pills">
                                        <span class="pill note">${roundValue(entry.totals.kcal, 0)} kcal</span>
                                          <span class="pill">P ${roundValue(entry.totals.protein, 1)} g</span>
                                          <span class="pill">UH ${roundValue(entry.totals.carbs, 1)} g</span>
                                          <span class="pill">M ${roundValue(entry.totals.fat, 1)} g</span>
                                        </div>
                                      </div>
                                      ${
                                        !isMealDone
                                          ? `
                                            <div class="entry-actions meal-entry-actions">
                                              <button class="ghost-button button-with-icon" data-action="edit-entry" data-entry-id="${entry.id}" aria-label="Izmeni stavku">
                                                ${renderButtonContent("Izmeni", "edit", "button-label--mobile-hidden")}
                                              </button>
                                              <button class="danger-button button-with-icon" data-action="delete-entry" data-entry-id="${entry.id}" aria-label="Obriši stavku">
                                                ${renderButtonContent("Obriši", "delete", "button-label--mobile-hidden")}
                                              </button>
                                            </div>
                                          `
                                          : ""
                                      }
                                    </div>
                                  `
                                )
                                .join("")
                            : `<div class="empty" style="margin-top:12px;">Još nema stavki u ovom obroku.</div>`
                        }
                      </div>
                    </article>
                  `;
                })
                .join("")
            : `<div class="empty">Dodaj prvi obrok za ${state.selectedWeekday} i aplikacija će odmah sabirati makroe.</div>`
        }
      </div>
    </section>
  `;
}

function renderFoodsTab() {
  const normalizedQuery = normalizeLookupValue(state.foodSearch);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const editingFood = state.editingFoodId ? getFoodById(state.editingFoodId) : null;
  const selectableFoods = getSelectableFoods();
  const pendingNutritionFoods = getFoods().filter((food) => shouldHidePendingImportedFood(food));
  const foods = selectableFoods
    .map((food) => ({
      ...food,
      macroGroup: getFoodMacroGroup(food),
    }))
    .filter((food) => {
      const matchesFilter = state.foodMacroFilter === "Sve" ? true : food.macroGroup === state.foodMacroFilter;
      if (!matchesFilter) {
        return false;
      }
      if (!queryTokens.length) {
        return true;
      }
      const searchableText = normalizeLookupValue(
        [
          food.name,
          canonicalizeImportedFoodName(food.name),
          food.category,
          food.macroGroup,
        ]
          .filter(Boolean)
          .join(" ")
      );
      return queryTokens.every((token) => searchableText.includes(token));
    });
  const filterCounts = FOOD_MACRO_FILTERS.reduce((acc, filter) => {
    acc[filter] =
      filter === "Sve"
        ? selectableFoods.length
        : selectableFoods.filter((food) => getFoodMacroGroup(food) === filter).length;
    return acc;
  }, {});
  const macroClassMap = {
    Proteini: "proteins",
    UH: "carbs",
    Masti: "fats",
    Ostalo: "other",
    Sve: "all",
  };
  const editorGroup = editingFood ? getFoodMacroGroup(editingFood) : "Sve";
  const editorToneClass = macroClassMap[editorGroup] || "other";

  return `
    <section class="section goals-sync-section foods-section">
      <div class="section-header">
        <div>
          <h2>Baza namirnica</h2>
          <p>Trenutno imaš ${selectableFoods.length} spremnih namirnica u glavnoj bazi.</p>
          ${
            pendingNutritionFoods.length
              ? `<p class="footer-note">${pendingNutritionFoods.length} importovanih sastojaka još čeka kcal/makroe i ostaje u tabu Nutricionista dok ih ne dopuniš.</p>`
              : ""
          }
        </div>
      </div>
      <div class="chips foods-filter-bar" style="margin-bottom:14px;">
        ${FOOD_MACRO_FILTERS.map(
          (filter) => `
            <button
              class="chip is-light foods-filter-chip foods-filter-chip--${macroClassMap[filter] || "other"} ${filter === state.foodMacroFilter ? "is-active" : ""}"
              data-action="set-food-filter"
              data-filter="${filter}"
            >
              ${filter} (${filterCounts[filter] || 0})
            </button>
          `
        ).join("")}
      </div>
      <div class="field">
        <label for="food-search">Pretraga</label>
        <input id="food-search" type="search" value="${state.foodSearch}" placeholder="Piletina, banana, pirinac..." />
      </div>
      <div class="food-list foods-grid" style="margin-top:14px;">
        ${
          foods.length
            ? foods
                .map((food) => {
                  const toneClass = macroClassMap[food.macroGroup] || "other";
                  return `
              <article class="food-card foods-card foods-card--${toneClass}">
                <div class="food-card-top foods-card-top">
                  <div class="foods-title-block">
                    <h3>${food.name}</h3>
                  </div>
                  <span class="pill strong foods-group-badge foods-group-badge--${toneClass}">${food.macroGroup}</span>
                </div>
                <div class="pill-row foods-macro-row">
                  <span class="pill note foods-kcal-pill">${roundValue(food.kcal, 0)} kcal</span>
                  <span class="pill foods-stat-pill foods-stat-pill--protein ${food.macroGroup === "Proteini" ? "is-dominant" : ""}">P ${roundValue(food.protein, 1)}</span>
                  <span class="pill foods-stat-pill foods-stat-pill--carbs ${food.macroGroup === "UH" ? "is-dominant" : ""}">UH ${roundValue(food.carbs, 1)}</span>
                  <span class="pill foods-stat-pill foods-stat-pill--fat ${food.macroGroup === "Masti" ? "is-dominant" : ""}">M ${roundValue(food.fat, 1)}</span>
                </div>
                <div class="entry-actions foods-card-actions" style="justify-content:flex-start; margin-top:12px;">
                  <button
                    class="ghost-button button-with-icon"
                    data-action="edit-food"
                    data-food-id="${food.id}"
                  >
                    ${renderButtonContent("Izmeni", "edit")}
                  </button>
                  <button
                    class="${store.favoriteFoods.includes(food.id) ? "solid-button secondary-button button-with-icon" : "ghost-button button-with-icon"}"
                    data-action="toggle-favorite-food"
                    data-food-id="${food.id}"
                  >
                    ${renderButtonContent(store.favoriteFoods.includes(food.id) ? "Ukloni favorit" : "Favorit", "save")}
                  </button>
                </div>
              </article>
            `;
                })
                .join("")
            : `<div class="empty">Nema namirnica za ovaj filter. Nedovršeni nutrition import ostaje u tabu Nutricionista dok mu ne dodaš vrednosti.</div>`
        }
      </div>
    </section>

    <section class="section foods-editor-section">
      <div class="section-header">
        <div>
          <h2>${editingFood ? "Izmeni namirnicu" : "Dodaj namirnicu"}</h2>
          <p>${editingFood ? "Promeni vrednosti na 100 g i sačuvaj izmenu." : "Unosiš vrednosti na 100 g i posle ih koristiš bilo kojom gramažom."}</p>
        </div>
      </div>
      <div class="food-card suggestion-surface foods-editor-card foods-editor-card--${editorToneClass}">
        <div class="foods-editor-intro">
          <div class="foods-editor-copy">
            <div class="foods-card-kicker">${editingFood ? "Uređivanje" : "Novi unos"}</div>
            <h3>${editingFood ? editingFood.name : "Nova namirnica u bazi"}</h3>
            <p>${editingFood ? "Ažuriraš vrednosti na 100 g i promene će važiti svuda gde koristiš ovu namirnicu." : "Unesi makroe na 100 g, pa će app posle sama računati svaku gramažu u obrocima."}</p>
          </div>
          <div class="pill-row foods-editor-pills">
            <span class="pill strong foods-group-badge foods-group-badge--${editorToneClass}">${editingFood ? editorGroup : "Ručno dodavanje"}</span>
            ${editingFood ? `<span class="pill note foods-kcal-pill">${roundValue(editingFood.kcal, 0)} kcal / ${roundValue(editingFood.servingBaseGrams, 0)} g</span>` : `<span class="pill">Na 100 g</span>`}
          </div>
        </div>
        <form id="food-form" class="form-grid split foods-editor-form">
        <div class="field">
          <label for="food-name">Naziv</label>
          <input id="food-name" name="name" placeholder="npr. Grcki jogurt" value="${editingFood?.name || ""}" required />
        </div>
        <div class="field">
          <label for="food-category">Kategorija</label>
          <input id="food-category" name="category" placeholder="Proteini, masti, voce..." value="${editingFood?.category || ""}" />
        </div>
        <div class="field">
          <label for="food-kcal">Kalorije na 100 g</label>
          <input id="food-kcal" name="kcal" type="number" step="0.1" min="0" value="${editingFood ? roundValue(editingFood.kcal, 1) : ""}" required />
        </div>
        <div class="field">
          <label for="food-protein">Proteini na 100 g</label>
          <input id="food-protein" name="protein" type="number" step="0.1" min="0" value="${editingFood ? roundValue(editingFood.protein, 1) : ""}" required />
        </div>
        <div class="field">
          <label for="food-carbs">Ugljeni hidrati na 100 g</label>
          <input id="food-carbs" name="carbs" type="number" step="0.1" min="0" value="${editingFood ? roundValue(editingFood.carbs, 1) : ""}" required />
        </div>
        <div class="field">
          <label for="food-fat">Masti na 100 g</label>
          <input id="food-fat" name="fat" type="number" step="0.1" min="0" value="${editingFood ? roundValue(editingFood.fat, 1) : ""}" required />
        </div>
        <div class="entry-actions foods-editor-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap;">
          <button class="solid-button button-with-icon" type="submit">${renderButtonContent(editingFood ? "Sačuvaj izmenu" : "Sačuvaj namirnicu", "save")}</button>
          ${editingFood ? `<button class="ghost-button button-with-icon" type="button" data-action="cancel-edit-food">${renderButtonContent("Odustani", "close")}</button>` : ""}
        </div>
        </form>
      </div>
    </section>
  `;
}

function renderRecipesTab() {
  const favorites = getFavoriteMealsDetailed();
  const selectableFoods = getSelectableFoods();
  const meals = [
    ...new Set([
      ...defaultMeals,
      ...store.weeklyPlanEntries.map((entry) => normalizeMealLabel(entry.mealLabel)),
      ...favorites.map((favorite) => normalizeMealLabel(favorite.mealLabel || favorite.name)),
    ]),
  ];
  const draftPreview = getFavoriteDraftPreview();

  return `
    <section class="section recipes-builder-section">
      <div class="section-header">
        <div>
          <h2>Studio za recepte</h2>
          <p>Sačuvaj obrok kao pravi recept: sastojci, vreme pripreme i kratko uputstvo koje ćeš posle videti i u Plan tabu.</p>
        </div>
      </div>
      <article class="food-card suggestion-surface recipe-studio-card">
        <form id="favorite-meal-form" class="form-grid split recipe-builder-form">
          <div class="field">
            <label for="favorite-name">Naziv recepta</label>
            <input id="favorite-name" name="favoriteName" placeholder="npr. Tortilja sa jajima i piletinom" list="favorite-meal-options" value="${state.favoriteDraft.favoriteName}" required />
            <datalist id="favorite-meal-options">
              ${favorites.map((favorite) => `<option value="${favorite.name}"></option>`).join("")}
            </datalist>
          </div>
          <div class="field">
            <label for="favorite-meal-label">Tip obroka</label>
            <input id="favorite-meal-label" name="mealLabel" list="recipe-meal-options" placeholder="npr. 1. Doručak" value="${state.favoriteDraft.mealLabel}" required />
            <datalist id="recipe-meal-options">
              ${meals.map((meal) => `<option value="${meal}"></option>`).join("")}
            </datalist>
          </div>
          <div class="field recipe-builder-field-wide">
            <label for="favorite-description">Kratak opis</label>
            <input
              id="favorite-description"
              name="description"
              placeholder="npr. brz proteinski doručak koji drži sitost do treninga"
              value="${state.favoriteDraft.description}"
            />
          </div>
          <div class="field">
            <label for="favorite-servings">Broj porcija</label>
            <input id="favorite-servings" name="servings" type="number" min="1" step="1" placeholder="1" value="${state.favoriteDraft.servings}" />
          </div>
          <div class="field">
            <label for="favorite-prep-time">Vreme pripreme</label>
            <input id="favorite-prep-time" name="prepTimeMinutes" type="number" min="1" step="1" placeholder="15" value="${state.favoriteDraft.prepTimeMinutes}" />
          </div>
          <div class="field recipe-builder-field-wide">
            <label for="favorite-instructions">Priprema</label>
            <textarea id="favorite-instructions" name="instructions" placeholder="npr. Ispeci jaja, zagrej tortilju, dodaj piletinu i sve urolaj.">${state.favoriteDraft.instructions}</textarea>
          </div>
          <div class="field">
            <label for="favorite-food-id">Sastojak</label>
            <select id="favorite-food-id" name="foodId" required>
              <option value="">Izaberi namirnicu</option>
              ${selectableFoods
                .map((food) => `<option value="${food.id}" ${food.id === state.favoriteDraft.foodId ? "selected" : ""}>${food.name}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field">
            <label for="favorite-grams">Količina u gramima</label>
            <input id="favorite-grams" name="grams" type="number" min="1" step="1" placeholder="100" value="${state.favoriteDraft.grams}" required />
          </div>
          <div class="entry-actions entry-actions--start recipe-builder-actions">
            <button class="solid-button secondary-button button-with-icon" type="submit">
              ${renderButtonContent(state.editingFavoriteItem.itemId ? "Sačuvaj sastojak" : "Dodaj sastojak", state.editingFavoriteItem.itemId ? "save" : "add")}
            </button>
            ${state.editingFavoriteItem.itemId ? `<button class="ghost-button button-with-icon" type="button" data-action="cancel-edit-favorite-item">${renderButtonContent("Odustani", "close")}</button>` : ""}
          </div>
        </form>
        <div class="footer-note recipe-builder-note">
          Svaki klik na Dodaj sastojak ubacuje novu stavku u recept, a polja za opis i pripremu ostaju vezana za isti recept.
        </div>
      </article>
      <article class="food-card suggestion-surface recipe-draft-card" style="margin-top:14px;">
        <div class="food-card-top recipe-draft-top">
          <div class="recipe-draft-copy">
            <h3>${draftPreview.favoriteName || "Recept u izradi"}</h3>
            <p>${draftPreview.description || draftPreview.instructions || "Dodaj opis ili kratku pripremu pa će se ovde pojaviti jasan pregled recepta."}</p>
          </div>
          <span class="pill strong">${draftPreview.items.length} ${draftPreview.items.length === 1 ? "stavka" : "stavki"}</span>
        </div>
        <div class="pill-row recipe-draft-pills">
          <span class="pill">${draftPreview.mealLabel || "Tip obroka nije jos izabran"}</span>
          <span class="pill">${draftPreview.servings} ${draftPreview.servings === 1 ? "porcija" : draftPreview.servings < 5 ? "porcije" : "porcija"}</span>
          ${
            draftPreview.prepTimeMinutes
              ? `<span class="pill note">${draftPreview.prepTimeMinutes} min pripreme</span>`
              : ""
          }
          <span class="pill note">Ukupno ${roundValue(draftPreview.totals.kcal, 0)} kcal</span>
          <span class="pill">Po porciji ${roundValue(draftPreview.perServingTotals.kcal, 0)} kcal</span>
          <span class="pill">P ${roundValue(draftPreview.perServingTotals.protein, 1)} g</span>
          <span class="pill">UH ${roundValue(draftPreview.perServingTotals.carbs, 1)} g</span>
          <span class="pill">M ${roundValue(draftPreview.perServingTotals.fat, 1)} g</span>
        </div>
        ${
          draftPreview.instructions
            ? `<div class="recipe-draft-method">${draftPreview.instructions}</div>`
            : ""
        }
        <div class="footer-note" style="margin-top:10px;">Sastojci recepta koji praviš:</div>
        <div class="stack" style="margin-top:12px;">
          ${
            draftPreview.items.length
              ? draftPreview.items
                  .map(
                    (item) => `
                      <div class="suggestion-row">
                        <div>
                          <strong>${item.foodName}</strong>
                          <div class="footer-note">${roundValue(item.grams, 0)} g</div>
                        </div>
                        <div class="pill-row" style="margin-top:0;">
                          <span class="pill ${item.isPending ? "strong" : ""}">${item.isPending ? "nova stavka" : "sačuvano"}</span>
                          <span class="pill note">${roundValue(item.totals.kcal, 0)} kcal</span>
                        </div>
                      </div>
                    `
                  )
                  .join("")
              : `<div class="empty">Dodaj prvi sastojak i gramažu, pa ćeš ovde odmah videti kompletan recept.</div>`
          }
        </div>
        <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap; margin-top:14px;">
          <button
            class="solid-button button-with-icon"
            data-action="save-favorite-meal-draft"
            ${!draftPreview.favoriteName || !draftPreview.mealLabel || !draftPreview.items.length ? "disabled" : ""}
          >
            ${renderButtonContent("Sačuvaj recept", "save")}
          </button>
        </div>
      </article>
    </section>

    <section class="section recipes-library-section">
      <div class="section-header">
        <div>
          <h2>Biblioteka recepata</h2>
          <p>${favorites.length ? `Trenutno imaš ${favorites.length} sačuvanih recepata.` : "Još nema sačuvanih recepata."}</p>
        </div>
      </div>
      <div class="stack recipes-library-stack">
        ${
          favorites.length
            ? favorites
                .map(
                  (favorite) => `
                    <article class="food-card recipe-library-card">
                      <div class="food-card-top recipe-library-top">
                        <div class="recipe-library-copy">
                          <h3>${favorite.name}</h3>
                          <p>${favorite.description || favorite.instructions || "Sačuvan recept bez dodatnog opisa."}</p>
                        </div>
                        <span class="pill strong">${favorite.items.length} ${favorite.items.length === 1 ? "sastojak" : "sastojka"}</span>
                      </div>
                      <div class="pill-row recipe-library-pills">
                        <span class="pill">${favorite.mealLabel || favorite.name}</span>
                        <span class="pill">${favorite.servings} ${favorite.servings === 1 ? "porcija" : favorite.servings < 5 ? "porcije" : "porcija"}</span>
                        ${
                          favorite.prepTimeMinutes
                            ? `<span class="pill note">${favorite.prepTimeMinutes} min pripreme</span>`
                            : ""
                        }
                        <span class="pill note">Ukupno ${roundValue(favorite.totals.kcal, 0)} kcal</span>
                        <span class="pill">Po porciji ${roundValue(favorite.perServingTotals.kcal, 0)} kcal</span>
                        <span class="pill">P ${roundValue(favorite.perServingTotals.protein, 1)} g</span>
                        <span class="pill">UH ${roundValue(favorite.perServingTotals.carbs, 1)} g</span>
                        <span class="pill">M ${roundValue(favorite.perServingTotals.fat, 1)} g</span>
                      </div>
                      ${
                        favorite.instructions
                          ? `<div class="recipe-library-method">${truncateText(favorite.instructions, 220)}</div>`
                          : ""
                      }
                      <div class="footer-note" style="margin-top:10px;">Sastav recepta:</div>
                      <div class="stack recipe-library-ingredients" style="margin-top:12px;">
                        ${favorite.items
                          .map(
                            (item, index) => `
                              <div class="suggestion-row">
                                <div>
                                  <strong>${item.displayName || item.foodName}</strong>
                                  <div class="footer-note">${roundValue(item.grams, 0)} g</div>
                                </div>
                                <div class="entry-actions" style="gap:8px; justify-content:flex-start; flex-wrap:wrap;">
                                  <button class="ghost-button" data-action="edit-favorite-item" data-favorite-id="${favorite.id}" data-item-index="${index}">Izmeni</button>
                                  <button class="ghost-button" data-action="add-favorite-item-to-day" data-favorite-id="${favorite.id}" data-item-index="${index}">Ubaci samo ovu</button>
                                  <button class="danger-button" data-action="delete-favorite-item" data-favorite-id="${favorite.id}" data-item-index="${index}">Obriši</button>
                                </div>
                              </div>
                            `
                          )
                          .join("")}
                      </div>
                      <div class="entry-actions" style="gap:8px; justify-content:flex-start; flex-wrap:wrap; margin-top:12px;">
                        <button class="solid-button secondary-button button-with-icon" data-action="add-favorite-meal" data-favorite-id="${favorite.id}">
                          ${renderButtonContent(favorite.servings > 1 ? `Ubaci 1 porciju` : `Ubaci u ${state.selectedWeekday}`, "apply")}
                        </button>
                        <button class="ghost-button button-with-icon" data-action="prefill-favorite-meal" data-favorite-id="${favorite.id}">
                          ${renderButtonContent("Izmeni recept", "edit")}
                        </button>
                        <button class="danger-button button-with-icon" data-action="delete-favorite-meal" data-favorite-id="${favorite.id}">
                          ${renderButtonContent("Obriši recept", "delete")}
                        </button>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Napravi prvi recept ovde, pa ćeš ga posle dodavati u plan jednim tapom.</div>`
        }
      </div>
    </section>
  `;
}

function renderTrainingTab() {
  const templates = getTrainingForDay(state.selectedWeekday);
  const favoriteTrainings = getFavoriteTrainingsDetailed();
  const logs = store.trainingLogs.filter((log) => log.weekday === state.selectedWeekday);
  const trainingBurn = getTrainingBurnForDay(state.selectedWeekday);
  const weeklyTrainingPlan = getWeeklyTrainingPlan();
  const exerciseOptions = getTrainingExerciseOptions();
  const progressGroups = getTrainingProgressGroups();
  const recentProgressLogs = [...store.trainingProgressLogs]
    .sort((a, b) => {
      const dateDiff = new Date(b.date) - new Date(a.date);
      if (dateDiff !== 0) {
        return dateDiff;
      }
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    })
    .slice(0, 10);

  return `
    <section class="section routine-overview-section">
      <div class="section-header">
        <div>
          <h2>Nedeljni plan treninga</h2>
          <p>Brz pregled cele nedelje, da odmah vidiš gde si ubacio trening a gde je odmor.</p>
        </div>
      </div>
      <div class="stats-grid">
        ${weeklyTrainingPlan
          .map(
            (day) => `
              <article class="stat-card">
                <strong>${day.weekday}</strong>
                <div class="footer-note">
                  ${day.templates.length ? day.templates.map((template) => template.name).join(", ") : "Odmor / nije uneto"}
                </div>
                <div class="pill-row">
                  <span class="pill">${day.templates.reduce((count, template) => count + template.exercises.length, 0)} vežbi</span>
                  <span class="pill">${roundValue(day.trainingBurn, 0)} kcal</span>
                  <span class="pill">${day.progressCount} logova</span>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>

    <section class="section routine-habits-section">
      <div class="section-header">
        <div>
          <h2>Trening za ${state.selectedWeekday}</h2>
          <p>Za početak možeš držati sablon vežbi i kratke beleške po danu.</p>
        </div>
      </div>
      <article class="food-card suggestion-surface training-burn-card">
        <div class="food-card-top training-burn-top">
          <div class="training-burn-copy">
            <h3>Apple Watch potrosnja</h3>
            <p>Upiši kalorije sa treninga za taj dan da plan odmah prikaže neto unos.</p>
          </div>
          <span class="pill strong">${roundValue(trainingBurn, 0)} kcal</span>
        </div>
        <form id="training-burn-form" class="form-grid split training-burn-form">
          <div class="field">
            <label for="training-burn-kcal">Potrošeno kcal</label>
            <input
              id="training-burn-kcal"
              name="burnKcal"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              placeholder="npr. 540"
              value="${trainingBurn ? roundValue(trainingBurn, 0) : ""}"
            />
          </div>
          <div class="training-burn-actions">
            <button class="solid-button secondary-button training-burn-submit" type="submit">Sačuvaj kcal</button>
          </div>
        </form>
      </article>
      <div class="stack training-template-stack">
        ${
          templates.length
            ? templates
                .map(
                  (template) => `
                    <article class="training-card training-template-card">
                      <div class="training-top">
                        <h3>${template.name}</h3>
                        <span class="pill strong">${template.exercises.length} vežbi</span>
                      </div>
                      <div class="training-exercise-list">
                        ${template.exercises
                          .map(
                            (exercise) => `
                              <div class="training-exercise-row">
                                <div class="training-exercise-copy">
                                  <strong class="training-exercise-name">${exercise.name}</strong>
                                  <div class="training-exercise-detail">${exercise.details}</div>
                                </div>
                              </div>
                            `
                          )
                          .join("")}
                      </div>
                      <div class="entry-actions" style="justify-content:flex-start; margin-top:12px;">
                        <button class="ghost-button" data-action="save-training-favorite" data-template-id="${template.id}">
                          Sačuvaj kao omiljeni
                        </button>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Još nema trening sablona za ${state.selectedWeekday}. Dodaj ga ispod.</div>`
        }
      </div>
    </section>

    <section class="section routine-tasks-section">
      <div class="section-header">
        <div>
          <h2>Omiljeni treninzi</h2>
          <p>Jednom sačuvaš trening i posle ga ubacuješ u bilo koji dan bez kucanja ispočetka.</p>
        </div>
      </div>
      <div class="stack">
        ${
          favoriteTrainings.length
            ? favoriteTrainings
                .map(
                  (training) => `
                    <article class="training-card training-favorite-card">
                      <div class="training-top">
                        <h3>${training.name}</h3>
                        <span class="pill strong">${training.exerciseCount} vežbi</span>
                      </div>
                      <div class="training-favorite-copy">${training.exercises.map((exercise) => exercise.details).join(" · ")}</div>
                      <div class="entry-actions" style="justify-content:flex-start; margin-top:12px;">
                        <button class="solid-button secondary-button" data-action="apply-favorite-training" data-favorite-training-id="${training.id}">
                          Ubaci u ${state.selectedWeekday}
                        </button>
                        <button class="danger-button" data-action="delete-favorite-training" data-favorite-training-id="${training.id}">
                          Obriši
                        </button>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Sačuvaj jedan trening kao omiljeni i ovde ćeš ga posle ubacivati u bilo koji dan.</div>`
        }
      </div>
    </section>

    <section class="section routine-weekly-section">
      <div class="section-header">
        <div>
          <h2>Dodaj trening sablon</h2>
          <p>Jedan red je jedna vežba. Možeš odmah da biraš i za koji dan u nedelji ga čuvaš.</p>
        </div>
      </div>
      <form id="training-form" class="form-grid">
        <div class="field">
          <label for="training-weekday">Dan</label>
          <select id="training-weekday" name="weekday" required>
            ${WEEKDAYS.map(
              (weekday) => `
                <option value="${weekday}" ${weekday === state.selectedWeekday ? "selected" : ""}>${weekday}</option>
              `
            ).join("")}
          </select>
        </div>
        <div class="field">
          <label for="training-name">Naziv treninga</label>
          <input id="training-name" name="name" placeholder="npr. Noge" required />
        </div>
        <div class="field">
          <label for="training-exercises">Vežbe</label>
          <textarea id="training-exercises" name="exercises" placeholder="Cucanj 4x8-10&#10;Rumunsko mrtvo 4x10&#10;Iskorak 3x12"></textarea>
        </div>
        <button class="solid-button" type="submit">Sačuvaj sablon</button>
      </form>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Progres po vežbi</h2>
          <p>Upiši kilažu za vežbu i prati kako napreduješ kroz vreme.</p>
        </div>
      </div>
      <form id="training-progress-form" class="form-grid split">
        <div class="field date-field">
          <label for="progress-date">Datum</label>
          <input id="progress-date" name="date" type="date" value="${getTodayDateValue()}" required />
        </div>
        <div class="field">
          <label for="progress-weekday">Dan</label>
          <select id="progress-weekday" name="weekday" required>
            ${WEEKDAYS.map(
              (weekday) => `
                <option value="${weekday}" ${weekday === state.selectedWeekday ? "selected" : ""}>${weekday}</option>
              `
            ).join("")}
          </select>
        </div>
        <div class="field">
          <label for="progress-exercise">Vezba</label>
          <input id="progress-exercise" name="exerciseName" list="training-exercise-options" placeholder="npr. Cucanj" required />
          <datalist id="training-exercise-options">
            ${exerciseOptions.map((name) => `<option value="${name}"></option>`).join("")}
          </datalist>
        </div>
        <div class="field">
          <label for="progress-weight">Kilaža</label>
          <input id="progress-weight" name="weightKg" type="number" step="0.5" min="0" placeholder="npr. 80" required />
        </div>
        <div class="field">
          <label for="progress-reps">Serije / ponavljanja</label>
          <input id="progress-reps" name="reps" placeholder="npr. 4x8" />
        </div>
        <div class="field">
          <label for="progress-note">Napomena</label>
          <input id="progress-note" name="note" placeholder="npr. lagano, ostalo jos" />
        </div>
        <button class="solid-button secondary-button" type="submit">Sačuvaj unos</button>
      </form>
      <div class="chart-grid" style="margin-top:14px;">
        ${
          progressGroups.length
            ? progressGroups.map((group) => renderExerciseProgressCard(group)).join("")
            : `<div class="empty">Dodaj prvi unos kilaže za neku vežbu pa će se ovde pojaviti progres.</div>`
        }
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Poslednji unosi opterecenja</h2>
          <p>Brza istorija zadnjih kilaža po vežbama.</p>
        </div>
      </div>
      <div class="stack">
        ${
          recentProgressLogs.length
            ? recentProgressLogs
                .map(
                  (log) => `
                    <article class="food-card">
                      <div class="food-card-top">
                        <strong>${log.exerciseName}</strong>
                        <button class="danger-button" data-action="delete-training-progress" data-progress-id="${log.id}">Obriši</button>
                      </div>
                      <div class="pill-row">
                        <span class="pill strong">${roundValue(log.weightKg, 1)} kg</span>
                        <span class="pill">${new Date(log.date).toLocaleDateString("sr-RS")}</span>
                        <span class="pill">${log.weekday}</span>
                        ${log.reps ? `<span class="pill">${log.reps}</span>` : ""}
                      </div>
                      <div class="footer-note">${log.note || "Bez napomene"}</div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Još nema sačuvanih unosa opterećenja.</div>`
        }
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Beleske</h2>
          <p>Kratak log ako hoćeš da zabeležiš kako je prošao trening.</p>
        </div>
      </div>
      <form id="training-log-form" class="form-grid">
        <div class="field">
          <label for="training-note">Beleska</label>
          <textarea id="training-note" name="note" placeholder="Npr. čučanj lagan, povećati težinu sledeći put"></textarea>
        </div>
        <button class="solid-button secondary-button" type="submit">Sačuvaj belešku</button>
      </form>
      <div class="stack" style="margin-top:14px;">
        ${
          logs.length
            ? logs
                .map(
                  (log) => `
                    <article class="food-card">
                      <div class="food-card-top">
                        <strong>${log.createdAt}</strong>
                        <button class="danger-button" data-action="delete-training-log" data-log-id="${log.id}">Obriši</button>
                      </div>
                      <div class="footer-note">${log.note}</div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Još nema beleški za ovaj dan.</div>`
        }
      </div>
    </section>
  `;
}

function renderRoutineTab() {
  const summary = getRoutineSummaryForDay(state.selectedWeekday);
  const editingHabit = state.editingHabitId ? store.habits.find((habit) => habit.id === state.editingHabitId) : null;
  const editingTask = state.editingTaskId ? store.dayTasks.find((task) => task.id === state.editingTaskId) : null;
  const habitTrackingMode = editingHabit?.trackingMode === "streak" ? "streak" : "weekly";
  const selectedDayIndex = WEEKDAYS.indexOf(state.selectedWeekday);
  const previousWeekday = selectedDayIndex > 0 ? WEEKDAYS[selectedDayIndex - 1] : "";
  const previousDayTaskCount = previousWeekday ? getTasksForDay(previousWeekday).length : 0;
  const weeklyHabitProgress = WEEKDAYS.map((weekday) => {
    const doneCount = summary.habits.filter((habit) => isHabitDoneForDay(habit, weekday)).length;
    return {
      weekday,
      doneCount,
      totalCount: summary.habits.length,
      progress: summary.habits.length ? roundValue((doneCount / summary.habits.length) * 100, 0) : 0,
    };
  });
  const topStreakHabit = [...summary.streakHabits].sort(
    (left, right) => getHabitCurrentStreakDays(right) - getHabitCurrentStreakDays(left)
  )[0];

  return `
    <section class="section routine-overview-section">
      <div class="section-header">
        <div>
          <h2>Rutina za ${state.selectedWeekday}</h2>
          <p>Velike navike, sitni taskovi i dugoročni streakovi, sve na jednom mestu.</p>
        </div>
      </div>
      <div class="hero-day-picker routine-day-picker">
        <div class="hero-picker-label">Dan u nedelji</div>
        <div class="chips" style="margin-top:12px;">
          ${WEEKDAYS.map(
            (weekday) => `
              <button class="chip ${weekday === state.selectedWeekday ? "is-active" : ""}" data-action="select-weekday" data-weekday="${weekday}">
                ${weekday.slice(0, 3)}
              </button>
            `
          ).join("")}
        </div>
      </div>
      <div class="stats-grid routine-summary-grid" style="margin-top:14px;">
        <article class="stat-card">
          <strong>Ukupno za danas</strong>
          <div class="macro-value">${summary.progress}%</div>
          <div class="footer-note">${summary.doneItems} od ${summary.totalItems || 0} čekirano</div>
        </article>
        <article class="stat-card">
          <strong>Nedeljne navike</strong>
          <div class="macro-value">${summary.doneHabits}/${summary.habits.length}</div>
          <div class="footer-note">Završeno za ${state.selectedWeekday}</div>
        </article>
        <article class="stat-card">
          <strong>Taskovi</strong>
          <div class="macro-value">${summary.doneTasks}/${summary.tasks.length}</div>
          <div class="footer-note">Dnevne obaveze</div>
        </article>
        <article class="stat-card">
          <strong>Dugoročni streakovi</strong>
          <div class="macro-value">${summary.streakHabits.length}</div>
          <div class="footer-note">
            ${
              summary.longestStreakDays
                ? `Najduži aktivni ${getDayCountLabel(summary.longestStreakDays)}`
                : "Dodaj prvi streak i kreni da brojiš"
            }
          </div>
        </article>
      </div>
    </section>

    <section class="section routine-habits-section">
      <div class="section-header">
        <div>
          <h2>Nedeljne navike</h2>
          <p>Npr. 10k koraka, čitanje ili bez slatkiša. Čekiraš kad ispuniš za izabrani dan.</p>
        </div>
      </div>
      <form id="habit-form" class="form-grid split routine-habit-form">
        <div class="field">
          <label for="habit-name">${editingHabit ? "Naziv navike" : "Nova navika"}</label>
          <input
            id="habit-name"
            name="name"
            placeholder="npr. 10k koraka ili bez alkohola"
            value="${editingHabit?.name || ""}"
            required
          />
        </div>
        <div class="field">
          <label for="habit-tracking-mode">Tip praćenja</label>
          <select id="habit-tracking-mode" name="trackingMode">
            <option value="weekly" ${habitTrackingMode === "weekly" ? "selected" : ""}>Nedeljna navika</option>
            <option value="streak" ${habitTrackingMode === "streak" ? "selected" : ""}>Dugoročni streak</option>
          </select>
        </div>
        <div class="field">
          <label for="habit-note">Opis / cilj</label>
          <input id="habit-note" name="note" placeholder="npr. svaki dan, makar 10 min" value="${editingHabit?.note || ""}" />
        </div>
        <div class="field">
          <label for="habit-start-date">Brojanje od</label>
          <input
            id="habit-start-date"
            name="streakStartDate"
            type="date"
            value="${editingHabit?.trackingMode === "streak" ? editingHabit.streakStartDate || "" : ""}"
          />
        </div>
        <div class="footer-note routine-habit-form-note">
          Za streak naviku upiši naziv onako kako želiš da piše u evidenciji, npr. "bez alkohola". Ako ostane
          nedeljna navika, datum se ignoriše.
        </div>
        <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap;">
          <button class="solid-button" type="submit">${editingHabit ? "Sačuvaj izmenu" : "Dodaj naviku"}</button>
          ${editingHabit ? '<button class="ghost-button" type="button" data-action="cancel-edit-habit">Odustani</button>' : ""}
        </div>
      </form>
      <div class="stack" style="margin-top:14px;">
        ${
          summary.habits.length
            ? summary.habits
                .map(
                  (habit) => `
                    <article class="food-card routine-card">
                      <div class="routine-row">
                        <label class="routine-check">
                          <input
                            type="checkbox"
                            class="routine-checkbox"
                            data-action="toggle-habit-day"
                            data-habit-id="${habit.id}"
                            ${isHabitDoneForDay(habit, state.selectedWeekday) ? "checked" : ""}
                          />
                          <span class="routine-check-ui" aria-hidden="true"></span>
                        </label>
                        <div class="routine-content">
                          <strong>${habit.name}</strong>
                          <div class="footer-note">${habit.note || "Bez dodatne napomene"}</div>
                          <div class="pill-row">
                            <span class="pill">${getHabitWeeklyCount(habit)}/7 dana</span>
                            <span class="pill note">${isHabitDoneForDay(habit, state.selectedWeekday) ? "Označeno danas" : "Čeka za danas"}</span>
                          </div>
                        </div>
                        <div class="entry-actions" style="justify-content:flex-start; margin-top:0;">
                          <button class="ghost-button" data-action="edit-habit" data-habit-id="${habit.id}">Izmeni</button>
                          <button class="danger-button" data-action="delete-habit" data-habit-id="${habit.id}">Obriši</button>
                        </div>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Dodaj prvu nedeljnu naviku i prati je kroz dane u nedelji.</div>`
        }
      </div>
    </section>

    <section class="section routine-streak-section">
      <div class="section-header">
        <div>
          <h2>Dugoročni streakovi</h2>
          <p>Za stvari koje meriš na duže staze, tipa bez alkohola, bez cigareta ili doslednost mesecima.</p>
        </div>
      </div>
      ${
        topStreakHabit
          ? `
            <article class="routine-streak-spotlight">
              <div>
                <div class="routine-streak-spotlight-label">Najduži aktivni streak</div>
                <h3>${topStreakHabit.name}</h3>
                <p>${getHabitStreakSentence(topStreakHabit)}</p>
              </div>
              <div class="routine-streak-spotlight-metric">
                <span>${getHabitCurrentStreakDays(topStreakHabit)}</span>
                <small>${getHabitCurrentStreakDays(topStreakHabit) === 1 ? "dan" : "dana"}</small>
              </div>
            </article>
          `
          : ""
      }
      <div class="stack routine-streak-stack" style="margin-top:${topStreakHabit ? "16px" : "0"};">
        ${
          summary.streakHabits.length
            ? summary.streakHabits
                .map((habit) => {
                  const currentStreakDays = getHabitCurrentStreakDays(habit);
                  const bestStreakDays = getHabitBestStreakDays(habit);
                  const startedLabel = formatDateValueLabel(habit.streakStartDate);
                  const lastResetLabel = formatDateValueLabel(habit.lastResetAt);

                  return `
                    <article class="food-card routine-card routine-streak-card">
                      <div class="routine-streak-card-layout">
                        <div class="routine-streak-meter">
                          <span class="routine-streak-value">${currentStreakDays}</span>
                          <span class="routine-streak-unit">${currentStreakDays === 1 ? "dan" : "dana"}</span>
                        </div>
                        <div class="routine-content routine-streak-content">
                          <strong>${habit.name}</strong>
                          <div class="footer-note">${habit.note || "Dugoročna evidencija je uključena za ovu naviku."}</div>
                          <div class="pill-row">
                            <span class="pill strong">${getHabitStreakSentence(habit)}</span>
                            ${startedLabel ? `<span class="pill">Od ${startedLabel}</span>` : ""}
                            <span class="pill">Najduže ${getDayCountLabel(bestStreakDays)}</span>
                            <span class="pill note">${habit.resetCount ? `Resetovano ${habit.resetCount}x` : "Bez reseta"}</span>
                            ${lastResetLabel ? `<span class="pill note">Poslednji reset ${lastResetLabel}</span>` : ""}
                          </div>
                        </div>
                        <div class="entry-actions routine-streak-actions" style="justify-content:flex-start; margin-top:0;">
                          <button class="ghost-button" data-action="reset-habit-streak" data-habit-id="${habit.id}">Resetuj</button>
                          <button class="ghost-button" data-action="edit-habit" data-habit-id="${habit.id}">Izmeni</button>
                          <button class="danger-button" data-action="delete-habit" data-habit-id="${habit.id}">Obriši</button>
                        </div>
                      </div>
                    </article>
                  `;
                })
                .join("")
            : `<div class="empty">Dodaj prvi streak i dobićeš brojač tipa "90 dana bez alkohola".</div>`
        }
      </div>
    </section>

    <section class="section routine-tasks-section">
      <div class="section-header">
        <div>
          <h2>Taskovi za ${state.selectedWeekday}</h2>
          <p>Sitne dnevne obaveze, tipa raspremi krevet ili spremi ručak.</p>
        </div>
      </div>
      <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
        ${
          previousWeekday && previousDayTaskCount
            ? `<button class="ghost-button" data-action="copy-previous-day-tasks">Kopiraj iz ${previousWeekday}</button>`
            : ""
        }
        ${
          summary.tasks.some((task) => task.done)
            ? '<button class="ghost-button" data-action="clear-completed-tasks">Obriši završene</button>'
            : ""
        }
      </div>
      <form id="task-form" class="form-grid split">
        <div class="field">
          <label for="task-title">${editingTask ? "Izmena taska" : "Novi task"}</label>
          <input id="task-title" name="title" placeholder="npr. Spremi ručak" value="${editingTask?.title || ""}" required />
        </div>
        <div class="field">
          <label for="task-note">Napomena</label>
          <input id="task-note" name="note" placeholder="opciono" value="${editingTask?.note || ""}" />
        </div>
        <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap;">
          <button class="solid-button secondary-button" type="submit">${editingTask ? "Sačuvaj izmenu" : "Dodaj task"}</button>
          ${editingTask ? '<button class="ghost-button" type="button" data-action="cancel-edit-task">Odustani</button>' : ""}
        </div>
      </form>
      <div class="stack" style="margin-top:14px;">
        ${
          summary.tasks.length
            ? summary.tasks
                .map(
                  (task) => `
                    <article class="food-card routine-card">
                      <div class="routine-row">
                        <label class="routine-check">
                          <input
                            type="checkbox"
                            class="routine-checkbox"
                            data-action="toggle-task-done"
                            data-task-id="${task.id}"
                            ${task.done ? "checked" : ""}
                          />
                          <span class="routine-check-ui" aria-hidden="true"></span>
                        </label>
                        <div class="routine-content">
                          <strong>${task.title}</strong>
                          <div class="footer-note">${task.note || "Bez dodatne napomene"}</div>
                        </div>
                        <div class="entry-actions" style="justify-content:flex-start; margin-top:0;">
                          <button class="ghost-button" data-action="edit-task" data-task-id="${task.id}">Izmeni</button>
                          <button class="danger-button" data-action="delete-task" data-task-id="${task.id}">Obriši</button>
                        </div>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Još nema taskova za ${state.selectedWeekday}. Dodaj prvi pa čekiraj kad završiš.</div>`
        }
      </div>
    </section>

    <section class="section routine-weekly-section">
      <div class="section-header">
        <div>
          <h2>Nedeljni pregled navika</h2>
          <p>Kratak pregled koliko si nedeljnih navika ispunio po danima.</p>
        </div>
      </div>
      ${
        summary.habits.length
          ? `
            <div class="stats-grid">
              ${weeklyHabitProgress
                .map(
                  (day) => `
                    <article class="stat-card">
                      <strong>${day.weekday}</strong>
                      <div class="macro-value">${day.progress}%</div>
                      <div class="footer-note">${day.doneCount}/${day.totalCount} navika</div>
                    </article>
                  `
                )
                .join("")}
            </div>
          `
          : `<div class="empty">Kad dodaš nedeljne navike, ovde ćeš videti pregled po danima.</div>`
      }
    </section>
  `;
}

function renderGoalsTab() {
  const weeklyOverview = getWeeklyOverview();
  const goalRecommendation = getGoalRecommendation();
  const editingSupplement = state.editingSupplementId
    ? store.supplements.find((supplement) => supplement.id === state.editingSupplementId)
    : null;
  const weeklyMetrics = [
    {
      label: "Kalorije",
      value: roundValue(weeklyOverview.totals.kcal, 0),
      goal: roundValue(weeklyOverview.goals.kcal, 0),
      unit: "kcal",
      note: formatPlanDelta(weeklyOverview.totals.kcal - weeklyOverview.goals.kcal, "kcal"),
    },
    {
      label: "Proteini",
      value: roundValue(weeklyOverview.totals.protein, 1),
      goal: weeklyOverview.goals.protein,
      unit: "g",
      note: formatPlanDelta(weeklyOverview.totals.protein - weeklyOverview.goals.protein, "g"),
    },
    {
      label: "Ugljeni hidrati",
      value: roundValue(weeklyOverview.totals.carbs, 1),
      goal: weeklyOverview.goals.carbs,
      unit: "g",
      note: formatPlanDelta(weeklyOverview.totals.carbs - weeklyOverview.goals.carbs, "g"),
    },
    {
      label: "Masti",
      value: roundValue(weeklyOverview.totals.fat, 1),
      goal: weeklyOverview.goals.fat,
      unit: "g",
      note: formatPlanDelta(weeklyOverview.totals.fat - weeklyOverview.goals.fat, "g"),
    },
  ];

  return `
    <section class="section goals-profile-section">
      ${renderSectionLead("Profil i ciljevi", "BMR, održavanje i dnevni cilj sada možeš da računaš iz profila i izabranog cilja.", { eyebrow: "Metabolizam" })}
      <div class="stats-grid goals-insight-grid">
        <article class="stat-card">
          <strong>Bazalni metabolizam</strong>
          <div class="macro-value">${goalRecommendation ? `${goalRecommendation.bmr} kcal` : "—"}</div>
          <div class="footer-note">${goalRecommendation ? "Telo troši i u mirovanju" : "Unesi pol, godine, visinu i težinu"}</div>
        </article>
        <article class="stat-card">
          <strong>Održavanje</strong>
          <div class="macro-value">${goalRecommendation ? `${goalRecommendation.maintenance} kcal` : "—"}</div>
          <div class="footer-note">${goalRecommendation ? goalRecommendation.activity.label : "Treba i nivo aktivnosti"}</div>
        </article>
        <article class="stat-card">
          <strong>Cilj</strong>
          <div class="macro-value">${goalRecommendation ? `${goalRecommendation.targetCalories} kcal` : "—"}</div>
          <div class="footer-note">${goalRecommendation ? goalRecommendation.goalMode.label : "Izaberi cilj"}</div>
        </article>
        <article class="stat-card">
          <strong>Preporučeni makroi</strong>
          <div class="macro-value">${goalRecommendation ? `${goalRecommendation.protein} / ${goalRecommendation.carbs} / ${goalRecommendation.fat}` : "—"}</div>
          <div class="footer-note">P / UH / Masti</div>
        </article>
      </div>
      <form id="goals-form" class="form-grid split goals-form-layout">
        <div class="field">
          <label for="profile-name">Ime</label>
          <input id="profile-name" name="name" value="${store.profile.name || ""}" />
        </div>
        <div class="field">
          <label for="profile-sex">Pol</label>
          <select id="profile-sex" name="sex">
            <option value="">Izaberi</option>
            <option value="male" ${store.profile.sex === "male" ? "selected" : ""}>Muško</option>
            <option value="female" ${store.profile.sex === "female" ? "selected" : ""}>Žensko</option>
          </select>
        </div>
        <div class="field">
          <label for="profile-age">Godine</label>
          <input id="profile-age" name="age" type="number" min="0" value="${store.profile.age || ""}" />
        </div>
        <div class="field">
          <label for="profile-weight">Težina (kg)</label>
          <input id="profile-weight" name="weightKg" type="number" step="0.1" min="0" value="${store.profile.weightKg || ""}" />
        </div>
        <div class="field">
          <label for="profile-height">Visina (cm)</label>
          <input id="profile-height" name="heightCm" type="number" step="1" min="0" value="${store.profile.heightCm || ""}" />
        </div>
        <div class="field">
          <label for="profile-activity">Aktivnost</label>
          <select id="profile-activity" name="activityLevel">
            ${ACTIVITY_LEVELS.map((activity) => `<option value="${activity.id}" ${store.profile.activityLevel === activity.id ? "selected" : ""}>${activity.label}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="goal-target-mode">Cilj</label>
          <select id="goal-target-mode" name="targetMode">
            ${GOAL_MODES.map((mode) => `<option value="${mode.id}" ${store.goals.targetMode === mode.id ? "selected" : ""}>${mode.label}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="goal-calories">Dnevni cilj kcal</label>
          <input id="goal-calories" name="calories" type="number" step="1" min="0" value="${store.goals.calories || ""}" />
        </div>
        <div class="field">
          <label for="goal-protein">Proteini</label>
          <input id="goal-protein" name="protein" type="number" step="0.1" min="0" value="${store.goals.protein || ""}" />
        </div>
        <div class="field">
          <label for="goal-carbs">Ugljeni hidrati</label>
          <input id="goal-carbs" name="carbs" type="number" step="0.1" min="0" value="${store.goals.carbs || ""}" />
        </div>
        <div class="field">
          <label for="goal-fat">Masti</label>
          <input id="goal-fat" name="fat" type="number" step="0.1" min="0" value="${store.goals.fat || ""}" />
        </div>
        <div class="meta-row">
          <button class="ghost-button" type="button" data-action="recalculate-goals">Izračunaj iz cilja</button>
          <button class="solid-button" type="submit">Sačuvaj ciljeve</button>
        </div>
      </form>
    </section>

    <section class="section goals-supplements-section">
      ${renderSectionLead("Vitamini i suplementi", "Dodaj šta piješ i kada, pa ćeš u Planu dobiti dnevni checkbox pregled.", { eyebrow: "Rutina" })}
      <form id="supplement-form" class="form-grid split goals-form-layout">
        <div class="field">
          <label for="supplement-name">${editingSupplement ? "Izmena suplementa" : "Novi suplement"}</label>
          <input id="supplement-name" name="name" placeholder="npr. Vitamin D3" value="${editingSupplement?.name || ""}" required />
        </div>
        <div class="field">
          <label for="supplement-timing">Kada se uzima</label>
          <select id="supplement-timing" name="timing">
            ${SUPPLEMENT_TIMINGS.map((timing) => `<option value="${timing.id}" ${(editingSupplement?.timing || "breakfast") === timing.id ? "selected" : ""}>${timing.label}</option>`).join("")}
          </select>
        </div>
        <div class="field supplement-weekdays-field">
          <label>Za koje dane</label>
          <div class="chips weekday-choice-grid">
            ${WEEKDAYS.map((weekday) => {
              const checked = editingSupplement
                ? (editingSupplement.weekdays || []).includes(weekday)
                : true;
              return `
                <label class="chip weekday-choice ${checked ? "is-active" : ""}">
                  <input type="checkbox" name="supplementWeekday" value="${weekday}" ${checked ? "checked" : ""} />
                  <span>${weekday.slice(0, 3)}</span>
                </label>
              `;
            }).join("")}
          </div>
        </div>
        <div class="field">
          <label for="supplement-note">Napomena</label>
          <input id="supplement-note" name="note" placeholder="npr. posle obroka, uz magnezijum" value="${editingSupplement?.note || ""}" />
        </div>
        <div class="meta-row">
          <button class="solid-button secondary-button" type="submit">${editingSupplement ? "Sačuvaj izmenu" : "Dodaj suplement"}</button>
          ${editingSupplement ? '<button class="ghost-button" type="button" data-action="cancel-edit-supplement">Odustani</button>' : ""}
        </div>
      </form>
      <div class="stack" style="margin-top:14px;">
        ${
          getSupplements().length
            ? getSupplements()
                .map(
                  (supplement) => `
                    <article class="food-card routine-card supplement-card">
                      <div class="routine-row">
                        <div class="routine-content">
                          <strong>${supplement.name}</strong>
                          <div class="footer-note">${supplement.note || "Bez dodatne napomene"}</div>
                          <div class="pill-row">
                            <span class="pill strong">${getSupplementTimingLabel(supplement.timing)}</span>
                            <span class="pill">${(supplement.weekdays || WEEKDAYS).length === WEEKDAYS.length ? "Svaki dan" : (supplement.weekdays || []).map((weekday) => weekday.slice(0, 3)).join(", ")}</span>
                          </div>
                        </div>
                        <div class="entry-actions" style="justify-content:flex-start; margin-top:0;">
                          <button class="ghost-button" data-action="edit-supplement" data-supplement-id="${supplement.id}">Izmeni</button>
                          <button class="danger-button" data-action="delete-supplement" data-supplement-id="${supplement.id}">Obriši</button>
                        </div>
                      </div>
                    </article>
                  `
                )
                .join("")
            : '<div class="empty">Dodaj prvi vitamin ili suplement, pa će se pojaviti i u dnevnom Planu.</div>'
        }
      </div>
    </section>

    <section class="section goals-weekly-section">
      ${renderSectionLead("Nedeljni nivo", "Zbir za svih 7 dana, da odmah vidiš da li si u kalorijama i makroima na nivou cele nedelje.", { eyebrow: "Pregled" })}
      <div class="stats-grid">
        <article class="stat-card">
          <strong>Uneto kcal</strong>
          <div class="macro-value">${roundValue(weeklyOverview.totals.kcal, 0)} kcal</div>
          <div class="footer-note">${formatPlanDelta(weeklyOverview.totals.kcal - weeklyOverview.goals.kcal, "kcal")}</div>
        </article>
        <article class="stat-card">
          <strong>Nedeljni cilj</strong>
          <div class="macro-value">${roundValue(weeklyOverview.goals.kcal, 0)} kcal</div>
          <div class="footer-note">${WEEKDAYS.length} x dnevni cilj</div>
        </article>
        <article class="stat-card">
          <strong>Potrošeno trening</strong>
          <div class="macro-value">${roundValue(weeklyOverview.totals.trainingBurn, 0)} kcal</div>
          <div class="footer-note">Zbir Apple Watch unosa</div>
        </article>
        <article class="stat-card">
          <strong>Neto kcal</strong>
          <div class="macro-value">${weeklyOverview.netKcal} kcal</div>
          <div class="footer-note">Uneto minus trening</div>
        </article>
      </div>
      <div style="margin-top:14px;">
        ${renderMetricsGrid(weeklyMetrics)}
      </div>
    </section>

    <section class="section goals-days-section">
      ${renderSectionLead("Pregled po danima", "Svaki dan sa kalorijama i razlikom u odnosu na dnevni cilj.", { eyebrow: "Nedelja" })}
      <div class="stats-grid">
        ${weeklyOverview.days
          .map(
            (day) => `
              <article class="stat-card">
                <strong>${day.weekday}</strong>
                <div class="macro-value">${roundValue(day.totals.kcal, 0)} kcal</div>
                <div class="footer-note">${formatPlanDelta(day.goalDelta, "kcal")}</div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderNutritionSourcePills(sourceDocNames = []) {
  const names = mergeUniqueStrings(sourceDocNames);
  if (!names.length) {
    return "";
  }

  return `
    <div class="pill-row">
      ${names.map((name) => `<span class="pill note">${escapeHtml(name)}</span>`).join("")}
    </div>
  `;
}

function renderNutritionPlansSection(plans) {
  if (!plans.length) {
    return `
      <section class="section nutrition-plan-section">
        ${renderSectionLead("Jelovnik nutricioniste", "Kad uvezeš jelovnik po danima, ovde ćeš dobiti pregled kao mini plan koji možeš da prebaciš u svoj dnevni Plan.", {
          eyebrow: "Plan",
        })}
        <div class="empty">Još nema uvezenog jelovnika po danima. Ubaci dokument tipa "JELOVNIK ZA 14 DANA" da ovde dobiješ pregled po danima i obrocima.</div>
      </section>
    `;
  }

  const selectedPlan = getNutritionPlanById(state.nutritionSelectedPlanId) || plans[0];
  const selectedPlanNotes = (selectedPlan?.notes || []).filter(Boolean);
  const readyMealCount = (selectedPlan?.meals || []).filter((meal) => getNutritionPlanMealApplyItems(meal).length).length;

  return `
    <section class="section nutrition-plan-section">
      ${renderSectionLead("Jelovnik nutricioniste", "Pregled 14-dnevnog jelovnika po danima. Kad želiš, ceo dan možeš da prebaciš u svoj Plan i onda ga dalje menjaš.", {
        eyebrow: "Plan",
      })}
      <div class="chips nutrition-plan-chips">
        ${plans
          .map(
            (plan) => `
              <button class="chip ${plan.id === selectedPlan.id ? "is-active" : "is-light"}" data-action="select-nutrition-plan-day" data-plan-id="${plan.id}">
                ${escapeHtml(plan.dayNumber ? `${plan.dayNumber}. dan` : plan.title)}
              </button>
            `
          )
          .join("")}
      </div>
      <article class="food-card nutrition-plan-day-card">
        <div class="food-card-top nutrition-plan-day-top">
          <div>
            <strong>${escapeHtml(selectedPlan.title)}</strong>
            <div class="footer-note">${escapeHtml(selectedPlan.weekdayLabel || "Dan iz jelovnika nutricioniste")}</div>
          </div>
          <div class="pill-row">
            <span class="pill strong">${selectedPlan.meals.length} ${selectedPlan.meals.length === 1 ? "obrok" : "obroka"}</span>
            <span class="pill ${readyMealCount ? "pill--success" : "pill--warning"}">${readyMealCount} spremno za prebacivanje</span>
          </div>
        </div>
        ${
          selectedPlanNotes.length
            ? `
              <div class="empty nutrition-plan-notes">
                ${selectedPlanNotes.map((note) => `<div>${escapeHtml(note)}</div>`).join("")}
              </div>
            `
            : ""
        }
        <div class="entry-actions entry-actions--start nutrition-plan-actions">
          <button class="solid-button secondary-button button-with-icon" data-action="apply-nutrition-plan-day" data-plan-id="${selectedPlan.id}" data-mode="replace">
            ${renderButtonContent(`Primeni u ${state.selectedWeekday}`, "apply")}
          </button>
          <button class="ghost-button button-with-icon" data-action="apply-nutrition-plan-day" data-plan-id="${selectedPlan.id}" data-mode="append">
            ${renderButtonContent(`Dodaj u ${state.selectedWeekday}`, "add")}
          </button>
        </div>
      </article>
      <div class="stack nutrition-plan-meals">
        ${selectedPlan.meals
          .map((meal) => {
            const applyItems = getNutritionPlanMealApplyItems(meal);
            const mealTotals = meal.totals || { kcal: 0, protein: 0, carbs: 0, fat: 0 };
            return `
              <article class="meal-card nutrition-plan-meal-card">
                <div class="meal-card-topline">
                  <div class="meal-card-heading">
                    <h3 class="meal-title">${escapeHtml(meal.title)}</h3>
                    <div class="footer-note">${escapeHtml(meal.linkedRecipeName ? `Povezano sa receptom: ${meal.linkedRecipeName}` : "Obrok iz jelovnika nutricioniste")}</div>
                  </div>
                  <span class="pill ${applyItems.length ? "pill--success" : "pill--warning"}">${applyItems.length ? "Može u plan" : "Samo kao hint"}</span>
                </div>
                <div class="pill-row">
                  <span class="pill note">${roundValue(mealTotals.kcal, 0)} kcal</span>
                  <span class="pill">P ${roundValue(mealTotals.protein, 1)} g</span>
                  <span class="pill">UH ${roundValue(mealTotals.carbs, 1)} g</span>
                  <span class="pill">M ${roundValue(mealTotals.fat, 1)} g</span>
                </div>
                ${
                  meal.items?.length
                    ? `
                      <div class="recipe-library-ingredients suggestion-row nutrition-inline-list">
                        ${meal.items
                          .map(
                            (item) => `
                              <span class="pill">${escapeHtml(item.displayName || item.foodName)} · ${roundValue(item.grams, 0)} g</span>
                            `
                          )
                          .join("")}
                      </div>
                    `
                    : ""
                }
                <div class="footer-note">${escapeHtml(meal.notes || meal.text || "")}</div>
                ${
                  meal.instructions
                    ? `<div class="footer-note nutrition-plan-instructions">Priprema: ${escapeHtml(truncateText(meal.instructions, 220))}</div>`
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </div>
      ${renderNutritionSourcePills(selectedPlan.sourceDocNames)}
    </section>
  `;
}

function renderNutritionTab() {
  const documents = getNutritionDocuments();
  const recommendations = getNutritionRecommendations();
  const plans = getNutritionPlans();
  const importedFoods = getNutritionImportedFoodsDetailed()
    .map((food) => ({
      ...food,
      nutritionStatus: getFoodNutritionStatus(food),
    }))
    .sort(
      (left, right) =>
        Number(right.nutritionStatus.needsAttention) - Number(left.nutritionStatus.needsAttention) ||
        left.name.localeCompare(right.name, "sr")
    );
  const reviewImportedFoods = importedFoods.filter((food) => food.nutritionStatus.needsAttention);
  const importedRecipes = getNutritionImportedRecipesDetailed();
  const importedFoodsMissingValues = reviewImportedFoods.length;
  const importedFoodsReviewedCount = Math.max(importedFoods.length - reviewImportedFoods.length, 0);
  const nutritionEditingFood = importedFoods.find((food) => food.id === state.nutritionEditingFoodId) || null;
  const nutritionLinkCandidates = nutritionEditingFood ? getImportedFoodLinkCandidates(nutritionEditingFood) : [];
  const hasImportArchiveContent = Boolean(documents.length || plans.length || recommendations.length || importedFoods.length || importedRecipes.length);
  const lastImportedAt = store.nutritionLibrary?.lastImportedAt
    ? new Date(store.nutritionLibrary.lastImportedAt).toLocaleString("sr-RS")
    : "";
  const importStatus = state.nutritionImportPending
    ? state.nutritionImportStatus || "Obrađujem dokumente..."
    : documents.length
      ? "Import arhiva"
      : "Spremno za prvi unos";

  return `
    <section class="section nutrition-overview-section">
      ${renderSectionLead(
        "Nutricionista desk",
        "Uvezi PDF, DOCX ili tekstualne planove i app će izvući preporuke, recepte i namirnice koje možeš odmah da koristiš.",
        { eyebrow: "Nutricionista" }
      )}
      <div class="settings-grid nutrition-summary-grid">
        ${renderStatusSummaryCard({
          title: state.nutritionImportPending ? "Obrada je u toku" : "Import centar",
          detail: state.nutritionImportPending
            ? state.nutritionImportStatus || "Sačekaj da pročitam dokumente i rasporedim ih po sekcijama."
            : "Import ne briše postojeće recepte i namirnice. Samo dodaje ili osvežava ono što prepozna iz dokumenata.",
          statusLabel: importStatus,
          tone: state.nutritionImportPending ? "warning" : "info",
          pills: [
            { label: "PDF / DOCX / TXT / MD / CSV / JSON", strong: true, tone: "info" },
            { label: "Više fajlova odjednom", tone: "success" },
            ...(lastImportedAt ? [{ label: `Poslednji import ${lastImportedAt}`, tone: "warning" }] : []),
          ],
          actions: `
            <label class="solid-button secondary-button button-with-icon ${state.nutritionImportPending ? "is-disabled" : ""}" for="nutrition-import-files">
              ${renderButtonContent("Uvezi dokumente", "open")}
            </label>
            <button class="ghost-button button-with-icon" type="button" data-action="clear-nutrition-imports" ${
              !hasImportArchiveContent || state.nutritionImportPending ? "disabled" : ""
            }>
              ${renderButtonContent("Resetuj import", "delete")}
            </button>
            <input id="nutrition-import-files" type="file" accept=".pdf,.docx,.txt,.md,.csv,.json" multiple hidden />
          `,
        })}

        ${renderStatusSummaryCard({
          title: `${documents.length} dokumenata u arhivi`,
          detail: "Svaki import pamti izvor, kratak sažetak i koliko je recepata, namirnica i preporuka izvučeno.",
          statusLabel: documents.length ? "Arhiva živa" : "Još prazno",
          tone: documents.length ? "success" : "warning",
          pills: [
            { label: `${plans.length} dana u planu`, tone: "success" },
            { label: `${recommendations.length} preporuka`, tone: "info" },
            { label: `${importedRecipes.length} recepata`, tone: "success" },
            { label: `${importedFoods.length} ukupno uvezenih namirnica`, tone: "warning" },
            { label: `${importedFoodsMissingValues} čeka review`, tone: importedFoodsMissingValues ? "warning" : "success" },
            ...(importedFoodsReviewedCount ? [{ label: `${importedFoodsReviewedCount} rešeno`, tone: "success" }] : []),
          ],
          actions: `
            <button class="ghost-button button-with-icon" type="button" data-action="switch-tab" data-tab="recipes">
              ${renderButtonContent("Otvori recepte", "open")}
            </button>
            <button class="ghost-button button-with-icon" type="button" data-action="switch-tab" data-tab="foods">
              ${renderButtonContent("Otvori namirnice", "open")}
            </button>
          `,
        })}
      </div>
    </section>

    ${renderNutritionPlansSection(plans)}

    <section class="section nutrition-recommendations-section">
      ${renderSectionLead("Preporuke i smernice", "Sve što je parser prepoznao kao savet, okvir ili napomenu nutricioniste.", {
        eyebrow: "Preporuke",
      })}
      <div class="stack nutrition-recommendations-stack">
        ${
          recommendations.length
            ? recommendations
                .map(
                  (entry) => `
                    <article class="status-summary-card nutrition-note-card">
                      <div class="status-summary-copy">
                        <strong>${escapeHtml(entry.title || "Preporuka")}</strong>
                        <div class="footer-note">${escapeHtml(entry.text)}</div>
                      </div>
                      ${renderNutritionSourcePills(entry.sourceDocNames)}
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Kad uvezeš dokumente, ovde će se pojaviti saveti, smernice i napomene nutricioniste.</div>`
        }
      </div>
    </section>

    <section class="section nutrition-recipes-section">
      ${renderSectionLead("Uvezeni recepti", "Recipe blokovi iz dokumenata odmah ulaze u tvoju biblioteku recepata i odavde ih možeš ubaciti u plan.", {
        eyebrow: "Recepti",
      })}
      <div class="stack nutrition-recipes-stack">
        ${
          importedRecipes.length
            ? importedRecipes
                .map(
                  (recipe) => {
                    const pendingReviewCount = (recipe.items || []).filter((item) => {
                      const food = item.foodId ? getFoodById(item.foodId) : null;
                      return food && shouldHidePendingImportedFood(food);
                    }).length;
                    return `
                    <article class="food-card recipe-library-card nutrition-import-card">
                      <div class="food-card-top">
                        <strong>${escapeHtml(recipe.name)}</strong>
                        <span class="pill strong pill--success">${escapeHtml(recipe.mealLabel || "Recept")}</span>
                      </div>
                      <div class="footer-note">${escapeHtml(recipe.description || "Importovano iz dokumenta nutricioniste.")}</div>
                      <div class="pill-row">
                        <span class="pill">${recipe.items.length} sastojka</span>
                        <span class="pill">${recipe.servings || 1} ${recipe.servings === 1 ? "porcija" : recipe.servings < 5 ? "porcije" : "porcija"}</span>
                        <span class="pill">${recipe.prepTimeMinutes ? `${recipe.prepTimeMinutes} min` : "Vreme nije nađeno"}</span>
                        <span class="pill note">Ukupno ${roundValue(recipe.totals.kcal, 0)} kcal</span>
                        <span class="pill">Po porciji ${roundValue(recipe.perServingTotals.kcal, 0)} kcal</span>
                        <span class="pill">P ${roundValue(recipe.perServingTotals.protein, 1)} g</span>
                        <span class="pill">UH ${roundValue(recipe.perServingTotals.carbs, 1)} g</span>
                        <span class="pill">M ${roundValue(recipe.perServingTotals.fat, 1)} g</span>
                        ${pendingReviewCount ? `<span class="pill pill--warning">${pendingReviewCount} stavki čeka match</span>` : ""}
                      </div>
                      ${renderNutritionSourcePills(recipe.importSourceDocNames)}
                      <div class="recipe-library-ingredients suggestion-row nutrition-inline-list">
                        ${recipe.items
                          .map(
                            (item) =>
                              `<span class="pill">${escapeHtml(item.displayName || item.foodName)} · ${roundValue(item.grams, 0)} g</span>`
                          )
                          .join("")}
                      </div>
                      <div class="entry-actions nutrition-card-actions">
                        <button class="solid-button secondary-button button-with-icon" data-action="add-favorite-meal" data-favorite-id="${recipe.id}">
                          ${renderButtonContent(recipe.servings > 1 ? "Ubaci 1 porciju" : `Ubaci u ${state.selectedWeekday}`, "apply")}
                        </button>
                        ${
                          pendingReviewCount
                            ? `
                              <button class="ghost-button button-with-icon" data-action="switch-tab" data-tab="nutrition">
                                ${renderButtonContent("Sredi match", "edit")}
                              </button>
                            `
                            : ""
                        }
                        <button class="ghost-button button-with-icon" data-action="prefill-favorite-meal" data-favorite-id="${recipe.id}">
                          ${renderButtonContent("Izmeni recept", "edit")}
                        </button>
                      </div>
                    </article>
                  `;
                  }
                )
                .join("")
            : `<div class="empty">Ovde ćeš videti recepte koje izvučem iz dokumenata, zajedno sa sastojcima i gramažom.</div>`
        }
      </div>
    </section>

    <section class="section nutrition-foods-section">
      ${renderSectionLead("Review namirnica", "Ovde ostaju samo stavke koje još treba da potvrdiš. Kad dodaš makroe ili ih obrišeš kao duplikat, nestaju iz ove liste i ostaju rešene u Namirnice.", {
        eyebrow: "Namirnice",
      })}
      <div class="stack nutrition-foods-stack">
        ${
          nutritionEditingFood
            ? `
              <article class="food-card suggestion-surface nutrition-food-editor-card">
                <div class="nutrition-food-editor-head">
                  <div>
                    <div class="foods-card-kicker">Brzi unos nutritivnih vrednosti</div>
                    <h3>${escapeHtml(nutritionEditingFood.name)}</h3>
                    <p>Unesi ono što nađeš na deklaraciji ili netu. Sve vrednosti se čuvaju na 100 g i odmah važe svuda u app-u.</p>
                  </div>
                  <div class="pill-row">
                    <span class="pill strong pill--${nutritionEditingFood.nutritionStatus.tone}">${nutritionEditingFood.nutritionStatus.statusLabel}</span>
                    <span class="pill">${roundValue(nutritionEditingFood.servingBaseGrams || 100, 0)} g baza</span>
                  </div>
                </div>
                <form id="nutrition-food-form" class="form-grid split nutrition-food-form">
                  <input type="hidden" name="foodId" value="${nutritionEditingFood.id}" />
                  ${
                    nutritionLinkCandidates.length
                      ? `
                        <div class="field" style="grid-column:1 / -1;">
                          <label for="nutrition-food-link-target">Poveži sa postojećom namirnicom</label>
                          <select id="nutrition-food-link-target" name="linkedFoodId">
                            <option value="">Ne povezuj, uneću ručno vrednosti</option>
                            ${nutritionLinkCandidates
                              .map(
                                (food) => `
                                  <option value="${food.id}">${escapeHtml(food.name)} · ${escapeHtml(food.category || "Bez kategorije")} · ${roundValue(
                                    food.kcal || 0,
                                    0
                                  )} kcal</option>
                                `
                              )
                              .join("")}
                          </select>
                          <div class="footer-note">
                            Ako namirnica već postoji u tvojoj bazi, izaberi je ovde i recepti će odmah povući njene postojeće kcal i makroe.
                          </div>
                        </div>
                      `
                      : ""
                  }
                  <div class="field">
                    <label for="nutrition-food-kcal">Kalorije na 100 g</label>
                    <input
                      id="nutrition-food-kcal"
                      name="kcal"
                      type="number"
                      step="0.1"
                      min="0"
                      value="${toNumber(nutritionEditingFood.kcal) > 0 ? roundValue(nutritionEditingFood.kcal, 1) : ""}"
                      placeholder="${
                        nutritionEditingFood.nutritionStatus.estimatedKcal
                          ? `npr. ${nutritionEditingFood.nutritionStatus.estimatedKcal}`
                          : "npr. 135"
                      }"
                    />
                  </div>
                  <div class="field">
                    <label for="nutrition-food-protein">Proteini na 100 g</label>
                    <input id="nutrition-food-protein" name="protein" type="number" step="0.1" min="0" value="${toNumber(nutritionEditingFood.protein) > 0 ? roundValue(nutritionEditingFood.protein, 1) : ""}" />
                  </div>
                  <div class="field">
                    <label for="nutrition-food-carbs">Ugljeni hidrati na 100 g</label>
                    <input id="nutrition-food-carbs" name="carbs" type="number" step="0.1" min="0" value="${toNumber(nutritionEditingFood.carbs) > 0 ? roundValue(nutritionEditingFood.carbs, 1) : ""}" />
                  </div>
                  <div class="field">
                    <label for="nutrition-food-fat">Masti na 100 g</label>
                    <input id="nutrition-food-fat" name="fat" type="number" step="0.1" min="0" value="${toNumber(nutritionEditingFood.fat) > 0 ? roundValue(nutritionEditingFood.fat, 1) : ""}" />
                  </div>
                  <div class="field" style="grid-column:1 / -1;">
                    <label for="nutrition-food-source">Izvor</label>
                    <input
                      id="nutrition-food-source"
                      name="nutritionSource"
                      placeholder="npr. USDA, deklaracija proizvoda, sajt proizvođača"
                      value="${escapeHtml(nutritionEditingFood.nutritionSource || "")}"
                    />
                  </div>
                  <div class="nutrition-food-form-note">
                    Ako ostaviš kcal prazno, app će ga izračunati iz P/UH/M. Kad sačuvaš, stavka izlazi iz ovog review inbox-a i ostaje dostupna u Namirnice.
                  </div>
                  <div class="entry-actions nutrition-card-actions">
                    <button class="solid-button secondary-button button-with-icon" type="submit">
                      ${renderButtonContent("Sačuvaj vrednosti", "save")}
                    </button>
                    <button class="ghost-button button-with-icon" type="button" data-action="cancel-nutrition-food">
                      ${renderButtonContent("Odustani", "close")}
                    </button>
                  </div>
                </form>
              </article>
            `
            : reviewImportedFoods.length
              ? `
                <article class="status-summary-card nutrition-food-editor-card nutrition-food-editor-card--hint">
                  <div class="status-summary-copy">
                    <strong>Inbox za review namirnica</strong>
                    <div class="footer-note">
                      Klikni na <em>Dodaj vrednosti</em> ako je nova namirnica, ili na <em>Obriši</em> ako je već imaš u bazi i ne želiš duplikat. Kad završiš review, ova lista se prazni.
                    </div>
                  </div>
                </article>
              `
              : ""
        }
        ${
          reviewImportedFoods.length
            ? reviewImportedFoods
                .map(
                  (food) => {
                    const suggestedLink = getImportedFoodSuggestedLink(food);
                    return `
                    <article class="status-summary-card nutrition-food-card ${food.nutritionStatus.needsAttention ? "is-needs-review" : ""}">
                      <div class="status-summary-top">
                        <div class="status-summary-copy">
                          <strong>${escapeHtml(food.name)}</strong>
                          <div class="footer-note">${escapeHtml(food.category || "Nutri import")}</div>
                        </div>
                        <span class="pill strong pill--warning">${roundValue(food.servingBaseGrams || 100, 0)} g baza</span>
                      </div>
                      <div class="pill-row">
                        <span class="pill">${food.nutritionStatus.displayKcal || 0} kcal${food.nutritionStatus.isEstimatedKcal ? "*" : ""}</span>
                        <span class="pill">P ${roundValue(food.protein, 1)} g</span>
                        <span class="pill">UH ${roundValue(food.carbs, 1)} g</span>
                        <span class="pill">M ${roundValue(food.fat, 1)} g</span>
                        <span class="pill strong pill--${food.nutritionStatus.tone}">${food.nutritionStatus.statusLabel}</span>
                      </div>
                      <div class="footer-note nutrition-food-meta">
                        ${escapeHtml(food.nutritionStatus.statusDetail)}
                        ${food.nutritionSource ? ` Izvor: ${escapeHtml(food.nutritionSource)}.` : ""}
                      </div>
                      ${
                        suggestedLink
                          ? `
                            <div class="footer-note nutrition-food-meta">
                              Predlog poklapanja: <strong>${escapeHtml(suggestedLink.name)}</strong> · ${roundValue(
                                suggestedLink.kcal || 0,
                                0
                              )} kcal
                            </div>
                          `
                          : ""
                      }
                      ${renderNutritionSourcePills(food.importSourceDocNames)}
                      <div class="entry-actions nutrition-card-actions">
                        <button class="solid-button secondary-button button-with-icon" data-action="edit-imported-food-nutrition" data-food-id="${food.id}">
                          ${renderButtonContent(food.nutritionStatus.needsAttention ? "Dodaj vrednosti" : "Izmeni vrednosti", "edit")}
                        </button>
                        <button class="ghost-button button-with-icon" data-action="dismiss-imported-food-review" data-food-id="${food.id}">
                          ${renderButtonContent("Obriši", "delete")}
                        </button>
                        <button class="ghost-button button-with-icon" data-action="edit-food" data-food-id="${food.id}">
                          ${renderButtonContent("Otvori namirnicu", "edit")}
                        </button>
                      </div>
                    </article>
                  `;
                  }
                )
                .join("")
            : `<div class="empty">Review inbox je čist. Kad parser izvuče nove nerešene namirnice, pojaviće se ovde dok ih ne dopuniš ili ukloniš kao duplikat.</div>`
        }
      </div>
    </section>

    <section class="section nutrition-documents-section">
      ${renderSectionLead("Arhiva dokumenata", "Kratak pregled svega što si importovao, da znaš iz kog dokumenta je šta došlo.", {
        eyebrow: "Dokumenti",
      })}
      <div class="stack nutrition-documents-stack">
        ${
          documents.length
            ? documents
                .map(
                  (doc) => `
                    <article class="status-summary-card nutrition-doc-card">
                      <div class="status-summary-top">
                        <div class="status-summary-copy">
                          <strong>${escapeHtml(doc.name)}</strong>
                          <div class="footer-note">${escapeHtml(doc.excerpt || "Bez sažetka")}</div>
                        </div>
                        <span class="pill strong pill--info">${escapeHtml(doc.status || "Sačuvano")}</span>
                      </div>
                      <div class="pill-row">
                        <span class="pill">${escapeHtml(doc.parserLabel || "Tekst")}</span>
                        <span class="pill">${getFileSizeLabel(doc.size)}</span>
                        <span class="pill">${doc.planCount || 0} dana</span>
                        <span class="pill">${doc.recipeCount || 0} recepata</span>
                        <span class="pill">${doc.foodCount || 0} namirnica</span>
                        <span class="pill">${doc.recommendationCount || 0} preporuka</span>
                      </div>
                      <div class="footer-note">Uvezeno ${new Date(doc.importedAt).toLocaleString("sr-RS")}</div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Još nema uvezenih dokumenata. Klikni na "Uvezi dokumente" i ubaci planove nutricioniste.</div>`
        }
      </div>
    </section>
  `;
}

function renderSettingsTab() {
  const syncStatusTone = getSyncStatusTone();

  return `
    <section class="section settings-account-section">
      ${renderSectionLead("Nalog i sync", "Ovde su prijava, cloud status i sigurnosne opcije za podatke iz app-a.", { eyebrow: "Podešavanja" })}
      <div class="settings-grid">
        ${renderStatusSummaryCard({
          title: state.authUser?.email || "Nema prijavljenog naloga",
          detail: "Cloud sync radi za plan, obroke, trening, rutinu i ciljeve. Progress slike za sada ostaju lokalno na uređaju.",
          statusLabel: state.syncStatus,
          tone: syncStatusTone,
          pills: [
            { label: "Firebase sync", strong: true, tone: syncStatusTone },
            { label: "Slike: lokalno", tone: "info" },
          ],
          actions: `<button class="ghost-button signout-button button-with-icon" type="button" data-action="sign-out">${renderButtonContent("Odjavi se", "signout")}</button>`,
        })}

        <article class="status-summary-card">
          <div class="status-summary-top">
            <div class="status-summary-copy">
              <strong>Backup i oporavak</strong>
              <div class="footer-note">JSON backup je dodatna sigurnost. Ako ga uvezeš dok si prijavljen, izmene će se upisati i u cloud.</div>
            </div>
            <span class="pill strong pill--info">Lokalni fajl</span>
          </div>
          <div class="meta-row meta-row--compact status-summary-actions">
            <button class="solid-button secondary-button button-with-icon" data-action="export-data">${renderButtonContent("Izvezi backup", "save")}</button>
            <label class="ghost-button button-with-icon" for="import-json">${renderButtonContent("Uvezi backup", "open")}</label>
            <input id="import-json" type="file" accept="application/json" hidden />
          </div>
        </article>
      </div>
    </section>
  `;
}

function findLatestMeasurementValue(entry, fieldId) {
  const rawValue = entry?.[fieldId];
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }
  return typeof rawValue === "number" ? rawValue : rawValue;
}

function getLatestMeasurement() {
  if (!store.measurements.length) {
    return null;
  }
  return [...store.measurements].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
}

function getPreviousMeasurement(fieldId, latestId) {
  return [...store.measurements]
    .filter((entry) => entry.id !== latestId && findLatestMeasurementValue(entry, fieldId) !== null)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
}

function getMeasurementSeries(fieldId) {
  return [...store.measurements]
    .filter((entry) => typeof entry[fieldId] === "number")
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((entry) => ({
      date: entry.date,
      label: new Date(entry.date).toLocaleDateString("sr-RS"),
      value: entry[fieldId],
    }));
}

function renderTrendCard(field) {
  const series = getMeasurementSeries(field.id);

  if (!series.length) {
    return `
      <article class="chart-card">
        <div class="chart-card-top">
          <h3>${field.label}</h3>
          <span class="pill">${field.unit || ""}</span>
        </div>
        <div class="empty">Dodaj makar jedno merenje da se pojavi trend.</div>
      </article>
    `;
  }

  const min = Math.min(...series.map((point) => point.value));
  const max = Math.max(...series.map((point) => point.value));
  const width = 320;
  const height = 160;
  const paddingX = 18;
  const paddingY = 18;
  const range = max - min || 1;
  const stepX = series.length > 1 ? (width - paddingX * 2) / (series.length - 1) : 0;
  const points = series.map((point, index) => {
    const x = paddingX + index * stepX;
    const y = height - paddingY - ((point.value - min) / range) * (height - paddingY * 2);
    return { ...point, x: roundValue(x, 1), y: roundValue(y, 1) };
  });
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
  const latest = series[series.length - 1];
  const first = series[0];
  const delta = roundValue(latest.value - first.value, 1);

  return `
    <article class="chart-card">
      <div class="chart-card-top">
        <h3>${field.label}</h3>
        <span class="pill strong">${formatFieldValue(field, latest.value)}</span>
      </div>
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend za ${field.label}">
        <line x1="${paddingX}" y1="${height - paddingY}" x2="${width - paddingX}" y2="${height - paddingY}" class="chart-axis"></line>
        <line x1="${paddingX}" y1="${paddingY}" x2="${paddingX}" y2="${height - paddingY}" class="chart-axis"></line>
        <polyline points="${polyline}" class="chart-line"></polyline>
        ${points
          .map(
            (point) => `
              <circle cx="${point.x}" cy="${point.y}" r="4.5" class="chart-dot"></circle>
            `
          )
          .join("")}
      </svg>
      <div class="meta-row">
        <span class="pill">${first.label}</span>
        <span class="pill">${latest.label}</span>
        <span class="pill note">${delta > 0 ? "+" : ""}${delta}${field.unit ? ` ${field.unit}` : ""}</span>
      </div>
    </article>
  `;
}

function renderExerciseProgressCard(group) {
  const series = group.logs.map((log) => ({
    date: log.date,
    label: new Date(log.date).toLocaleDateString("sr-RS"),
    value: log.weightKg,
  }));
  const min = Math.min(...series.map((point) => point.value));
  const max = Math.max(...series.map((point) => point.value));
  const width = 320;
  const height = 160;
  const paddingX = 18;
  const paddingY = 18;
  const range = max - min || 1;
  const stepX = series.length > 1 ? (width - paddingX * 2) / (series.length - 1) : 0;
  const points = series.map((point, index) => {
    const x = paddingX + index * stepX;
    const y = height - paddingY - ((point.value - min) / range) * (height - paddingY * 2);
    return { ...point, x: roundValue(x, 1), y: roundValue(y, 1) };
  });
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
  const recentLogs = [...group.logs].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 3);

  return `
    <article class="chart-card">
      <div class="chart-card-top">
        <h3>${group.exerciseName}</h3>
        <span class="pill strong">${roundValue(group.latest.weightKg, 1)} kg</span>
      </div>
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend za ${group.exerciseName}">
        <line x1="${paddingX}" y1="${height - paddingY}" x2="${width - paddingX}" y2="${height - paddingY}" class="chart-axis"></line>
        <line x1="${paddingX}" y1="${paddingY}" x2="${paddingX}" y2="${height - paddingY}" class="chart-axis"></line>
        <polyline points="${polyline}" class="chart-line"></polyline>
        ${points
          .map(
            (point) => `
              <circle cx="${point.x}" cy="${point.y}" r="4.5" class="chart-dot"></circle>
            `
          )
          .join("")}
      </svg>
      <div class="pill-row">
        <span class="pill">Najbolje ${roundValue(group.best.weightKg, 1)} kg</span>
        <span class="pill">Unosa ${group.logs.length}</span>
        <span class="pill note">${group.delta > 0 ? "+" : ""}${group.delta} kg od prvog</span>
      </div>
      <div class="pill-row">
        ${recentLogs
          .map(
            (log) => `
              <span class="pill">
                ${new Date(log.date).toLocaleDateString("sr-RS")} · ${roundValue(log.weightKg, 1)} kg${log.reps ? ` · ${log.reps}` : ""}
              </span>
            `
          )
          .join("")}
      </div>
      <div class="footer-note">
        Poslednje: ${new Date(group.latest.date).toLocaleDateString("sr-RS")}${group.latest.weekday ? ` · ${group.latest.weekday}` : ""}${group.latest.note ? ` · ${group.latest.note}` : ""}
      </div>
    </article>
  `;
}

function getPhotoDateDefault() {
  return new Date().toISOString().slice(0, 10);
}

function getAvailablePhotoTags(photos) {
  return PHOTO_TAGS.filter((tag) => photos.some((photo) => photo.tag === tag));
}

function getActiveCompareTag(photos) {
  const availableTags = getAvailablePhotoTags(photos);
  if (!availableTags.length) {
    return PHOTO_TAGS[0];
  }
  return availableTags.includes(state.progressCompareTag) ? state.progressCompareTag : availableTags[0];
}

function getPhotoComparePair(photos) {
  const fallbackLeftId = photos[0]?.id || "";
  const nextAvailable = (excludedId) => photos.find((photo) => photo.id !== excludedId)?.id || "";
  const leftId = photos.some((photo) => photo.id === state.progressCompareLeftId)
    ? state.progressCompareLeftId
    : fallbackLeftId;
  const rightId =
    photos.some((photo) => photo.id === state.progressCompareRightId && photo.id !== leftId)
      ? state.progressCompareRightId
      : nextAvailable(leftId);

  return {
    leftId,
    rightId,
    leftPhoto: photos.find((photo) => photo.id === leftId) || null,
    rightPhoto: photos.find((photo) => photo.id === rightId) || null,
  };
}

function getPhotoLabel(photo) {
  const parts = [new Date(photo.date).toLocaleDateString("sr-RS")];
  if (photo.tag) {
    parts.push(photo.tag);
  }
  if (photo.note) {
    parts.push(photo.note);
  }
  return parts.join(" - ");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("File reading failed"));
    reader.readAsDataURL(file);
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image load failed"));
    image.src = dataUrl;
  });
}

async function createOptimizedPhoto(file) {
  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageFromDataUrl(sourceDataUrl);
  const maxWidth = 1280;
  const ratio = Math.min(1, maxWidth / image.width);
  const width = Math.round(image.width * ratio);
  const height = Math.round(image.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);

  return {
    previewUrl: canvas.toDataURL("image/jpeg", 0.82),
    width,
    height,
  };
}

function renderMeasurementCard(field) {
  const latest = getLatestMeasurement();
  const latestValue = findLatestMeasurementValue(latest, field.id);
  const previous = latest ? getPreviousMeasurement(field.id, latest.id) : null;
  const previousValue = findLatestMeasurementValue(previous, field.id);
  const delta =
    typeof latestValue === "number" && typeof previousValue === "number"
      ? roundValue(latestValue - previousValue, 1)
      : null;

  return `
    <article class="stat-card">
      <strong>${field.label}</strong>
      <div class="macro-value">
        ${latestValue !== null ? `${latestValue}${field.unit ? ` ${field.unit}` : ""}` : "-"}
      </div>
      <div class="footer-note">
        ${
          latest
            ? `Poslednje: ${new Date(latest.date).toLocaleDateString("sr-RS")}`
            : "Još nema unosa"
        }
        ${
          delta !== null
            ? ` | Promena: ${delta > 0 ? "+" : ""}${delta}${field.unit ? ` ${field.unit}` : ""}`
            : ""
        }
      </div>
    </article>
  `;
}

function renderProgressTab() {
  const history = [...store.measurements].sort((a, b) => new Date(b.date) - new Date(a.date));
  const chartFields = measurementFields.filter((field) =>
    ["weightKg", "upperWaistCm", "lowerWaistCm"].includes(field.id)
  );
  const photos = [...store.progressPhotos].sort((a, b) => new Date(b.date) - new Date(a.date));
  const activeCompareTag = getActiveCompareTag(photos);
  const taggedPhotos = photos.filter((photo) => photo.tag === activeCompareTag);
  const compare = getPhotoComparePair(taggedPhotos);

  return `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Težina i mere</h2>
          <p>Brz unos merenja, da sa telefona pratiš kako napreduješ kroz vreme.</p>
        </div>
      </div>
      <div class="stats-grid">
        ${measurementFields
          .filter((field) => field.id !== "trainingType")
          .map((field) => renderMeasurementCard(field))
          .join("")}
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Trend</h2>
          <p>Kratak vizuelni pregled kako idu težina i stomak kroz vreme.</p>
        </div>
      </div>
      <div class="chart-grid">
        ${chartFields.map((field) => renderTrendCard(field)).join("")}
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Dodaj merenje</h2>
          <p>Ne moraš popuniti sve, upiši samo ono što si izmerio tog dana.</p>
        </div>
      </div>
      <form id="measurement-form" class="form-grid split">
        <div class="field">
          <label for="measurement-date">Datum</label>
          <input id="measurement-date" name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required />
        </div>
        ${measurementFields
          .map(
            (field) => `
              <div class="field">
                <label for="measurement-${field.id}">${field.label}${field.unit ? ` (${field.unit})` : ""}</label>
                <input
                  id="measurement-${field.id}"
                  name="${field.id}"
                  type="${field.type}"
                  ${field.step ? `step="${field.step}"` : ""}
                  ${field.type === "number" ? 'min="0"' : ""}
                  placeholder="${field.placeholder || ""}"
                />
              </div>
            `
          )
          .join("")}
        <button class="solid-button" type="submit">Sačuvaj unos</button>
      </form>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Progress slike</h2>
          <p>Ubaci sliku sa telefona i ostavi kratku napomenu tipa front, side ili back.</p>
        </div>
      </div>
      <form id="photo-form" class="form-grid split">
        <div class="field">
          <label for="photo-date">Datum</label>
          <input id="photo-date" name="date" type="date" value="${getPhotoDateDefault()}" required />
        </div>
        <div class="field">
          <label for="photo-tag">Tag</label>
          <select id="photo-tag" name="tag" required>
            ${PHOTO_TAGS.map((tag) => `<option value="${tag}">${tag}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="photo-note">Napomena</label>
          <input id="photo-note" name="note" placeholder="npr. jutro, posle treninga" />
        </div>
        <div class="field photo-picker">
          <label for="photo-file">Slika</label>
          <input id="photo-file" name="photo" type="file" accept="image/*" required />
          <div class="footer-note">Slika se automatski smanjuje i čuva lokalno.</div>
        </div>
        <button class="solid-button secondary-button" type="submit">Dodaj sliku</button>
      </form>
      <div class="compare-block" style="margin-top:14px;">
        <div class="section-header">
          <div>
            <h2>Side by side</h2>
            <p>Izaberi tag pa poredi samo isti ugao slikanja, recimo front sa front.</p>
          </div>
        </div>
        ${
          photos.length >= 2
            ? `
              <div class="form-grid split">
                <div class="field">
                  <label for="compare-tag">Tag za poredjenje</label>
                  <select id="compare-tag">
                    ${PHOTO_TAGS.map(
                      (tag) => `
                        <option value="${tag}" ${tag === activeCompareTag ? "selected" : ""} ${!photos.some((photo) => photo.tag === tag) ? "disabled" : ""}>
                          ${tag}
                        </option>
                      `
                    ).join("")}
                  </select>
                </div>
                <div class="field">
                  <label for="compare-left">Leva slika</label>
                  <select id="compare-left">
                    ${taggedPhotos
                      .map(
                        (photo) => `
                          <option value="${photo.id}" ${photo.id === compare.leftId ? "selected" : ""}>
                            ${getPhotoLabel(photo)}
                          </option>
                        `
                      )
                      .join("")}
                  </select>
                </div>
                <div class="field">
                  <label for="compare-right">Desna slika</label>
                  <select id="compare-right">
                    ${taggedPhotos
                      .map(
                        (photo) => `
                          <option value="${photo.id}" ${photo.id === compare.rightId ? "selected" : ""}>
                            ${getPhotoLabel(photo)}
                          </option>
                        `
                      )
                      .join("")}
                  </select>
                </div>
              </div>
              ${
                taggedPhotos.length >= 2 && compare.leftPhoto && compare.rightPhoto && compare.leftPhoto.id !== compare.rightPhoto.id
                  ? `
                    <div class="compare-grid">
                      <article class="photo-card compare-card">
                        <img src="${compare.leftPhoto.previewUrl}" alt="Leva progress slika ${compare.leftPhoto.date}" loading="lazy" />
                        <div class="photo-card-body">
                          <strong>${new Date(compare.leftPhoto.date).toLocaleDateString("sr-RS")}</strong>
                          <div class="pill-row">
                            <span class="pill strong">${compare.leftPhoto.tag || "bez taga"}</span>
                          </div>
                          <div class="footer-note">${compare.leftPhoto.note || "Bez napomene"}</div>
                        </div>
                      </article>
                      <article class="photo-card compare-card">
                        <img src="${compare.rightPhoto.previewUrl}" alt="Desna progress slika ${compare.rightPhoto.date}" loading="lazy" />
                        <div class="photo-card-body">
                          <strong>${new Date(compare.rightPhoto.date).toLocaleDateString("sr-RS")}</strong>
                          <div class="pill-row">
                            <span class="pill strong">${compare.rightPhoto.tag || "bez taga"}</span>
                          </div>
                          <div class="footer-note">${compare.rightPhoto.note || "Bez napomene"}</div>
                        </div>
                      </article>
                    </div>
                  `
                  : `<div class="empty">Za tag "${activeCompareTag}" dodaj bar dve slike ili izaberi druge dve razlicite slike.</div>`
              }
            `
            : `<div class="empty">Dodaj bar dve slike da bi radio side by side prikaz.</div>`
        }
      </div>
      <div class="photo-grid" style="margin-top:14px;">
        ${
          photos.length
            ? photos
                .map(
                  (photo) => `
                    <article class="photo-card">
                      <img src="${photo.previewUrl}" alt="Progress slika ${photo.date}" loading="lazy" />
                      <div class="photo-card-body">
                        <div class="food-card-top">
                          <strong>${new Date(photo.date).toLocaleDateString("sr-RS")}</strong>
                          <button class="danger-button" data-action="delete-photo" data-photo-id="${photo.id}">Obriši</button>
                        </div>
                        <div class="pill-row">
                          <span class="pill strong">${photo.tag || "bez taga"}</span>
                        </div>
                        <div class="footer-note">${photo.note || "Bez napomene"}</div>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Još nema progress slika. Ubaci prvu da imaš vizuelni trag napretka.</div>`
        }
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Istorija unosa</h2>
          <p>${history.length ? "Najnoviji unos je prvi." : "Još nema sačuvanih merenja."}</p>
        </div>
      </div>
      <div class="stack">
        ${
          history.length
            ? history
                .map(
                  (entry) => `
                    <article class="food-card">
                      <div class="food-card-top">
                        <h3>${new Date(entry.date).toLocaleDateString("sr-RS")}</h3>
                        <button class="danger-button" data-action="delete-measurement" data-measurement-id="${entry.id}">
                          Obriši
                        </button>
                      </div>
                      <div class="pill-row">
                        ${
                          measurementFields
                            .map((field) => {
                              const value = findLatestMeasurementValue(entry, field.id);
                              if (value === null) {
                                return "";
                              }
                              return `<span class="pill ${field.id === "weightKg" ? "note" : ""}">${field.label}: ${value}${field.unit ? ` ${field.unit}` : ""}</span>`;
                            })
                            .join("")
                        }
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Dodaj prvo merenje pa će ovde ostati istorija.</div>`
        }
      </div>
    </section>
  `;
}

function render() {
  if (!state.authReady) {
    document.body.classList.remove("plan-compact");
    state.navMenuOpen = false;
    syncBodyScrollLock();
    document.querySelector("#app").innerHTML = renderLoadingShell();
    return;
  }

  if (!state.authUser) {
    document.body.classList.remove("plan-compact");
    state.navMenuOpen = false;
    syncBodyScrollLock();
    document.querySelector("#app").innerHTML = renderAuthShell();
    return;
  }

  const entries = getPlanEntriesForDay(state.selectedWeekday);
  const totals = getDayTotals(entries);
  const heroMarkup = state.activeTab === "plan" ? renderHero(entries, totals) : "";
  const sections = {
    plan: renderPlanTab(entries),
    recipes: renderRecipesTab(),
    nutrition: renderNutritionTab(),
    foods: renderFoodsTab(),
    training: renderTrainingTab(),
    routine: renderRoutineTab(),
    progress: renderProgressTab(),
    goals: renderGoalsTab(),
    settings: renderSettingsTab(),
  };

  document.querySelector("#app").innerHTML = `
    <div class="app-frame">
      <button class="menu-fab" type="button" data-action="toggle-nav-menu" aria-expanded="${state.navMenuOpen}" aria-controls="app-menu" aria-label="Otvori meni">
        <span class="menu-fab-icon" aria-hidden="true">${renderMenuToggleIcon(state.navMenuOpen)}</span>
        <span class="menu-fab-label">Meni</span>
      </button>

      ${state.navMenuOpen ? '<button class="menu-overlay" type="button" data-action="close-nav-menu" aria-label="Zatvori meni"></button>' : ""}

      <aside id="app-menu" class="mobile-menu app-sidebar ${state.navMenuOpen ? "is-open" : ""}" aria-label="Glavna navigacija">
        <div class="mobile-menu-top">
          <div class="app-sidebar-brand">
            <div class="hero-picker-label">Navigacija</div>
            <strong>Fit tracker</strong>
            <div class="footer-note app-sidebar-email">${state.authUser?.email || ""}</div>
          </div>
          <button class="ghost-button menu-close" type="button" data-action="close-nav-menu" aria-label="Zatvori meni">
            ${renderMenuToggleIcon(true)}
          </button>
        </div>
        <div class="mobile-menu-list">
          ${TABS.map(
            (tab) => `
              <button class="menu-tab-button ${tab.id === state.activeTab ? "is-active" : ""}" data-action="switch-tab" data-tab="${tab.id}">
                <span class="icon">${tab.icon}</span>
                <span>${tab.label}</span>
              </button>
            `
          ).join("")}
        </div>
        <div class="mobile-menu-footer">
          <div class="pill-row app-sidebar-status-row">
            <span class="pill strong pill--${getSyncStatusTone()}">${state.syncStatus}</span>
          </div>
          <button class="ghost-button signout-button button-with-icon" type="button" data-action="sign-out">${renderButtonContent("Odjavi se", "signout")}</button>
        </div>
      </aside>

      <main class="shell shell-with-menu app-main ${state.activeTab === "plan" ? "is-plan-shell" : ""}">
        ${heroMarkup}
        ${sections[state.activeTab]}
      </main>

      ${
        state.deletedPlanEntry
          ? `
            <div class="undo-banner" role="status" aria-live="polite">
              <div>
                <strong>Stavka obrisana.</strong>
                <div class="footer-note" style="margin-top:4px;">Mozes odmah da je vratis.</div>
              </div>
              <button class="solid-button secondary-button button-with-icon" data-action="undo-delete-entry">${renderButtonContent("Vrati", "undo")}</button>
            </div>
          `
          : ""
      }

      ${
        state.updateReady
          ? `
            <div class="update-banner" role="status" aria-live="polite">
              <div>
                <strong>Nova verzija je spremna.</strong>
                <div class="footer-note" style="margin-top:4px;">Osvezi app da povuces poslednje izmene.</div>
              </div>
              <button class="solid-button secondary-button button-with-icon" data-action="apply-app-update">${renderButtonContent("Osvezi", "refresh")}</button>
            </div>
          `
          : ""
      }
    </div>
  `;

  syncBodyScrollLock();
  updateHeroScrollState();
  syncEntryPreview();
}

function exportData() {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fit-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function syncEntryPreview() {
  const foodSelect = document.querySelector("#foodId");
  const gramsInput = document.querySelector("#grams");
  const preview = document.querySelector("#entry-preview");

  if (!foodSelect || !gramsInput || !preview) {
    return;
  }

  const food = getFoodById(foodSelect.value);
  const grams = toNumber(gramsInput.value);

  if (!food || !grams) {
    preview.innerHTML = `
      <h3>Preview</h3>
      <p>Izaberi namirnicu i gramažu da odmah vidiš makroe.</p>
    `;
    return;
  }

  const totals = calculateEntry(food, grams);
  preview.innerHTML = `
    <h3>${food.name} za ${roundValue(grams, 0)} g</h3>
    <p>${roundValue(totals.kcal, 0)} kcal, P ${totals.protein} g, UH ${totals.carbs} g, M ${totals.fat} g</p>
  `;
}

async function handleDocumentClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  const action = actionTarget.dataset.action;

  if (action === "switch-tab") {
    state.activeTab = actionTarget.dataset.tab;
    state.editingMealLabel = "";
    state.navMenuOpen = false;
    resetFoodEditing();
    resetRoutineEditing();
    window.location.hash = state.activeTab;
    render();
    window.requestAnimationFrame(() => scrollPageTop("auto"));
    return;
  }

  if (action === "clear-nutrition-imports") {
    const hasImportArchiveContent = Boolean(
      store.nutritionLibrary?.documents?.length ||
        store.nutritionLibrary?.plans?.length ||
        store.nutritionLibrary?.recommendations?.length ||
        (store.nutritionLibrary?.importedFoodIds || []).length ||
        (store.nutritionLibrary?.importedRecipeIds || []).length ||
        (store.foods || []).some((food) => food.importSource === "nutrition-import") ||
        (store.favoriteMeals || []).some((recipe) => recipe.importSource === "nutrition-import")
    );

    if (!hasImportArchiveContent) {
      return;
    }

    const confirmed = window.confirm(
      "Resetuj ceo nutricionista import? Obrisaću importovane dokumente, preporuke, recepte i namirnice da možeš ponovo da uvezeš fajlove od nule."
    );
    if (!confirmed) {
      return;
    }

    resetNutritionImportWorkspace(store);
    state.nutritionEditingFoodId = "";
    persist();
    render();
    return;
  }

  if (action === "toggle-nav-menu") {
    state.navMenuOpen = !state.navMenuOpen;
    render();
    return;
  }

  if (action === "close-nav-menu") {
    state.navMenuOpen = false;
    render();
    return;
  }

  if (action === "apply-app-update") {
    if (serviceWorkerRegistration?.waiting) {
      serviceWorkerRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
      return;
    }
    window.location.reload();
    return;
  }

  if (action === "select-weekday") {
    state.selectedWeekday = actionTarget.dataset.weekday;
    state.editingMealLabel = "";
    state.navMenuOpen = false;
    resetPlanDraft();
    resetRoutineEditing();
    render();
    window.requestAnimationFrame(() => scrollPageTop("smooth"));
    return;
  }

  if (action === "set-food-filter") {
    state.foodMacroFilter = actionTarget.dataset.filter || "Sve";
    render();
    return;
  }

  if (action === "toggle-favorite-food") {
    const foodId = actionTarget.dataset.foodId;
    if (!foodId) {
      return;
    }

    if (store.favoriteFoods.includes(foodId)) {
      store.favoriteFoods = store.favoriteFoods.filter((entry) => entry !== foodId);
    } else {
      store.favoriteFoods.unshift(foodId);
    }

    persist();
    render();
    return;
  }

  if (action === "toggle-habit-day") {
    const habitId = actionTarget.dataset.habitId;
    const habit = store.habits.find((entry) => entry.id === habitId);
    if (!habit || habit.trackingMode === "streak") {
      return;
    }

    habit.completions = habit.completions || {};
    habit.completions[state.selectedWeekday] = !Boolean(habit.completions[state.selectedWeekday]);
    persist();
    render();
    return;
  }

  if (action === "reset-habit-streak") {
    const habit = store.habits.find((entry) => entry.id === actionTarget.dataset.habitId);
    if (!habit || habit.trackingMode !== "streak") {
      return;
    }

    const currentStreakDays = getHabitCurrentStreakDays(habit);
    const confirmed = window.confirm(
      `Resetuj streak za "${habit.name}"? Trenutno broji ${getDayCountLabel(currentStreakDays)}.`
    );
    if (!confirmed) {
      return;
    }

    habit.bestStreakDays = Math.max(Math.max(0, toNumber(habit.bestStreakDays)), currentStreakDays);
    habit.resetCount = Math.max(0, toNumber(habit.resetCount)) + 1;
    habit.lastResetAt = getTodayDateValue();
    habit.streakStartDate = getTodayDateValue();
    habit.updatedAt = new Date().toISOString();
    persist();
    render();
    return;
  }

  if (action === "edit-habit") {
    const habitId = actionTarget.dataset.habitId;
    if (!habitId || !store.habits.find((entry) => entry.id === habitId)) {
      return;
    }
    state.editingHabitId = habitId;
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#habit-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#habit-name")?.focus();
    });
    return;
  }

  if (action === "cancel-edit-habit") {
    state.editingHabitId = "";
    render();
    return;
  }

  if (action === "delete-habit") {
    const habit = store.habits.find((entry) => entry.id === actionTarget.dataset.habitId);
    const confirmed = window.confirm(habit ? `Obriši naviku "${habit.name}"?` : "Obriši ovu naviku?");
    if (!confirmed) {
      return;
    }

    store.habits = store.habits.filter((entry) => entry.id !== actionTarget.dataset.habitId);
    persist();
    render();
    return;
  }

  if (action === "toggle-task-done") {
    const taskId = actionTarget.dataset.taskId;
    store.dayTasks = store.dayTasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            done: !task.done,
          }
        : task
    );
    persist();
    render();
    return;
  }

  if (action === "toggle-supplement-day") {
    const supplement = store.supplements.find((entry) => entry.id === actionTarget.dataset.supplementId);
    if (!supplement) {
      return;
    }
    supplement.completions = supplement.completions || {};
    supplement.completions[state.selectedWeekday] = !Boolean(supplement.completions[state.selectedWeekday]);
    persist();
    render();
    return;
  }

  if (action === "edit-task") {
    const taskId = actionTarget.dataset.taskId;
    if (!taskId || !store.dayTasks.find((entry) => entry.id === taskId)) {
      return;
    }
    state.editingTaskId = taskId;
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#task-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#task-title")?.focus();
    });
    return;
  }

  if (action === "cancel-edit-task") {
    state.editingTaskId = "";
    render();
    return;
  }

  if (action === "delete-task") {
    const task = store.dayTasks.find((entry) => entry.id === actionTarget.dataset.taskId);
    const confirmed = window.confirm(task ? `Obriši task "${task.title}"?` : "Obriši ovaj task?");
    if (!confirmed) {
      return;
    }

    store.dayTasks = store.dayTasks.filter((entry) => entry.id !== actionTarget.dataset.taskId);
    persist();
    render();
    return;
  }

  if (action === "edit-supplement") {
    const supplementId = actionTarget.dataset.supplementId;
    if (!supplementId || !store.supplements.find((entry) => entry.id === supplementId)) {
      return;
    }
    state.editingSupplementId = supplementId;
    state.activeTab = "goals";
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#supplement-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#supplement-name")?.focus();
    });
    return;
  }

  if (action === "cancel-edit-supplement") {
    state.editingSupplementId = "";
    render();
    return;
  }

  if (action === "delete-supplement") {
    const supplement = store.supplements.find((entry) => entry.id === actionTarget.dataset.supplementId);
    const confirmed = window.confirm(
      supplement ? `Obriši suplement "${supplement.name}"?` : "Obriši ovaj suplement?"
    );
    if (!confirmed) {
      return;
    }

    store.supplements = store.supplements.filter((entry) => entry.id !== actionTarget.dataset.supplementId);
    persist();
    render();
    return;
  }

  if (action === "clear-completed-tasks") {
    const hasCompleted = store.dayTasks.some((task) => task.weekday === state.selectedWeekday && task.done);
    if (!hasCompleted) {
      return;
    }
    const confirmed = window.confirm(`Obriši sve završene taskove za ${state.selectedWeekday}?`);
    if (!confirmed) {
      return;
    }
    store.dayTasks = store.dayTasks.filter((task) => !(task.weekday === state.selectedWeekday && task.done));
    persist();
    render();
    return;
  }

  if (action === "copy-previous-day-tasks") {
    const selectedDayIndex = WEEKDAYS.indexOf(state.selectedWeekday);
    const previousWeekday = selectedDayIndex > 0 ? WEEKDAYS[selectedDayIndex - 1] : "";
    if (!previousWeekday) {
      return;
    }
    const previousTasks = getTasksForDay(previousWeekday);
    if (!previousTasks.length) {
      return;
    }
    previousTasks.forEach((task) => {
      store.dayTasks.push({
        id: uid("task"),
        weekday: state.selectedWeekday,
        title: task.title,
        note: task.note,
        done: false,
        createdAt: new Date().toISOString(),
      });
    });
    persist();
    render();
    return;
  }

  if (action === "edit-imported-food-nutrition") {
    const foodId = actionTarget.dataset.foodId;
    if (!foodId || !getFoodById(foodId)) {
      return;
    }
    state.activeTab = "nutrition";
    state.nutritionEditingFoodId = foodId;
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#nutrition-food-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#nutrition-food-kcal")?.focus();
    });
    return;
  }

  if (action === "select-nutrition-plan-day") {
    const planId = actionTarget.dataset.planId;
    if (!planId || !getNutritionPlanById(planId)) {
      return;
    }
    state.nutritionSelectedPlanId = planId;
    render();
    return;
  }

  if (action === "apply-nutrition-plan-day") {
    const planId = actionTarget.dataset.planId;
    const mode = String(actionTarget.dataset.mode || "replace").trim() === "append" ? "append" : "replace";
    const plan = planId ? getNutritionPlanById(planId) : null;
    if (!plan) {
      return;
    }

    if (mode === "replace") {
      const confirmed = window.confirm(`Da li želiš da zameniš ceo ${state.selectedWeekday} dnevnim planom "${plan.title}"?`);
      if (!confirmed) {
        return;
      }
    }

    const result = applyNutritionPlanDayToSelectedWeekday(planId, mode);
    persist();
    render();
    showFeedbackToast({
      title: "Nutricionista dan je prebačen",
      detail:
        result.skippedMeals > 0
          ? `${result.appliedCount} stavki je ubačeno u ${state.selectedWeekday}, a ${result.skippedMeals} obroka je ostalo samo kao hint jer nema dovoljno podataka za automatsko prebacivanje.`
          : `${result.appliedCount} stavki je ubačeno u ${state.selectedWeekday}.`,
      tone: result.appliedCount ? "success" : "warning",
    });
    return;
  }

  if (action === "cancel-nutrition-food") {
    state.nutritionEditingFoodId = "";
    render();
    return;
  }

  if (action === "dismiss-imported-food-review") {
    const foodId = actionTarget.dataset.foodId;
    const food = foodId ? getFoodById(foodId) : null;
    if (!food) {
      return;
    }

    const result = dismissImportedFoodReview(store, foodId);
    if (result.status === "blocked") {
      showFeedbackToast({
        title: "Prvo poveži ili dopuni namirnicu",
        detail: `${food.name} se već koristi u receptu ili planu. Poveži je sa postojećom stavkom ili joj dodaj vrednosti, pa će izaći iz review liste.`,
        tone: "warning",
      });
      return;
    }

    if (result.status === "missing") {
      showFeedbackToast({
        title: "Namirnica nije pronađena",
        detail: "Stavka koju si hteo da ukloniš više nije u review listi.",
        tone: "warning",
      });
      return;
    }

    state.nutritionEditingFoodId = state.nutritionEditingFoodId === foodId ? "" : state.nutritionEditingFoodId;
    persist();
    render();
    showFeedbackToast({
      title: result.status === "linked" ? "Duplikat je uklonjen" : "Stavka je obrisana",
      detail:
        result.status === "linked"
          ? `${food.name} je povezana sa postojećom stavkom "${result.linkedFood.name}" i skinuta iz review liste.`
          : `${food.name} je uklonjena iz review liste i više ne pravi duplikat u bazi.`,
      tone: "success",
    });
    return;
  }

  if (action === "edit-food") {
    const foodId = actionTarget.dataset.foodId;
    if (!foodId || !getFoodById(foodId)) {
      return;
    }
    state.activeTab = "foods";
    state.nutritionEditingFoodId = "";
    state.editingFoodId = foodId;
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#food-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#food-name")?.focus();
    });
    return;
  }

  if (action === "cancel-edit-food") {
    resetFoodEditing();
    render();
    return;
  }

  if (action === "use-favorite-food") {
    const foodId = actionTarget.dataset.foodId;
    const food = getFoodById(foodId);
    if (!food) {
      return;
    }
    state.planDraft.foodId = food.id;
    state.planDraft.grams = String(roundValue(food.servingBaseGrams || 100, 0));
    if (!state.planDraft.mealLabel) {
      state.planDraft.mealLabel = defaultMeals[0];
    }
    render();
    return;
  }

  if (action === "hide-day-suggestion") {
    store.ui.plan.hideDaySuggestion = true;
    persist();
    render();
    return;
  }

  if (action === "show-day-suggestion") {
    store.ui.plan.hideDaySuggestion = false;
    persist();
    render();
    return;
  }

  if (action === "start-add-to-meal") {
    const mealLabel = String(actionTarget.dataset.mealLabel || "").trim();
    if (isMealCompletedForWeekday(state.selectedWeekday, mealLabel)) {
      return;
    }
    resetPlanDraft();
    state.editingMealLabel = mealLabel || "";
    state.planDraft.mealLabel = mealLabel || defaultMeals[0];
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#plan-entry-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#foodId")?.focus();
    });
    return;
  }

  if (action === "edit-meal") {
    const mealLabel = String(actionTarget.dataset.mealLabel || "").trim();
    if (isMealCompletedForWeekday(state.selectedWeekday, mealLabel)) {
      return;
    }
    resetPlanDraft();
    state.editingMealLabel = mealLabel || "";
    state.planDraft.mealLabel = mealLabel || defaultMeals[0];
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#plan-entry-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#foodId")?.focus();
    });
    return;
  }

  if (action === "finish-edit-meal") {
    state.editingMealLabel = "";
    resetPlanDraft();
    render();
    return;
  }

  if (action === "edit-entry") {
    const entryId = actionTarget.dataset.entryId;
    const entry = getPlanEntriesForDay(state.selectedWeekday).find((item) => item.id === entryId);
    if (!entry || isMealCompletedForWeekday(state.selectedWeekday, entry.mealLabel)) {
      return;
    }
    setPlanDraftFromEntry(entry);
    render();
    return;
  }

  if (action === "toggle-plan-meal-done") {
    const mealLabel = normalizeMealLabel(String(actionTarget.dataset.mealLabel || "").trim());
    const mealEntries = getMealEntriesForWeekday(state.selectedWeekday, mealLabel);
    if (!mealEntries.length) {
      return;
    }
    const nextDone = !mealEntries.every((entry) => entry.done);
    mealEntries.forEach((entry) => {
      entry.done = nextDone;
    });
    if (nextDone && normalizeMealLabel(state.editingMealLabel) === mealLabel) {
      state.editingMealLabel = "";
      resetPlanDraft();
    }
    persist();
    render();
    return;
  }

  if (action === "toggle-plan-meal-collapse") {
    const mealLabel = String(actionTarget.dataset.mealLabel || "").trim();
    if (!mealLabel) {
      return;
    }
    if (state.editingMealLabel === mealLabel && !isMealCollapsedForWeekday(state.selectedWeekday, mealLabel)) {
      state.editingMealLabel = "";
      resetPlanDraft();
    }
    toggleMealCollapsedState(state.selectedWeekday, mealLabel);
    persist();
    render();
    return;
  }

  if (action === "cancel-edit-entry") {
    resetPlanDraft();
    render();
    return;
  }

  if (action === "add-companion-suggestion") {
    const foodId = actionTarget.dataset.foodId;
    const grams = toNumber(actionTarget.dataset.grams);
    const food = getFoodById(foodId);
    if (!food || !grams) {
      return;
    }
    store.weeklyPlanEntries.push({
      id: uid("plan"),
      weekday: state.selectedWeekday,
      mealLabel: normalizeMealLabel(state.planDraft.mealLabel || defaultMeals[0]),
      foodId: food.id,
      foodName: food.name,
      grams,
      done: false,
    });
    persist();
    render();
    return;
  }

  if (action === "apply-day-suggestion") {
    const mode = actionTarget.dataset.mode || "append";
    const suggestion = generateDaySuggestion();
    if (!suggestion.meals.length) {
      return;
    }
    if (mode === "replace") {
      const confirmed = window.confirm(`Da li zelis da zamenis ceo ${state.selectedWeekday} ovim predlogom?`);
      if (!confirmed) {
        return;
      }
      store.weeklyPlanEntries = store.weeklyPlanEntries.filter((entry) => entry.weekday !== state.selectedWeekday);
    }
    suggestion.meals.forEach((meal) => {
      meal.items.forEach((item) => {
        store.weeklyPlanEntries.push({
          id: uid("plan"),
          weekday: state.selectedWeekday,
          mealLabel: normalizeMealLabel(meal.mealLabel),
          foodId: item.food.id,
          foodName: item.food.name,
          grams: item.grams,
          done: false,
        });
      });
    });
    persist();
    render();
    return;
  }

  if (action === "save-meal-as-favorite") {
    const mealLabel = actionTarget.dataset.mealLabel;
    if (isMealCompletedForWeekday(state.selectedWeekday, mealLabel)) {
      return;
    }
    const mealEntries = getPlanEntriesForDay(state.selectedWeekday)
      .filter((entry) => normalizeMealLabel(entry.mealLabel) === normalizeMealLabel(mealLabel))
      .map((entry) => ({
        id: uid("favorite-item"),
        foodId: entry.foodId,
        foodName: entry.foodName,
        grams: entry.grams,
      }));

    if (!mealEntries.length) {
      return;
    }

    const suggestedName = mealLabel;
    const favoriteName = window.prompt("Naziv recepta:", suggestedName);
    if (!favoriteName || !favoriteName.trim()) {
      return;
    }

    const normalizedName = favoriteName.trim();
    const existingFavorite = getFavoriteMealByName(normalizedName);

    if (existingFavorite) {
      existingFavorite.name = normalizedName;
      existingFavorite.mealLabel = normalizeMealLabel(mealLabel);
      existingFavorite.items = mealEntries;
      existingFavorite.updatedAt = new Date().toISOString();
    } else {
      store.favoriteMeals.unshift({
        id: uid("favorite-meal"),
        name: normalizedName,
        mealLabel: normalizeMealLabel(mealLabel),
        description: "",
        instructions: "",
        servings: 1,
        prepTimeMinutes: null,
        items: mealEntries,
        createdAt: new Date().toISOString(),
      });
    }

    persist();
    render();
    return;
  }

  if (action === "prefill-favorite-meal") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    if (!favorite) {
      return;
    }
    state.activeTab = "recipes";
    setFavoriteDraftFromRecipe(favorite);
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#favorite-meal-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#favorite-name")?.focus();
    });
    return;
  }

  if (action === "edit-favorite-item") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    const itemIndex = Number(actionTarget.dataset.itemIndex);
    const item = favorite?.items?.[itemIndex];
    if (!favorite || !item) {
      return;
    }
    state.activeTab = "recipes";
    setFavoriteDraftFromItem(favorite, item);
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#favorite-meal-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#favorite-name")?.focus();
    });
    return;
  }

  if (action === "cancel-edit-favorite-item") {
    resetFavoriteDraft();
    render();
    return;
  }

  if (action === "save-favorite-meal-draft") {
    const draftPreview = getFavoriteDraftPreview();
    const hasPendingItem = state.favoriteDraft.foodId && toNumber(state.favoriteDraft.grams) > 0;
    const existingFavorite = getFavoriteMealByName(draftPreview.favoriteName);

    if (!draftPreview.favoriteName || !draftPreview.mealLabel) {
      showFeedbackToast({ title: "Fali naziv ili tip obroka", detail: "Upiši naziv i tip obroka pre čuvanja recepta.", tone: "warning" });
      return;
    }

    if (hasPendingItem) {
      const saved = saveFavoriteMealItem({
        favoriteName: state.favoriteDraft.favoriteName,
        mealLabel: state.favoriteDraft.mealLabel,
        description: state.favoriteDraft.description,
        servings: state.favoriteDraft.servings,
        prepTimeMinutes: state.favoriteDraft.prepTimeMinutes,
        instructions: state.favoriteDraft.instructions,
        foodId: state.favoriteDraft.foodId,
        grams: state.favoriteDraft.grams,
      });
      if (!saved) {
        return;
      }
    } else if (!draftPreview.items.length || (!existingFavorite && !state.editingFavoriteItem.favoriteId)) {
      showFeedbackToast({ title: "Recept još nije spreman", detail: "Dodaj bar jedan sastojak pre čuvanja recepta.", tone: "warning" });
      return;
    } else {
      saveFavoriteMealMetadata({
        favoriteName: state.favoriteDraft.favoriteName,
        mealLabel: state.favoriteDraft.mealLabel,
        description: state.favoriteDraft.description,
        servings: state.favoriteDraft.servings,
        prepTimeMinutes: state.favoriteDraft.prepTimeMinutes,
        instructions: state.favoriteDraft.instructions,
      });
    }

    persist();
    const savedName = draftPreview.favoriteName;
    resetFavoriteDraft();
    render();
    showFeedbackToast({ title: "Recept je sačuvan", detail: `"${savedName}" je dodat u biblioteku recepata.` });
    return;
  }

  if (action === "add-favorite-meal") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    if (!favorite) {
      return;
    }
    if (!applyFavoriteMealToDay(favorite)) {
      return;
    }

    persist();
    render();
    showFeedbackToast({
      title: "Recept je dodat u plan",
      detail: favorite.servings > 1 ? `"${favorite.name}" je dodat kao 1 porcija.` : `"${favorite.name}" je dodat u plan.`,
    });
    return;
  }

  if (action === "apply-recipe-to-meal") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    const mealLabel = String(actionTarget.dataset.mealLabel || "").trim();
    const mode = String(actionTarget.dataset.mode || "append").trim();
    if (!favorite || !mealLabel) {
      return;
    }
    if (!applyFavoriteMealToDay(favorite, { mealLabel, mode })) {
      return;
    }

    persist();
    render();
    showFeedbackToast({
      title: mode === "replace" ? "Obrok je zamenjen receptom" : "Recept je dodat u plan",
      detail:
        favorite.servings > 1
          ? `"${favorite.name}" je sada vezan za ${mealLabel} kao 1 porcija.`
          : `"${favorite.name}" je sada vezan za ${mealLabel}.`,
    });
    return;
  }

  if (action === "add-favorite-item-to-day") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    const itemIndex = Number(actionTarget.dataset.itemIndex);
    const item = favorite?.items?.[itemIndex];
    if (!favorite || !item) {
      return;
    }

    const targetMealLabel = normalizeMealLabel(favorite.mealLabel || favorite.name);
    const servings = getRecipeServingCount(favorite);
    if (isMealCompletedForWeekday(state.selectedWeekday, targetMealLabel)) {
      showFeedbackToast({
        title: "Obrok je zaključan",
        detail: "Skini čekiranje sa tog obroka pa onda ubaci novi sastojak iz recepta.",
        tone: "warning",
      });
      return;
    }

    store.weeklyPlanEntries.push({
      id: uid("plan"),
      weekday: state.selectedWeekday,
      mealLabel: targetMealLabel,
      foodId: item.foodId,
      foodName: item.foodName,
      grams: Math.max(0.1, roundValue(toNumber(item.grams) / servings, 1)),
      done: false,
    });

    persist();
    render();
    return;
  }

  if (action === "delete-favorite-item") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    const itemIndex = Number(actionTarget.dataset.itemIndex);
    const item = favorite?.items?.[itemIndex];
    if (!favorite || !item) {
      return;
    }

    const confirmed = window.confirm(`Obriši "${item.foodName}" iz recepta "${favorite.name}"?`);
    if (!confirmed) {
      return;
    }

    favorite.items = favorite.items.filter((_, index) => index !== itemIndex);
    if (!favorite.items.length) {
      store.favoriteMeals = store.favoriteMeals.filter((entry) => entry.id !== favorite.id);
    }
    if (
      state.editingFavoriteItem.favoriteId === favorite.id &&
      state.editingFavoriteItem.itemIndex === itemIndex
    ) {
      resetFavoriteDraft();
    }
    persist();
    render();
    return;
  }

  if (action === "delete-favorite-meal") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    const confirmed = window.confirm(favorite ? `Obriši recept "${favorite.name}"?` : "Obriši ovaj recept?");
    if (!confirmed) {
      return;
    }
    store.favoriteMeals = store.favoriteMeals.filter((entry) => entry.id !== actionTarget.dataset.favoriteId);
    if (state.editingFavoriteItem.favoriteId === actionTarget.dataset.favoriteId) {
      resetFavoriteDraft();
    }
    persist();
    render();
    return;
  }

  if (action === "delete-entry") {
    const entryId = actionTarget.dataset.entryId;
    const entry = getPlanEntriesForDay(state.selectedWeekday).find((item) => item.id === entryId);
    if (entry && isMealCompletedForWeekday(state.selectedWeekday, entry.mealLabel)) {
      return;
    }
    const confirmed = window.confirm(
      entry
        ? `Obriši stavku "${entry.foodName}" (${roundValue(entry.grams, 0)} g) iz ${entry.mealLabel}?`
        : "Obriši ovu stavku iz plana?"
    );

    if (!confirmed) {
      return;
    }

    const removedIndex = store.weeklyPlanEntries.findIndex((item) => item.id === entryId);
    const removedEntry = removedIndex >= 0 ? { ...store.weeklyPlanEntries[removedIndex] } : null;
    if (state.editingEntryId === entryId) {
      resetPlanDraft();
    }
    store.weeklyPlanEntries = store.weeklyPlanEntries.filter((item) => item.id !== entryId);
    persist();
    if (removedEntry) {
      queueDeletedPlanEntry(removedEntry, removedIndex);
    }
    render();
    return;
  }

  if (action === "undo-delete-entry") {
    if (!state.deletedPlanEntry) {
      return;
    }

    const { entry, index } = state.deletedPlanEntry;
    const safeIndex = typeof index === "number" && index >= 0 ? index : store.weeklyPlanEntries.length;
    store.weeklyPlanEntries.splice(safeIndex, 0, entry);
    persist();
    clearDeletedPlanEntry();
    render();
    return;
  }

  if (action === "delete-training-log") {
    store.trainingLogs = store.trainingLogs.filter((log) => log.id !== actionTarget.dataset.logId);
    persist();
    render();
    return;
  }

  if (action === "save-training-favorite") {
    const template = store.trainingTemplates.find((entry) => entry.id === actionTarget.dataset.templateId);
    if (!template) {
      return;
    }

    const suggestedName = template.name || "Trening";
    const favoriteName = window.prompt("Naziv omiljenog treninga:", suggestedName);
    if (!favoriteName || !favoriteName.trim()) {
      return;
    }

    const normalizedName = favoriteName.trim();
    const existingFavorite = store.favoriteTrainings.find(
      (entry) => entry.name.toLowerCase() === normalizedName.toLowerCase()
    );
    const nextTraining = {
      name: normalizedName,
      exercises: template.exercises.map((exercise) => ({
        id: uid("exercise"),
        name: exercise.name,
        details: exercise.details,
      })),
      updatedAt: new Date().toISOString(),
    };

    if (existingFavorite) {
      existingFavorite.name = nextTraining.name;
      existingFavorite.exercises = nextTraining.exercises;
      existingFavorite.updatedAt = nextTraining.updatedAt;
    } else {
      store.favoriteTrainings.unshift({
        id: uid("favorite-training"),
        createdAt: new Date().toISOString(),
        ...nextTraining,
      });
    }

    persist();
    render();
    return;
  }

  if (action === "apply-favorite-training") {
    const favoriteTraining = store.favoriteTrainings.find(
      (entry) => entry.id === actionTarget.dataset.favoriteTrainingId
    );
    if (!favoriteTraining) {
      return;
    }

    store.trainingTemplates.push({
      id: uid("training"),
      weekday: state.selectedWeekday,
      name: favoriteTraining.name,
      exercises: favoriteTraining.exercises.map((exercise) => ({
        id: uid("exercise"),
        name: exercise.name,
        details: exercise.details,
      })),
    });
    persist();
    render();
    return;
  }

  if (action === "delete-favorite-training") {
    const favoriteTraining = store.favoriteTrainings.find(
      (entry) => entry.id === actionTarget.dataset.favoriteTrainingId
    );
    const confirmed = window.confirm(
      favoriteTraining ? `Obriši omiljeni trening "${favoriteTraining.name}"?` : "Obriši omiljeni trening?"
    );
    if (!confirmed) {
      return;
    }

    store.favoriteTrainings = store.favoriteTrainings.filter(
      (entry) => entry.id !== actionTarget.dataset.favoriteTrainingId
    );
    persist();
    render();
    return;
  }

  if (action === "delete-training-progress") {
    store.trainingProgressLogs = store.trainingProgressLogs.filter((log) => log.id !== actionTarget.dataset.progressId);
    persist();
    render();
    return;
  }

  if (action === "delete-measurement") {
    store.measurements = store.measurements.filter((entry) => entry.id !== actionTarget.dataset.measurementId);
    persist();
    render();
    return;
  }

  if (action === "delete-photo") {
    store.progressPhotos = store.progressPhotos.filter((photo) => photo.id !== actionTarget.dataset.photoId);
    persist();
    render();
    return;
  }

  if (action === "recalculate-goals") {
    await runButtonAction(
      actionTarget,
      async () => {
        const profileDraft = {
          age: toNumber(document.querySelector("#profile-age")?.value || store.profile.age),
          weightKg: toNumber(document.querySelector("#profile-weight")?.value || store.profile.weightKg),
          heightCm: toNumber(document.querySelector("#profile-height")?.value || store.profile.heightCm),
          sex: String(document.querySelector("#profile-sex")?.value || store.profile.sex || "").trim(),
          activityLevel: String(document.querySelector("#profile-activity")?.value || store.profile.activityLevel || "moderate").trim(),
        };
        const goalsDraft = {
          targetMode: String(document.querySelector("#goal-target-mode")?.value || store.goals.targetMode || "lose").trim(),
        };
        const recommendation = getGoalRecommendation(profileDraft, goalsDraft);

        if (!recommendation) {
          showFeedbackToast({
            title: "Fali još podataka",
            detail: "Za obračun unesi pol, godine, visinu i težinu.",
            tone: "warning",
          });
          return;
        }

        document.querySelector("#goal-protein").value = recommendation.protein;
        document.querySelector("#goal-carbs").value = recommendation.carbs;
        document.querySelector("#goal-fat").value = recommendation.fat;
        document.querySelector("#goal-calories").value = recommendation.targetCalories;
      },
      {
        busyLabel: "Računam...",
        successTitle: "Ciljevi su popunjeni",
        successDetail: "BMR, cilj kalorija i makroi su izračunati iz profila i izabranog cilja.",
      }
    );
    return;
  }

  if (action === "export-data") {
    await runButtonAction(
      actionTarget,
      async () => {
        exportData();
      },
      {
        busyLabel: "Spremam...",
        successTitle: "Backup je spreman",
        successDetail: "JSON backup je preuzet na uređaj.",
      }
    );
    return;
  }

  if (action === "set-auth-mode") {
    state.authMode = actionTarget.dataset.mode === "register" ? "register" : "login";
    state.authError = "";
    render();
    return;
  }

  if (action === "toggle-auth-password") {
    const passwordInput = document.querySelector("#auth-password");
    if (!(passwordInput instanceof HTMLInputElement)) {
      return;
    }

    const nextVisible = passwordInput.type === "password";
    passwordInput.type = nextVisible ? "text" : "password";
    actionTarget.innerHTML = renderPasswordToggleIcon(nextVisible);
    actionTarget.setAttribute("aria-label", nextVisible ? "Sakrij lozinku" : "Prikaži lozinku");
    actionTarget.setAttribute("aria-pressed", String(nextVisible));
    return;
  }

  if (action === "sign-out") {
    state.navMenuOpen = false;
    signOut(firebaseAuth).catch((error) => {
      console.error("Sign out failed", error);
      window.alert("Odjava nije uspela. Pokusaj ponovo.");
    });
  }
}

async function handleSubmit(event) {
  if (!(event.target instanceof HTMLFormElement)) {
    return;
  }

  event.preventDefault();
  const formData = new FormData(event.target);

  if (event.target.id === "auth-form") {
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");

    if (!email || !password) {
      return;
    }

    state.authPending = true;
    state.authError = "";
    render();

    try {
      if (state.authMode === "register") {
        await createUserWithEmailAndPassword(firebaseAuth, email, password);
      } else {
        await signInWithEmailAndPassword(firebaseAuth, email, password);
      }
    } catch (error) {
      console.error("Auth submit failed", error);
      state.authError = getAuthErrorMessage(error);
      state.authPending = false;
      render();
    }
    return;
  }

  if (event.target.id === "plan-entry-form") {
    const mealLabel = normalizeMealLabel(String(formData.get("mealLabel") || "").trim());
    const foodId = String(formData.get("foodId") || "").trim();
    const grams = toNumber(formData.get("grams"));
    const food = getFoodById(foodId);

    if (!mealLabel || !food || !grams || isMealCompletedForWeekday(state.selectedWeekday, mealLabel)) {
      return;
    }

    if (state.editingEntryId) {
      store.weeklyPlanEntries = store.weeklyPlanEntries.map((entry) =>
        entry.id === state.editingEntryId
          ? {
              ...entry,
              mealLabel,
              foodId: food.id,
              foodName: food.name,
              grams,
            }
          : entry
      );
    } else {
      store.weeklyPlanEntries.push({
        id: uid("plan"),
        weekday: state.selectedWeekday,
        mealLabel,
        foodId: food.id,
        foodName: food.name,
        grams,
        done: false,
      });
    }
    persist();
    resetPlanDraft();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "duplicate-day-form") {
    const targetWeekday = String(formData.get("targetWeekday") || "").trim();
    const mode = String(formData.get("mode") || "append").trim();
    if (!targetWeekday || targetWeekday === state.selectedWeekday) {
      return;
    }

    const sourceEntries = store.weeklyPlanEntries.filter((entry) => entry.weekday === state.selectedWeekday);
    if (!sourceEntries.length) {
      return;
    }

    const targetHasEntries = store.weeklyPlanEntries.some((entry) => entry.weekday === targetWeekday);
    if (mode === "replace" && targetHasEntries) {
      const confirmed = window.confirm(`Da li zelis da zamenis sve stavke za ${targetWeekday}?`);
      if (!confirmed) {
        return;
      }
      store.weeklyPlanEntries = store.weeklyPlanEntries.filter((entry) => entry.weekday !== targetWeekday);
    }

    sourceEntries.forEach((entry) => {
      store.weeklyPlanEntries.push({
        ...entry,
        id: uid("plan"),
        weekday: targetWeekday,
        done: false,
      });
    });

    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "food-form") {
    const name = String(formData.get("name") || "").trim();
    if (!name) {
      return;
    }

    const nextFood = {
      name,
      category: String(formData.get("category") || "Ostalo").trim() || "Ostalo",
      servingBaseGrams: 100,
      kcal: toNumber(formData.get("kcal")),
      protein: toNumber(formData.get("protein")),
      carbs: toNumber(formData.get("carbs")),
      fat: toNumber(formData.get("fat")),
    };

    if (state.editingFoodId) {
      store.foods = store.foods.map((food) =>
        food.id === state.editingFoodId
          ? {
              ...food,
              ...nextFood,
            }
          : food
      );
      syncFoodNameAcrossStore(state.editingFoodId, nextFood.name);
      resetFoodEditing();
    } else {
      store.foods.push({
        id: uid("food"),
        ...nextFood,
      });
    }

    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "nutrition-food-form") {
    const foodId = String(formData.get("foodId") || "").trim();
    const food = getFoodById(foodId);
    if (!food) {
      return;
    }

    const linkedFoodId = String(formData.get("linkedFoodId") || "").trim();
    if (linkedFoodId) {
      const linkedFood = linkImportedFoodToExisting(store, foodId, linkedFoodId);
      if (!linkedFood) {
        showFeedbackToast({
          title: "Povezivanje nije uspelo",
          detail: "Izabrana namirnica nije pronađena u bazi.",
          tone: "warning",
        });
        return;
      }

      state.nutritionEditingFoodId = "";
      persist();
      render();
      showFeedbackToast({
        title: "Namirnica je povezana",
        detail: `${food.name} sada koristi vrednosti iz stavke "${linkedFood.name}". Recepti su odmah preračunati.`,
        tone: "success",
      });
      return;
    }

    const proteinInput = String(formData.get("protein") || "").trim();
    const carbsInput = String(formData.get("carbs") || "").trim();
    const fatInput = String(formData.get("fat") || "").trim();
    const protein = toNumber(proteinInput);
    const carbs = toNumber(carbsInput);
    const fat = toNumber(fatInput);
    const hasAnyMacros = protein > 0 || carbs > 0 || fat > 0;
    const kcalInput = String(formData.get("kcal") || "").trim();
    const hasExplicitNutritionInput = Boolean(kcalInput || proteinInput || carbsInput || fatInput);
    const isExplicitZeroNutrition = hasExplicitNutritionInput && !(toNumber(kcalInput) > 0 || hasAnyMacros);
    const kcal = kcalInput ? toNumber(kcalInput) : hasAnyMacros ? roundValue(protein * 4 + carbs * 4 + fat * 9, 1) : 0;

    if (!hasExplicitNutritionInput) {
      showFeedbackToast({
        title: "Dodaj makar jednu vrednost",
        detail: "Unesi kcal ili barem neki od makroa da bih sačuvao namirnicu.",
        tone: "warning",
      });
      return;
    }

    const nutritionSource = String(formData.get("nutritionSource") || "").trim();
    store.foods = store.foods.map((entry) =>
      entry.id === foodId
        ? {
            ...entry,
            kcal,
            protein,
            carbs,
            fat,
            nutritionSource,
            nutritionZeroConfirmed: isExplicitZeroNutrition,
            nutritionUpdatedAt: new Date().toISOString(),
          }
        : entry
    );
    const savedFood = promoteImportedFoodToLibrary(store, foodId);
    pruneNutritionImportIndexes();

    state.nutritionEditingFoodId = "";
    persist();
    render();
    showFeedbackToast({
      title: "Nutritivne vrednosti su sačuvane",
      detail: `${savedFood?.name || food.name} sada je regularna stavka u Namirnicama i neće se vraćati u nutrition review.`,
      tone: "success",
    });
    return;
  }

  if (event.target.id === "habit-form") {
    const name = String(formData.get("name") || "").trim();
    const note = String(formData.get("note") || "").trim();
    const trackingMode = String(formData.get("trackingMode") || "weekly").trim() === "streak" ? "streak" : "weekly";
    const streakStartDate =
      trackingMode === "streak" ? normalizeDateValue(String(formData.get("streakStartDate") || "").trim()) || getTodayDateValue() : "";
    if (!name) {
      return;
    }

    if (state.editingHabitId) {
      store.habits = store.habits.map((habit) =>
        habit.id === state.editingHabitId
          ? {
              ...habit,
              name,
              note,
              trackingMode,
              completions: trackingMode === "weekly" ? habit.completions || {} : {},
              streakStartDate,
              bestStreakDays:
                trackingMode === "streak"
                  ? Math.max(
                      Math.max(0, toNumber(habit.bestStreakDays)),
                      getHabitCurrentStreakDays({
                        ...habit,
                        trackingMode,
                        streakStartDate,
                      })
                    )
                  : 0,
              resetCount: trackingMode === "streak" ? Math.max(0, toNumber(habit.resetCount)) : 0,
              lastResetAt: trackingMode === "streak" ? normalizeDateValue(habit.lastResetAt) : "",
              updatedAt: new Date().toISOString(),
            }
          : habit
      );
      state.editingHabitId = "";
    } else {
      store.habits.push({
        id: uid("habit"),
        name,
        note,
        trackingMode,
        completions: trackingMode === "weekly" ? {} : {},
        streakStartDate,
        bestStreakDays: 0,
        resetCount: 0,
        lastResetAt: "",
        createdAt: new Date().toISOString(),
      });
    }
    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "task-form") {
    const title = String(formData.get("title") || "").trim();
    const note = String(formData.get("note") || "").trim();
    if (!title) {
      return;
    }

    if (state.editingTaskId) {
      store.dayTasks = store.dayTasks.map((task) =>
        task.id === state.editingTaskId
          ? {
              ...task,
              title,
              note,
            }
          : task
      );
      state.editingTaskId = "";
    } else {
      store.dayTasks.push({
        id: uid("task"),
        weekday: state.selectedWeekday,
        title,
        note,
        done: false,
        createdAt: new Date().toISOString(),
      });
    }
    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "supplement-form") {
    const name = String(formData.get("name") || "").trim();
    const timing = String(formData.get("timing") || "breakfast").trim();
    const note = String(formData.get("note") || "").trim();
    const weekdays = formData
      .getAll("supplementWeekday")
      .map((entry) => String(entry || "").trim())
      .filter((weekday) => WEEKDAYS.includes(weekday));

    if (!name) {
      return;
    }

    const nextSupplement = {
      name,
      timing,
      note,
      weekdays: weekdays.length ? weekdays : [...WEEKDAYS],
    };

    if (state.editingSupplementId) {
      store.supplements = store.supplements.map((supplement) =>
        supplement.id === state.editingSupplementId
          ? {
              ...supplement,
              ...nextSupplement,
            }
          : supplement
      );
      state.editingSupplementId = "";
    } else {
      store.supplements.push({
        id: uid("supplement"),
        ...nextSupplement,
        completions: {},
        createdAt: new Date().toISOString(),
      });
    }

    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "favorite-meal-form") {
    const favoriteName = String(formData.get("favoriteName") || "").trim();
    const mealLabel = normalizeMealLabel(String(formData.get("mealLabel") || "").trim());
    const description = String(formData.get("description") || "").trim();
    const servings = String(formData.get("servings") || "1").trim();
    const prepTimeMinutes = String(formData.get("prepTimeMinutes") || "").trim();
    const instructions = String(formData.get("instructions") || "").trim();
    const foodId = String(formData.get("foodId") || "").trim();
    const grams = toNumber(formData.get("grams"));
    const saved = saveFavoriteMealItem({
      favoriteName,
      mealLabel,
      description,
      servings,
      prepTimeMinutes,
      instructions,
      foodId,
      grams,
    });

    if (!saved) {
      return;
    }

    persist();
    resetFavoriteDraft({ preserveRecipeMeta: true });
    render();
    return;
  }

  if (event.target.id === "training-form") {
    const weekday = String(formData.get("weekday") || state.selectedWeekday).trim();
    const name = String(formData.get("name") || "").trim();
    const lines = String(formData.get("exercises") || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!WEEKDAYS.includes(weekday) || !name || !lines.length) {
      return;
    }

    store.trainingTemplates.push({
      id: uid("training"),
      weekday,
      name,
      exercises: lines.map((line) => ({
        id: uid("exercise"),
        name: line.split(/\s+\d/)[0] || line,
        details: line,
      })),
    });
    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "training-progress-form") {
    const date = String(formData.get("date") || "").trim();
    const weekday = String(formData.get("weekday") || state.selectedWeekday).trim();
    const exerciseName = String(formData.get("exerciseName") || "").trim();
    const weightKg = toNumber(formData.get("weightKg"));
    const reps = String(formData.get("reps") || "").trim();
    const note = String(formData.get("note") || "").trim();

    if (!date || !WEEKDAYS.includes(weekday) || !exerciseName || !weightKg) {
      return;
    }

    store.trainingProgressLogs.unshift({
      id: uid("training-progress"),
      date,
      weekday,
      exerciseName,
      weightKg,
      reps,
      note,
      createdAt: new Date().toISOString(),
    });
    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "training-burn-form") {
    const submitButton = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
    await runButtonAction(
      submitButton,
      async () => {
        const burnKcal = Math.max(0, toNumber(formData.get("burnKcal")));
        store.trainingBurnByWeekday[state.selectedWeekday] = burnKcal;
        persist();
        render();
      },
      {
        busyLabel: "Čuvam...",
        successTitle: "Potrošnja je sačuvana",
        successDetail: `Apple Watch unos za ${state.selectedWeekday} je ažuriran.`,
      }
    );
    return;
  }

  if (event.target.id === "training-log-form") {
    const note = String(formData.get("note") || "").trim();
    if (!note) {
      return;
    }
    store.trainingLogs.unshift({
      id: uid("training-log"),
      weekday: state.selectedWeekday,
      note,
      createdAt: new Date().toLocaleString("sr-RS"),
    });
    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "measurement-form") {
    const date = String(formData.get("date") || "").trim();
    if (!date) {
      return;
    }

    const measurement = {
      id: uid("measurement"),
      date,
    };

    measurementFields.forEach((field) => {
      const raw = formData.get(field.id);
      if (field.type === "number") {
        const value = raw === "" ? null : toNumber(raw);
        if (value !== null) {
          measurement[field.id] = value;
        }
        return;
      }

      const value = String(raw || "").trim();
      if (value) {
        measurement[field.id] = value;
      }
    });

    const hasAnyData = measurementFields.some((field) => measurement[field.id] !== undefined);
    if (!hasAnyData) {
      return;
    }

    store.measurements.unshift(measurement);
    if (measurement.weightKg) {
      store.profile.weightKg = measurement.weightKg;
    }
    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "photo-form") {
    const file = event.target.querySelector("#photo-file")?.files?.[0];
    const date = String(formData.get("date") || "").trim();
    const tag = String(formData.get("tag") || "").trim();
    const note = String(formData.get("note") || "").trim();

    if (!file || !date || !PHOTO_TAGS.includes(tag)) {
      return;
    }

    const optimized = await createOptimizedPhoto(file);
    const record = {
      id: uid("photo"),
      date,
      tag,
      note,
      previewUrl: optimized.previewUrl,
      width: optimized.width,
      height: optimized.height,
    };

    store.progressPhotos.unshift(record);
    const saved = persist(() => {
      store.progressPhotos = store.progressPhotos.filter((photo) => photo.id !== record.id);
    });

    if (saved) {
      event.target.reset();
      render();
    }
    return;
  }

  if (event.target.id === "goals-form") {
    const submitButton = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
    await runButtonAction(
      submitButton,
      async () => {
        store.profile.name = String(formData.get("name") || "").trim();
        store.profile.sex = String(formData.get("sex") || "").trim();
        store.profile.age = toNumber(formData.get("age"));
        store.profile.weightKg = toNumber(formData.get("weightKg"));
        store.profile.heightCm = toNumber(formData.get("heightCm"));
        store.profile.activityLevel = String(formData.get("activityLevel") || "moderate").trim();
        store.goals.targetMode = String(formData.get("targetMode") || "lose").trim();
        store.goals.calories = toNumber(formData.get("calories"));
        store.goals.protein = toNumber(formData.get("protein"));
        store.goals.carbs = toNumber(formData.get("carbs"));
        store.goals.fat = toNumber(formData.get("fat"));
        persist();
        render();
      },
      {
        busyLabel: "Čuvam...",
        successTitle: "Ciljevi su sačuvani",
        successDetail: "Dnevni plan i makroi su ažurirani.",
      }
    );
    return;
  }
}

function handleInput(event) {
  const target = event.target;

  if (target instanceof HTMLInputElement && target.id === "food-search") {
    state.foodSearch = target.value;
    const selectionStart = target.selectionStart ?? target.value.length;
    const selectionEnd = target.selectionEnd ?? target.value.length;
    if (foodSearchRenderTimer) {
      window.clearTimeout(foodSearchRenderTimer);
    }
    foodSearchRenderTimer = window.setTimeout(() => {
      foodSearchRenderTimer = null;
      render();
      window.requestAnimationFrame(() => {
        const searchInput = document.querySelector("#food-search");
        if (!(searchInput instanceof HTMLInputElement)) {
          return;
        }
        searchInput.focus();
        const safeStart = Math.min(selectionStart, searchInput.value.length);
        const safeEnd = Math.min(selectionEnd, searchInput.value.length);
        searchInput.setSelectionRange(safeStart, safeEnd);
      });
    }, 120);
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-name") {
    state.favoriteDraft.favoriteName = target.value;
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-meal-label") {
    state.favoriteDraft.mealLabel = target.value;
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-description") {
    state.favoriteDraft.description = target.value;
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-servings") {
    state.favoriteDraft.servings = target.value;
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-prep-time") {
    state.favoriteDraft.prepTimeMinutes = target.value;
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "mealLabel") {
    state.planDraft.mealLabel = target.value;
    syncEntryPreview();
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "grams") {
    state.planDraft.grams = target.value;
    syncEntryPreview();
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-grams") {
    state.favoriteDraft.grams = target.value;
    render();
    return;
  }

  if (target instanceof HTMLTextAreaElement && target.id === "favorite-instructions") {
    state.favoriteDraft.instructions = target.value;
    return;
  }

  if (target instanceof HTMLSelectElement && target.id === "foodId") {
    state.planDraft.foodId = target.value;
    render();
    return;
  }

  if (target instanceof HTMLSelectElement && target.id === "favorite-food-id") {
    state.favoriteDraft.foodId = target.value;
    render();
    return;
  }

  if (target instanceof HTMLSelectElement && target.id === "compare-left") {
    state.progressCompareLeftId = target.value;
    render();
    return;
  }

  if (target instanceof HTMLSelectElement && target.id === "compare-tag") {
    state.progressCompareTag = target.value;
    state.progressCompareLeftId = "";
    state.progressCompareRightId = "";
    render();
    return;
  }

  if (target instanceof HTMLSelectElement && target.id === "compare-right") {
    state.progressCompareRightId = target.value;
    render();
  }
}

async function handleImport(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === "grams") {
    render();
    return;
  }

  if (!(target instanceof HTMLInputElement) || !target.files?.length) {
    return;
  }

  if (target.id === "import-json") {
    try {
      const parsed = JSON.parse(await target.files[0].text());
      replaceStore(parsed);
      persist();
      render();
      showFeedbackToast({ title: "Backup je uspešno uvezen", detail: "Podaci iz fajla su sada učitani u app." });
    } catch (error) {
      showFeedbackToast({ title: "Backup nije validan", detail: "Izabrani fajl nije ispravan JSON backup.", tone: "error" });
    }
    target.value = "";
    return;
  }

  if (target.id !== "nutrition-import-files") {
    return;
  }

  const files = [...target.files];
  state.nutritionImportPending = true;
  state.nutritionImportStatus =
    files.length === 1 ? `Obrađujem "${files[0].name}"...` : `Obrađujem ${files.length} dokumenta...`;
  render();

  try {
    const result = await importNutritionFiles(files);
    persist();
    showFeedbackToast({
      title: result.importedDocuments.length ? "Dokumenti su uvezeni" : "Import je završen",
      detail: `${result.importedDocuments.length} dok. · ${result.totalRecommendations} preporuka · ${result.totalRecipes} recepata · ${result.totalFoods} namirnica${
        result.errors.length ? ` · ${result.errors.length} grešaka` : ""
      }`,
      tone: result.errors.length ? "warning" : "success",
      duration: result.errors.length ? 4200 : 2800,
    });
  } catch (error) {
    showFeedbackToast({
      title: "Import nije uspeo",
      detail: error instanceof Error ? error.message : "Pokušaj ponovo sa drugim dokumentom.",
      tone: "error",
      duration: 3600,
    });
  } finally {
    state.nutritionImportPending = false;
    state.nutritionImportStatus = "";
    target.value = "";
    render();
  }
}

document.addEventListener("click", handleDocumentClick);
document.addEventListener("submit", handleSubmit);
document.addEventListener("input", handleInput);
document.addEventListener("change", handleImport);

window.addEventListener("hashchange", () => {
  const nextTab = getInitialTab();
  if (nextTab !== state.activeTab) {
    state.activeTab = nextTab;
    state.navMenuOpen = false;
    resetFoodEditing();
    resetRoutineEditing();
    render();
  }
});

window.addEventListener("scroll", updateHeroScrollState, { passive: true });

onAuthStateChanged(firebaseAuth, async (user) => {
  state.authPending = false;
  state.authError = "";
  state.authUser = user;

  if (!user) {
    state.authReady = true;
    state.syncStatus = "Prijavi se za cloud sync";
    render();
    return;
  }

  state.authReady = false;
  render();
  await hydrateStoreFromCloud(user);
  state.authReady = true;
  render();
});

render();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((registration) => {
        serviceWorkerRegistration = registration;

        if (registration.waiting) {
          markUpdateReady(registration);
        }

        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) {
            return;
          }

          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              markUpdateReady(registration);
            }
          });
        });

        window.setInterval(() => {
          registration.update().catch(() => {});
        }, 60 * 1000);
      })
      .catch((error) => {
        console.error("SW registration failed", error);
      });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      state.updateReady = false;
      window.location.reload();
    });
  });
}
