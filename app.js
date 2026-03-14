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
  { id: "recipes", label: "Obroci", icon: "🥣" },
  { id: "foods", label: "Namirnice", icon: "🥚" },
  { id: "training", label: "Trening", icon: "🏋️" },
  { id: "progress", label: "Napredak", icon: "📏" },
  { id: "goals", label: "Ciljevi", icon: "🎯" },
];

const defaultMeals = [
  "1. Dorucak",
  "2. Uzina",
  "3. Obrok pre treninga",
  "4. Obrok posle treninga",
  "5. Vecera",
];

const measurementFields = [
  { id: "trainingType", label: "Trening", type: "text", placeholder: "npr. noge" },
  { id: "calorieDeficit", label: "Kalorije deficit", type: "number", step: "1", unit: "kcal" },
  { id: "weightKg", label: "Tezina", type: "number", step: "0.1", unit: "kg" },
  { id: "thighCm", label: "Butine", type: "number", step: "0.1", unit: "cm" },
  { id: "upperWaistCm", label: "Stomak gornji", type: "number", step: "0.1", unit: "cm" },
  { id: "lowerWaistCm", label: "Stomak donji", type: "number", step: "0.1", unit: "cm" },
  { id: "chestCm", label: "Grudi", type: "number", step: "0.1", unit: "cm" },
  { id: "armCm", label: "Ruke", type: "number", step: "0.1", unit: "cm" },
];

const PHOTO_TAGS = ["front", "side", "back"];
const FOOD_MACRO_FILTERS = ["Sve", "Proteini", "UH", "Masti", "Ostalo"];

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
    foodId: "",
    grams: "",
  },
  isPlanHeroCompact: false,
  progressCompareTag: PHOTO_TAGS[0],
  progressCompareLeftId: "",
  progressCompareRightId: "",
  deletedPlanEntry: null,
  authReady: false,
  authPending: false,
  authMode: "login",
  authUser: null,
  authError: "",
  syncStatus: "Lokalno cuvanje",
};

let undoDeleteTimer = null;
let cloudSaveTimer = null;
let isHydratingCloudState = false;

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const firebaseAuth = getAuth(firebaseApp);
const firebaseDb = getFirestore(firebaseApp);

function cloneSeed() {
  return JSON.parse(JSON.stringify(window.SEED_DATA || {}));
}

function normalizeStoreSnapshot(rawStore = {}, fallback = cloneSeed()) {
  return {
    ...fallback,
    ...rawStore,
    profile: { ...fallback.profile, ...(rawStore.profile || {}) },
    goals: { ...fallback.goals, ...(rawStore.goals || {}) },
    meta: { ...fallback.meta, ...(rawStore.meta || {}) },
    foods: Array.isArray(rawStore.foods) ? rawStore.foods : fallback.foods,
    weeklyPlanEntries: Array.isArray(rawStore.weeklyPlanEntries)
      ? rawStore.weeklyPlanEntries
      : fallback.weeklyPlanEntries,
    trainingTemplates: Array.isArray(rawStore.trainingTemplates)
      ? rawStore.trainingTemplates
      : fallback.trainingTemplates,
    trainingLogs: Array.isArray(rawStore.trainingLogs) ? rawStore.trainingLogs : [],
    trainingProgressLogs: Array.isArray(rawStore.trainingProgressLogs) ? rawStore.trainingProgressLogs : [],
    trainingBurnByWeekday:
      rawStore.trainingBurnByWeekday && typeof rawStore.trainingBurnByWeekday === "object"
        ? rawStore.trainingBurnByWeekday
        : {},
    measurements: Array.isArray(rawStore.measurements) ? rawStore.measurements : [],
    progressPhotos: Array.isArray(rawStore.progressPhotos) ? rawStore.progressPhotos : [],
    favoriteMeals: Array.isArray(rawStore.favoriteMeals) ? rawStore.favoriteMeals : [],
    favoriteFoods: Array.isArray(rawStore.favoriteFoods) ? rawStore.favoriteFoods : [],
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
  targetStore.trainingProgressLogs = targetStore.trainingProgressLogs || [];
  targetStore.trainingBurnByWeekday = targetStore.trainingBurnByWeekday || {};
  targetStore.measurements = targetStore.measurements || [];
  targetStore.progressPhotos = targetStore.progressPhotos || [];
  targetStore.favoriteMeals = targetStore.favoriteMeals || [];
  targetStore.favoriteFoods = targetStore.favoriteFoods || [];
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

  state.syncStatus = "Cuvam izmene u cloud...";
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
    window.alert("Ponestaje prostora za cuvanje podataka. Obrisi neke slike ili napravi backup.");
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

function getFoodById(foodId) {
  return store.foods.find((food) => food.id === foodId);
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

function getPlanEntriesForDay(weekday) {
  return store.weeklyPlanEntries
    .filter((entry) => entry.weekday === weekday)
    .map((entry) => {
      const food = getFoodById(entry.foodId) || store.foods.find((item) => item.name === entry.foodName);
      const totals = food ? calculateEntry(food, entry.grams) : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      return {
        ...entry,
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

function getTodayDateValue() {
  return new Date().toISOString().slice(0, 10);
}

function getWeeklyTrainingPlan() {
  return WEEKDAYS.map((weekday) => ({
    weekday,
    templates: getTrainingForDay(weekday),
    trainingBurn: getTrainingBurnForDay(weekday),
    progressCount: store.trainingProgressLogs.filter((log) => log.weekday === weekday).length,
  }));
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
  return store.favoriteMeals.map((favorite) => {
    const items = favorite.items.map((item) => {
      const food = getFoodById(item.foodId) || store.foods.find((entry) => entry.name === item.foodName);
      const totals = food ? calculateEntry(food, item.grams) : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      return {
        ...item,
        food,
        totals,
      };
    });

    return {
      ...favorite,
      items,
      totals: getDayTotals(items),
    };
  });
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

function resetFavoriteDraft() {
  state.editingFavoriteItem = {
    favoriteId: "",
    itemId: "",
    itemIndex: -1,
  };
  state.favoriteDraft = {
    favoriteName: "",
    mealLabel: "",
    foodId: "",
    grams: "",
  };
}

function setFavoriteDraftFromItem(favorite, item) {
  state.editingFavoriteItem = {
    favoriteId: favorite.id,
    itemId: item.id || "",
    itemIndex: favorite.items.findIndex((entry) => entry === item),
  };
  state.favoriteDraft = {
    favoriteName: favorite.name || "",
    mealLabel: favorite.mealLabel || "",
    foodId: item.foodId || "",
    grams: item.grams ? String(roundValue(item.grams, 0)) : "",
  };
}

function getFavoriteDraftPreview() {
  const favoriteName = String(state.favoriteDraft.favoriteName || "").trim();
  const mealLabel = String(state.favoriteDraft.mealLabel || "").trim();
  const food = getFoodById(state.favoriteDraft.foodId);
  const grams = toNumber(state.favoriteDraft.grams);
  const existingFavorite = state.editingFavoriteItem.favoriteId
    ? store.favoriteMeals.find((entry) => entry.id === state.editingFavoriteItem.favoriteId)
    : store.favoriteMeals.find((entry) => entry.name.toLowerCase() === favoriteName.toLowerCase());

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

  return {
    favoriteName,
    mealLabel: mealLabel || existingFavorite?.mealLabel || "",
    items,
    totals: getDayTotals(items.map((item) => ({ totals: item.totals }))),
  };
}

function saveFavoriteMealItem(favoriteName, mealLabel, foodId, grams) {
  const normalizedFavoriteName = String(favoriteName || "").trim();
  const normalizedMealLabel = String(mealLabel || "").trim();
  const normalizedFoodId = String(foodId || "").trim();
  const normalizedGrams = toNumber(grams);
  const food = getFoodById(normalizedFoodId);

  if (!normalizedFavoriteName || !normalizedMealLabel || !food || !normalizedGrams) {
    return false;
  }

  const nextItem = {
    id: state.editingFavoriteItem.itemId || uid("favorite-item"),
    foodId: food.id,
    foodName: food.name,
    grams: normalizedGrams,
  };

  if (state.editingFavoriteItem.favoriteId) {
    const favorite = store.favoriteMeals.find((entry) => entry.id === state.editingFavoriteItem.favoriteId);
    if (!favorite) {
      return false;
    }
    favorite.name = normalizedFavoriteName;
    favorite.mealLabel = normalizedMealLabel;
    favorite.items = favorite.items.map((item, index) =>
      index === state.editingFavoriteItem.itemIndex ? nextItem : item
    );
    favorite.updatedAt = new Date().toISOString();
    return true;
  }

  const existingFavorite = store.favoriteMeals.find(
    (favorite) => favorite.name.toLowerCase() === normalizedFavoriteName.toLowerCase()
  );

  if (existingFavorite) {
    existingFavorite.mealLabel = normalizedMealLabel;
    existingFavorite.items = [...existingFavorite.items, nextItem];
    existingFavorite.updatedAt = new Date().toISOString();
    return true;
  }

  store.favoriteMeals.unshift({
    id: uid("favorite-meal"),
    name: normalizedFavoriteName,
    mealLabel: normalizedMealLabel,
    items: [nextItem],
    createdAt: new Date().toISOString(),
  });
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
  const exact = getFoods().find((food) => lowered.some((name) => food.name.toLowerCase().includes(name)));
  if (exact) {
    return exact;
  }
  if (fallbackGroup) {
    return getFoods().find((food) => getFoodMacroGroup(food) === fallbackGroup) || null;
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
      mealLabel: "2. Uzina",
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
      mealLabel: "3. Obrok pre treninga",
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
    <section class="hero">
      <div class="hero-top" data-role="hero-top">
        <div>
          <span class="hero-tag">Plan</span>
          <h1>Nedeljni jelovnik</h1>
          <p>Izaberi dan i sredi obroke za taj plan.</p>
        </div>
      </div>
      <div class="hero-day-picker">
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
        <div class="auth-hero">
          <span class="auth-badge">Cloud sync</span>
          <h1>${state.authMode === "register" ? "Napravi svoj nalog" : "Prijavi se u svoj tracker"}</h1>
          <p>Plan, obroci, trening, ciljevi i merenja ce ti biti sacuvani i na telefonu i na racunaru.</p>
          <div class="auth-points">
            <span class="pill strong">Firestore sync</span>
            <span class="pill">Bez servera</span>
            <span class="pill">Slike ostaju lokalno</span>
          </div>
        </div>
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
        <form id="auth-form" class="form-grid">
          <div class="field">
            <label for="auth-email">Email</label>
            <input id="auth-email" name="email" type="email" placeholder="ti@email.com" autocomplete="email" required />
          </div>
          <div class="field password-field">
            <label for="auth-password">Lozinka</label>
            <div class="password-input-wrap">
              <input id="auth-password" name="password" type="password" placeholder="Minimum 6 karaktera" autocomplete="${state.authMode === "register" ? "new-password" : "current-password"}" required />
              <button class="ghost-button password-toggle" type="button" data-action="toggle-auth-password" aria-controls="auth-password" aria-label="Prikazi ili sakrij lozinku">
                Prikazi
              </button>
            </div>
          </div>
          ${
            state.authError
              ? `<div class="auth-feedback auth-feedback--error" role="alert">${state.authError}</div>`
              : `<div class="auth-note">Progress slike za sada ostaju lokalno na telefonu/browseru, a ostali podaci idu u cloud.</div>`
          }
          <button class="solid-button" type="submit" ${state.authPending ? "disabled" : ""}>${submitLabel}</button>
        </form>
        <div class="meta-row auth-toggle-row">
          <span class="footer-note">
            ${
              state.authMode === "register"
                ? "Vec imas nalog?"
                : "Prvi put ovde?"
            }
          </span>
          <button class="ghost-button" type="button" data-action="set-auth-mode" data-mode="${state.authMode === "register" ? "login" : "register"}">
            ${state.authMode === "register" ? "Idi na prijavu" : "Napravi nalog"}
          </button>
        </div>
      </section>
    </main>
  `;
}

function updateHeroScrollState() {
  if (state.activeTab !== "plan") {
    state.isPlanHeroCompact = false;
    document.body.classList.remove("plan-compact");
    return;
  }

  const compactThreshold = 72;
  const expandThreshold = 28;

  if (!state.isPlanHeroCompact && window.scrollY >= compactThreshold) {
    state.isPlanHeroCompact = true;
  } else if (state.isPlanHeroCompact && window.scrollY <= expandThreshold) {
    state.isPlanHeroCompact = false;
  }

  document.body.classList.toggle("plan-compact", state.isPlanHeroCompact);
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
  const activeMealLabel = state.planDraft.mealLabel || state.editingMealLabel || defaultMeals[0];
  const mealParts = getMealDisplayParts(activeMealLabel);

  return `
    <form id="plan-entry-form" class="form-grid split meal-composer">
      <input id="mealLabel" name="mealLabel" type="hidden" value="${activeMealLabel}" />
      <div class="composer-context">
        ${mealParts.order ? `<span class="meal-order">${mealParts.order}</span>` : ""}
        <div>
          <strong>${mealParts.title || activeMealLabel}</strong>
          <div class="footer-note">
            ${state.editingEntryId ? "Menjas postojecu stavku u ovom obroku." : "Dodajes novu namirnicu direktno u ovaj obrok."}
          </div>
        </div>
      </div>
      <div class="field">
        <label for="foodId">Namirnica</label>
        <select id="foodId" name="foodId" required>
          <option value="">Izaberi namirnicu</option>
          ${getFoods()
            .map((food) => `<option value="${food.id}" ${food.id === state.planDraft.foodId ? "selected" : ""}>${food.name}</option>`)
            .join("")}
        </select>
      </div>
      <div class="field">
        <label for="grams">Kolicina u gramima</label>
        <input id="grams" name="grams" type="number" min="1" step="1" placeholder="100" value="${state.planDraft.grams}" required />
      </div>
      <div class="preview-box" id="entry-preview">
        <h3>Preview</h3>
        <p>Izaberi namirnicu i gramazu da odmah vidis makroe.</p>
      </div>
      ${
        companionSuggestions.length
          ? `
            <div class="food-card suggestion-surface" id="companion-suggestions">
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
      <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap;">
        <button class="solid-button secondary-button" type="submit">${state.editingEntryId ? "Sacuvaj izmene" : "Dodaj namirnicu"}</button>
        ${
          state.editingEntryId
            ? `<button class="ghost-button" type="button" data-action="cancel-edit-entry">Odustani</button>`
            : `<button class="ghost-button" type="button" data-action="finish-edit-meal" data-meal-label="${state.editingMealLabel}">Zatvori</button>`
        }
      </div>
    </form>
  `;
}

function renderPlanTab(entries) {
  const groupedEntries = groupEntriesByMeal(entries);
  const totals = getDayTotals(entries);
  const trainingBurn = getTrainingBurnForDay(state.selectedWeekday);
  const netCalories = roundValue(totals.kcal - trainingBurn, 0);
  const meals = [...new Set([...defaultMeals, ...store.weeklyPlanEntries.map((entry) => entry.mealLabel)])];
  const planMeals = meals.map((mealLabel) => [mealLabel, entries.filter((entry) => entry.mealLabel === mealLabel)]);
  const favorites = getFavoriteMealsDetailed();
  const favoriteFoods = getFavoriteFoodsDetailed();
  const mealPreviewRows = getMealPreviewRows(groupedEntries);
  const daySuggestion = generateDaySuggestion();
  const companionSuggestions = generateCompanionSuggestions();
  const draftFood = getDraftFood();

  return `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Dnevni pregled</h2>
          <p>Tvoj plan po obrocima sa istom logikom kao u Excel-u.</p>
        </div>
      </div>
      ${renderMacroCards(totals)}
      <div class="stats-grid" style="margin-top:12px;">
        <article class="stat-card">
          <strong>Potroseno trening</strong>
          <div class="macro-value">${roundValue(trainingBurn, 0)} kcal</div>
          <div class="footer-note">Apple Watch unos za ${state.selectedWeekday}</div>
        </article>
        <article class="stat-card">
          <strong>Neto kcal</strong>
          <div class="macro-value">${netCalories} kcal</div>
          <div class="footer-note">Uneto minus potroseno na treningu</div>
        </article>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Preview dana</h2>
          <p>Brzi pregled po obrocima, da odmah vidis kako izgleda ceo dan.</p>
        </div>
      </div>
      <div class="stack">
        ${
          mealPreviewRows.length
            ? mealPreviewRows
                .map((row) => {
                  const mealParts = getMealDisplayParts(row.mealLabel);
                  return `
                    <article class="food-card">
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
            : `<div class="empty">Jos nema stavki za preview dana.</div>`
        }
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Brze akcije</h2>
          <p>Dupliciraj ceo dan kad imas slican raspored ili koristi omiljene namirnice za brz unos.</p>
        </div>
      </div>
      <form id="duplicate-day-form" class="form-grid split">
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
          <label for="duplicate-mode">Nacin kopiranja</label>
          <select id="duplicate-mode" name="mode">
            <option value="append">Dodaj u plan</option>
            <option value="replace">Prepisi dan</option>
          </select>
        </div>
        <button class="solid-button" type="submit">Kopiraj dan</button>
      </form>
      <div class="stack" style="margin-top:14px;">
        ${
          favoriteFoods.length
            ? `
              <div>
                <div class="list-header">Omiljene namirnice</div>
                <div class="chips" style="margin-top:10px;">
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
              </div>
            `
            : `<div class="empty">Dodaj omiljene namirnice iz taba Namirnice, pa ces ih ovde birati jednim tapom.</div>`
        }
        <article class="food-card suggestion-surface">
          <div class="food-card-top">
            <h3>Predlog celog dana</h3>
            <span class="pill strong">predlog</span>
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
          <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap;">
            <button class="solid-button secondary-button" data-action="apply-day-suggestion" data-mode="replace">
              Primeni na dan
            </button>
            <button class="ghost-button" data-action="apply-day-suggestion" data-mode="append">
              Dodaj u plan
            </button>
          </div>
        </article>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Baza obroka</h2>
          <p>Recepte i omiljene obroke sada drzis u posebnom tabu, pa ih odatle dodajes u dan kad ti zatrebaju.</p>
        </div>
      </div>
      <article class="food-card suggestion-surface">
        <div class="food-card-top">
          <h3>Omiljeni obroci i recepti</h3>
          <span class="pill strong">${favorites.length}</span>
        </div>
        <div class="footer-note">U tabu Obroci pravis, menjas i cuvas cele sastavljene obroke, pa ih jednim tapom dodajes u ${state.selectedWeekday}.</div>
        <div class="entry-actions" style="justify-content:flex-start; margin-top:12px;">
          <button class="solid-button secondary-button" data-action="switch-tab" data-tab="recipes">Idi na Obroke</button>
        </div>
      </article>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Obroci za ${state.selectedWeekday}</h2>
          <p>${entries.length ? "Mozes da menjas gramazu ili brises stavke." : "Jos nema stavki za ovaj dan."}</p>
        </div>
      </div>
      <div class="stack">
        ${
          planMeals.length
            ? planMeals
                .map(([mealLabel, mealEntries]) => {
                  const mealParts = getMealDisplayParts(mealLabel);
                  const isEditingMeal = state.editingMealLabel === mealLabel;
                  return `
                    <article class="meal-card ${isEditingMeal ? "is-editing" : ""}">
                      <div class="meal-card-topline">
                        ${mealParts.order ? `<span class="meal-order">${mealParts.order}</span>` : ""}
                        <div class="meal-card-heading">
                          <h3 class="meal-title">${mealParts.title || mealLabel}</h3>
                          <div class="footer-note">${isEditingMeal ? "Uredjujes ovaj obrok" : `Obrok za ${state.selectedWeekday}`}</div>
                        </div>
                      </div>
                      <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap;">
                        <button class="solid-button secondary-button" data-action="start-add-to-meal" data-meal-label="${mealLabel}">
                          Dodaj stavku
                        </button>
                        <button class="ghost-button" data-action="${isEditingMeal ? "finish-edit-meal" : "edit-meal"}" data-meal-label="${mealLabel}">
                          ${isEditingMeal ? "Zavrsi uredjivanje" : "Uredi obrok"}
                        </button>
                        ${
                          mealEntries.length
                            ? `
                              <button class="ghost-button" data-action="save-meal-as-favorite" data-meal-label="${mealLabel}">
                                Sacuvaj u Obroke
                              </button>
                            `
                            : ""
                        }
                      </div>
                      ${isEditingMeal ? renderPlanEntryComposer(meals, companionSuggestions, draftFood) : ""}
                      ${
                        mealEntries.length
                          ? mealEntries
                              .map(
                                (entry) => `
                                  <div class="meal-entry">
                                    <div class="meal-entry-top">
                                      <strong>${entry.foodName}</strong>
                                      <span class="pill">${roundValue(entry.grams, 0)} g</span>
                                    </div>
                                    <div class="pill-row">
                                      <span class="pill note">${roundValue(entry.totals.kcal, 0)} kcal</span>
                                      <span class="pill">P ${roundValue(entry.totals.protein, 1)} g</span>
                                      <span class="pill">UH ${roundValue(entry.totals.carbs, 1)} g</span>
                                      <span class="pill">M ${roundValue(entry.totals.fat, 1)} g</span>
                                    </div>
                                    <div class="entry-actions">
                                      <button class="ghost-button" data-action="edit-entry" data-entry-id="${entry.id}">
                                        Izmeni
                                      </button>
                                      <button class="danger-button" data-action="delete-entry" data-entry-id="${entry.id}">
                                        Obrisi
                                      </button>
                                    </div>
                                  </div>
                                `
                              )
                              .join("")
                          : `<div class="empty" style="margin-top:12px;">Jos nema stavki u ovom obroku.</div>`
                      }
                    </article>
                  `;
                })
                .join("")
            : `<div class="empty">Dodaj prvi obrok za ${state.selectedWeekday} i aplikacija ce odmah sabirati makroe.</div>`
        }
      </div>
    </section>
  `;
}

function renderFoodsTab() {
  const query = state.foodSearch.trim().toLowerCase();
  const foods = getFoods()
    .map((food) => ({
      ...food,
      macroGroup: getFoodMacroGroup(food),
    }))
    .filter((food) => {
      const matchesFilter = state.foodMacroFilter === "Sve" ? true : food.macroGroup === state.foodMacroFilter;
      if (!matchesFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return `${food.name} ${food.category} ${food.macroGroup}`.toLowerCase().includes(query);
    });
  const filterCounts = FOOD_MACRO_FILTERS.reduce((acc, filter) => {
    acc[filter] =
      filter === "Sve"
        ? store.foods.length
        : store.foods.filter((food) => getFoodMacroGroup(food) === filter).length;
    return acc;
  }, {});

  return `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Baza namirnica</h2>
          <p>Trenutno imas ${store.foods.length} namirnica iz Excel-a i nove koje uneses preko telefona.</p>
        </div>
      </div>
      <div class="chips" style="margin-bottom:14px;">
        ${FOOD_MACRO_FILTERS.map(
          (filter) => `
            <button
              class="chip is-light ${filter === state.foodMacroFilter ? "is-active" : ""}"
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
      <div class="food-list" style="margin-top:14px;">
        ${foods
          .map(
            (food) => `
              <article class="food-card">
                <div class="food-card-top">
                  <h3>${food.name}</h3>
                  <span class="pill strong">${food.macroGroup}</span>
                </div>
                <div class="pill-row">
                  <span class="pill">${food.category || "Ostalo"}</span>
                  <span class="pill note">${roundValue(food.kcal, 0)} kcal / ${roundValue(food.servingBaseGrams, 0)} g</span>
                  <span class="pill">P ${roundValue(food.protein, 1)}</span>
                  <span class="pill">UH ${roundValue(food.carbs, 1)}</span>
                  <span class="pill">M ${roundValue(food.fat, 1)}</span>
                </div>
                <div class="entry-actions" style="justify-content:flex-start; margin-top:12px;">
                  <button
                    class="${store.favoriteFoods.includes(food.id) ? "solid-button secondary-button" : "ghost-button"}"
                    data-action="toggle-favorite-food"
                    data-food-id="${food.id}"
                  >
                    ${store.favoriteFoods.includes(food.id) ? "Ukloni favorit" : "Sacuvaj favorit"}
                  </button>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Dodaj namirnicu</h2>
          <p>Unosis vrednosti na 100 g i posle ih koristis bilo kojom gramazom.</p>
        </div>
      </div>
      <form id="food-form" class="form-grid split">
        <div class="field">
          <label for="food-name">Naziv</label>
          <input id="food-name" name="name" placeholder="npr. Grcki jogurt" required />
        </div>
        <div class="field">
          <label for="food-category">Kategorija</label>
          <input id="food-category" name="category" placeholder="Proteini, masti, voce..." />
        </div>
        <div class="field">
          <label for="food-kcal">Kalorije na 100 g</label>
          <input id="food-kcal" name="kcal" type="number" step="0.1" min="0" required />
        </div>
        <div class="field">
          <label for="food-protein">Proteini na 100 g</label>
          <input id="food-protein" name="protein" type="number" step="0.1" min="0" required />
        </div>
        <div class="field">
          <label for="food-carbs">Ugljeni hidrati na 100 g</label>
          <input id="food-carbs" name="carbs" type="number" step="0.1" min="0" required />
        </div>
        <div class="field">
          <label for="food-fat">Masti na 100 g</label>
          <input id="food-fat" name="fat" type="number" step="0.1" min="0" required />
        </div>
        <button class="solid-button" type="submit">Sacuvaj namirnicu</button>
      </form>
    </section>
  `;
}

function renderRecipesTab() {
  const favorites = getFavoriteMealsDetailed();
  const meals = [...new Set([...defaultMeals, ...store.weeklyPlanEntries.map((entry) => entry.mealLabel)])];
  const draftPreview = getFavoriteDraftPreview();

  return `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Omiljeni obroci</h2>
          <p>Ovde pravis CEO obrok tako sto dodajes namirnicu po namirnicu, svaku sa svojom gramazom.</p>
        </div>
      </div>
      <form id="favorite-meal-form" class="form-grid split" style="margin-bottom:14px;">
        <div class="field">
          <label for="favorite-name">Naziv celog obroka</label>
          <input id="favorite-name" name="favoriteName" placeholder="npr. Ovseni dorucak" list="favorite-meal-options" value="${state.favoriteDraft.favoriteName}" required />
          <datalist id="favorite-meal-options">
            ${favorites.map((favorite) => `<option value="${favorite.name}"></option>`).join("")}
          </datalist>
        </div>
        <div class="field">
          <label for="favorite-meal-label">Tip obroka</label>
          <input id="favorite-meal-label" name="mealLabel" list="recipe-meal-options" placeholder="npr. 1. Dorucak" value="${state.favoriteDraft.mealLabel}" required />
          <datalist id="recipe-meal-options">
            ${meals.map((meal) => `<option value="${meal}"></option>`).join("")}
          </datalist>
        </div>
        <div class="field">
          <label for="favorite-food-id">Namirnica</label>
          <select id="favorite-food-id" name="foodId" required>
            <option value="">Izaberi namirnicu</option>
            ${getFoods()
              .map((food) => `<option value="${food.id}" ${food.id === state.favoriteDraft.foodId ? "selected" : ""}>${food.name}</option>`)
              .join("")}
          </select>
        </div>
        <div class="field">
          <label for="favorite-grams">Gramaza</label>
          <input id="favorite-grams" name="grams" type="number" min="1" step="1" placeholder="100" value="${state.favoriteDraft.grams}" required />
        </div>
        <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap;">
          <button class="solid-button secondary-button" type="submit">${state.editingFavoriteItem.itemId ? "Sacuvaj izmenu" : "Dodaj stavku u obrok"}</button>
          ${state.editingFavoriteItem.itemId ? `<button class="ghost-button" type="button" data-action="cancel-edit-favorite-item">Odustani</button>` : ""}
        </div>
      </form>
      <div class="footer-note">Kad kliknes Dodaj namirnicu u obrok, ta stavka ulazi u taj recept. Ako upises isti naziv obroka, dodajes novu namirnicu u isti obrok.</div>
      <article class="food-card suggestion-surface" style="margin-top:14px;">
        <div class="food-card-top">
          <h3>${draftPreview.favoriteName || "Obrok u izradi"}</h3>
          <span class="pill strong">${draftPreview.items.length} stavki</span>
        </div>
        <div class="pill-row">
          <span class="pill">${draftPreview.mealLabel || "Tip obroka nije jos izabran"}</span>
          <span class="pill note">${roundValue(draftPreview.totals.kcal, 0)} kcal</span>
          <span class="pill">P ${roundValue(draftPreview.totals.protein, 1)} g</span>
          <span class="pill">UH ${roundValue(draftPreview.totals.carbs, 1)} g</span>
          <span class="pill">M ${roundValue(draftPreview.totals.fat, 1)} g</span>
        </div>
        <div class="footer-note" style="margin-top:10px;">Sastav obroka koji pravis:</div>
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
                          <span class="pill ${item.isPending ? "strong" : ""}">${item.isPending ? "nova stavka" : "sacuvano"}</span>
                          <span class="pill note">${roundValue(item.totals.kcal, 0)} kcal</span>
                        </div>
                      </div>
                    `
                  )
                  .join("")
              : `<div class="empty">Dodaj prvu namirnicu i gramazu, pa ces ovde odmah videti sastavljen obrok.</div>`
          }
        </div>
        <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap; margin-top:14px;">
          <button
            class="solid-button"
            data-action="save-favorite-meal-draft"
            ${!draftPreview.favoriteName || !draftPreview.mealLabel || !draftPreview.items.length ? "disabled" : ""}
          >
            Sacuvaj obrok
          </button>
        </div>
      </article>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Sacuvani obroci</h2>
          <p>${favorites.length ? `Trenutno imas ${favorites.length} sacuvanih obroka.` : "Jos nema sacuvanih obroka."}</p>
        </div>
      </div>
      <div class="stack">
        ${
          favorites.length
            ? favorites
                .map(
                  (favorite) => `
                    <article class="food-card">
                      <div class="food-card-top">
                        <h3>${favorite.name}</h3>
                        <span class="pill strong">${favorite.items.length} namirnica</span>
                      </div>
                      <div class="pill-row">
                        <span class="pill">${favorite.mealLabel || favorite.name}</span>
                        <span class="pill note">${roundValue(favorite.totals.kcal, 0)} kcal</span>
                        <span class="pill">P ${roundValue(favorite.totals.protein, 1)} g</span>
                        <span class="pill">UH ${roundValue(favorite.totals.carbs, 1)} g</span>
                        <span class="pill">M ${roundValue(favorite.totals.fat, 1)} g</span>
                      </div>
                      <div class="footer-note" style="margin-top:10px;">Sastav obroka:</div>
                      <div class="stack" style="margin-top:12px;">
                        ${favorite.items
                          .map(
                            (item, index) => `
                              <div class="suggestion-row">
                                <div>
                                  <strong>${item.foodName}</strong>
                                  <div class="footer-note">${roundValue(item.grams, 0)} g</div>
                                </div>
                                <div class="entry-actions" style="gap:8px; justify-content:flex-start; flex-wrap:wrap;">
                                  <button class="ghost-button" data-action="edit-favorite-item" data-favorite-id="${favorite.id}" data-item-index="${index}">Izmeni</button>
                                  <button class="ghost-button" data-action="add-favorite-item-to-day" data-favorite-id="${favorite.id}" data-item-index="${index}">Ubaci samo ovu</button>
                                  <button class="danger-button" data-action="delete-favorite-item" data-favorite-id="${favorite.id}" data-item-index="${index}">Obrisi</button>
                                </div>
                              </div>
                            `
                          )
                          .join("")}
                      </div>
                      <div class="entry-actions" style="gap:8px; justify-content:flex-start; flex-wrap:wrap; margin-top:12px;">
                        <button class="solid-button secondary-button" data-action="add-favorite-meal" data-favorite-id="${favorite.id}">Ubaci u ${state.selectedWeekday}</button>
                        <button class="ghost-button" data-action="prefill-favorite-meal" data-favorite-id="${favorite.id}">Dodaj stavku</button>
                        <button class="danger-button" data-action="delete-favorite-meal" data-favorite-id="${favorite.id}">Obrisi obrok</button>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Napravi prvi omiljeni obrok ovde, pa ces ga posle dodavati u dane jednim tapom.</div>`
        }
      </div>
    </section>
  `;
}

function renderTrainingTab() {
  const templates = getTrainingForDay(state.selectedWeekday);
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
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Nedeljni plan treninga</h2>
          <p>Brz pregled cele nedelje, da odmah vidis gde si ubacio trening a gde je odmor.</p>
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
                  <span class="pill">${day.templates.reduce((count, template) => count + template.exercises.length, 0)} vezbi</span>
                  <span class="pill">${roundValue(day.trainingBurn, 0)} kcal</span>
                  <span class="pill">${day.progressCount} logova</span>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Trening za ${state.selectedWeekday}</h2>
          <p>Za pocetak mozes drzati sablon vezbi i kratke beleske po danu.</p>
        </div>
      </div>
      <article class="food-card suggestion-surface" style="margin-bottom:16px;">
        <div class="food-card-top">
          <h3>Apple Watch potrosnja</h3>
          <span class="pill strong">${roundValue(trainingBurn, 0)} kcal</span>
        </div>
        <div class="footer-note">Upisi koliko si potrosio na treningu tog dana da imas pregled neto kalorija u planu.</div>
        <form id="training-burn-form" class="form-grid split" style="margin-top:14px;">
          <div class="field">
            <label for="training-burn-kcal">Potroseno kcal</label>
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
          <button class="solid-button secondary-button" type="submit">Sacuvaj kcal</button>
        </form>
      </article>
      <div class="stack">
        ${
          templates.length
            ? templates
                .map(
                  (template) => `
                    <article class="training-card">
                      <div class="training-top">
                        <h3>${template.name}</h3>
                        <span class="pill strong">${template.exercises.length} vezbi</span>
                      </div>
                      <div class="training-list" style="margin-top:12px;">
                        ${template.exercises
                          .map(
                            (exercise) => `
                              <div class="food-card">
                                <div class="food-card-top">
                                  <strong>${exercise.name}</strong>
                                </div>
                                <div class="footer-note">${exercise.details}</div>
                              </div>
                            `
                          )
                          .join("")}
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Jos nema trening sablona za ${state.selectedWeekday}. Dodaj ga ispod.</div>`
        }
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Dodaj trening sablon</h2>
          <p>Jedan red je jedna vezba. Mozes odmah da biras i za koji dan u nedelji ga cuvas.</p>
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
          <label for="training-exercises">Vezbe</label>
          <textarea id="training-exercises" name="exercises" placeholder="Cucanj 4x8-10&#10;Rumunsko mrtvo 4x10&#10;Iskorak 3x12"></textarea>
        </div>
        <button class="solid-button" type="submit">Sacuvaj sablon</button>
      </form>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Progres po vezbi</h2>
          <p>Upisi kilazu za vezbu i prati kako napredujes kroz vreme.</p>
        </div>
      </div>
      <form id="training-progress-form" class="form-grid split">
        <div class="field">
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
          <label for="progress-weight">Kilaza</label>
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
        <button class="solid-button secondary-button" type="submit">Sacuvaj unos</button>
      </form>
      <div class="chart-grid" style="margin-top:14px;">
        ${
          progressGroups.length
            ? progressGroups.map((group) => renderExerciseProgressCard(group)).join("")
            : `<div class="empty">Dodaj prvi unos kilaze za neku vezbu pa ce se ovde pojaviti progres.</div>`
        }
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Poslednji unosi opterecenja</h2>
          <p>Brza istorija zadnjih kilaza po vezbama.</p>
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
                        <button class="danger-button" data-action="delete-training-progress" data-progress-id="${log.id}">Obrisi</button>
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
            : `<div class="empty">Jos nema sacuvanih unosa opterecenja.</div>`
        }
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Beleske</h2>
          <p>Kratak log ako hoces da zabelezis kako je prosao trening.</p>
        </div>
      </div>
      <form id="training-log-form" class="form-grid">
        <div class="field">
          <label for="training-note">Beleska</label>
          <textarea id="training-note" name="note" placeholder="Npr. cucanj lagan, povecati tezinu sledeci put"></textarea>
        </div>
        <button class="solid-button secondary-button" type="submit">Sacuvaj belesku</button>
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
                        <button class="danger-button" data-action="delete-training-log" data-log-id="${log.id}">Obrisi</button>
                      </div>
                      <div class="footer-note">${log.note}</div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Jos nema beleski za ovaj dan.</div>`
        }
      </div>
    </section>
  `;
}

function renderGoalsTab() {
  const weeklyOverview = getWeeklyOverview();
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
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Nalog i sync</h2>
          <p>Cloud sync je sada ukljucen za sve osim progress slika, koje ostaju lokalno dok ne dodamo Storage.</p>
        </div>
      </div>
      <div class="food-card">
        <div class="food-card-top">
          <strong>${state.authUser?.email || "Nema prijavljenog naloga"}</strong>
          ${state.authUser ? '<button class="danger-button" data-action="sign-out">Odjavi se</button>' : ""}
        </div>
        <div class="pill-row">
          <span class="pill strong">${state.syncStatus}</span>
          <span class="pill">Slike: lokalno</span>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Profil i ciljevi</h2>
          <p>Makroi mogu rucno ili iz tezine po istoj formuli kao u Excel-u.</p>
        </div>
      </div>
      <form id="goals-form" class="form-grid split">
        <div class="field">
          <label for="profile-name">Ime</label>
          <input id="profile-name" name="name" value="${store.profile.name || ""}" />
        </div>
        <div class="field">
          <label for="profile-age">Godine</label>
          <input id="profile-age" name="age" type="number" min="0" value="${store.profile.age || ""}" />
        </div>
        <div class="field">
          <label for="profile-weight">Tezina (kg)</label>
          <input id="profile-weight" name="weightKg" type="number" step="0.1" min="0" value="${store.profile.weightKg || ""}" />
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
          <button class="ghost-button" type="button" data-action="recalculate-goals">Popuni iz tezine</button>
          <button class="solid-button" type="submit">Sacuvaj ciljeve</button>
        </div>
      </form>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Nedeljni nivo</h2>
          <p>Zbir za svih 7 dana, da odmah vidis da li si u kalorijama i makroima na nivou cele nedelje.</p>
        </div>
      </div>
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
          <strong>Potroseno trening</strong>
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

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Pregled po danima</h2>
          <p>Svaki dan sa kalorijama i razlikom u odnosu na dnevni cilj.</p>
        </div>
      </div>
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

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Backup</h2>
          <p>JSON backup je i dalje dobar kao dodatna sigurnost, iako su glavni podaci sada i u cloud-u.</p>
        </div>
      </div>
      <div class="meta-row">
        <button class="solid-button secondary-button" data-action="export-data">Izvezi backup</button>
        <label class="ghost-button" for="import-json">Uvezi backup</label>
        <input id="import-json" type="file" accept="application/json" hidden />
      </div>
      <div class="footer-note">Ako uvezes backup dok si prijavljen, izmene ce se upisati i u Firebase.</div>
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
            : "Jos nema unosa"
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
          <h2>Tezina i mere</h2>
          <p>Brz unos merenja, da sa telefona pratis kako napredujes kroz vreme.</p>
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
          <p>Kratak vizuelni pregled kako idu tezina i stomak kroz vreme.</p>
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
          <p>Ne moras popuniti sve, upisi samo ono sto si izmerio tog dana.</p>
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
        <button class="solid-button" type="submit">Sacuvaj unos</button>
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
          <div class="footer-note">Slika se automatski smanjuje i cuva lokalno.</div>
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
                          <button class="danger-button" data-action="delete-photo" data-photo-id="${photo.id}">Obrisi</button>
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
            : `<div class="empty">Jos nema progress slika. Ubaci prvu da imas vizuelni trag napretka.</div>`
        }
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Istorija unosa</h2>
          <p>${history.length ? "Najnoviji unos je prvi." : "Jos nema sacuvanih merenja."}</p>
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
                          Obrisi
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
            : `<div class="empty">Dodaj prvo merenje pa ce ovde ostati istorija.</div>`
        }
      </div>
    </section>
  `;
}

function render() {
  if (!state.authReady) {
    document.body.classList.remove("plan-compact");
    document.querySelector("#app").innerHTML = renderLoadingShell();
    return;
  }

  if (!state.authUser) {
    document.body.classList.remove("plan-compact");
    document.querySelector("#app").innerHTML = renderAuthShell();
    return;
  }

  const entries = getPlanEntriesForDay(state.selectedWeekday);
  const totals = getDayTotals(entries);
  const heroMarkup = state.activeTab === "plan" ? renderHero(entries, totals) : "";
  const sections = {
    plan: renderPlanTab(entries),
    recipes: renderRecipesTab(),
    foods: renderFoodsTab(),
    training: renderTrainingTab(),
    progress: renderProgressTab(),
    goals: renderGoalsTab(),
  };

  document.querySelector("#app").innerHTML = `
    <main class="shell">
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
            <button class="solid-button secondary-button" data-action="undo-delete-entry">Vrati</button>
          </div>
        `
        : ""
    }

    <nav class="bottom-nav" aria-label="Glavna navigacija">
      <div class="bottom-nav-inner" style="--nav-count:${TABS.length};">
        ${TABS.map(
          (tab) => `
            <button class="nav-button ${tab.id === state.activeTab ? "is-active" : ""}" data-action="switch-tab" data-tab="${tab.id}">
              <span class="icon">${tab.icon}</span>
              <span>${tab.label}</span>
            </button>
          `
        ).join("")}
      </div>
    </nav>
  `;

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
      <p>Izaberi namirnicu i gramazu da odmah vidis makroe.</p>
    `;
    return;
  }

  const totals = calculateEntry(food, grams);
  preview.innerHTML = `
    <h3>${food.name} za ${roundValue(grams, 0)} g</h3>
    <p>${roundValue(totals.kcal, 0)} kcal, P ${totals.protein} g, UH ${totals.carbs} g, M ${totals.fat} g</p>
  `;
}

function handleDocumentClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  const action = actionTarget.dataset.action;

  if (action === "switch-tab") {
    state.activeTab = actionTarget.dataset.tab;
    state.editingMealLabel = "";
    window.location.hash = state.activeTab;
    render();
    return;
  }

  if (action === "select-weekday") {
    state.selectedWeekday = actionTarget.dataset.weekday;
    state.editingMealLabel = "";
    resetPlanDraft();
    render();
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

  if (action === "start-add-to-meal") {
    const mealLabel = String(actionTarget.dataset.mealLabel || "").trim();
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
    if (!entry) {
      return;
    }
    setPlanDraftFromEntry(entry);
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
      mealLabel: state.planDraft.mealLabel || defaultMeals[0],
      foodId: food.id,
      foodName: food.name,
      grams,
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
          mealLabel: meal.mealLabel,
          foodId: item.food.id,
          foodName: item.food.name,
          grams: item.grams,
        });
      });
    });
    persist();
    render();
    return;
  }

  if (action === "save-meal-as-favorite") {
    const mealLabel = actionTarget.dataset.mealLabel;
    const mealEntries = getPlanEntriesForDay(state.selectedWeekday)
      .filter((entry) => entry.mealLabel === mealLabel)
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
    const favoriteName = window.prompt("Naziv omiljenog obroka:", suggestedName);
    if (!favoriteName || !favoriteName.trim()) {
      return;
    }

    const normalizedName = favoriteName.trim();
    const existingFavorite = store.favoriteMeals.find(
      (favorite) => favorite.name.toLowerCase() === normalizedName.toLowerCase()
    );

    if (existingFavorite) {
      existingFavorite.name = normalizedName;
      existingFavorite.items = mealEntries;
      existingFavorite.updatedAt = new Date().toISOString();
    } else {
      store.favoriteMeals.unshift({
        id: uid("favorite-meal"),
        name: normalizedName,
        mealLabel,
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
    state.favoriteDraft.favoriteName = favorite.name || "";
    state.favoriteDraft.mealLabel = favorite.mealLabel || "";
    state.favoriteDraft.foodId = "";
    state.favoriteDraft.grams = "";
    state.editingFavoriteItem = { favoriteId: "", itemId: "", itemIndex: -1 };
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#favorite-food-id")?.focus();
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
    const existingFavorite = store.favoriteMeals.find(
      (favorite) => favorite.name.toLowerCase() === draftPreview.favoriteName.toLowerCase()
    );

    if (!draftPreview.favoriteName || !draftPreview.mealLabel) {
      window.alert("Upisi naziv i tip obroka pre cuvanja.");
      return;
    }

    if (hasPendingItem) {
      const saved = saveFavoriteMealItem(
        state.favoriteDraft.favoriteName,
        state.favoriteDraft.mealLabel,
        state.favoriteDraft.foodId,
        state.favoriteDraft.grams
      );
      if (!saved) {
        return;
      }
    } else if (!draftPreview.items.length || (!existingFavorite && !state.editingFavoriteItem.favoriteId)) {
      window.alert("Dodaj bar jednu namirnicu pre cuvanja obroka.");
      return;
    }

    persist();
    const savedName = draftPreview.favoriteName;
    resetFavoriteDraft();
    render();
    window.alert(`Obrok "${savedName}" je sacuvan u Obroci.`);
    return;
  }

  if (action === "add-favorite-meal") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    if (!favorite) {
      return;
    }

    favorite.items.forEach((item) => {
      store.weeklyPlanEntries.push({
        id: uid("plan"),
        weekday: state.selectedWeekday,
        mealLabel: favorite.mealLabel || favorite.name,
        foodId: item.foodId,
        foodName: item.foodName,
        grams: item.grams,
      });
    });

    persist();
    render();
    return;
  }

  if (action === "add-favorite-item-to-day") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    const itemIndex = Number(actionTarget.dataset.itemIndex);
    const item = favorite?.items?.[itemIndex];
    if (!favorite || !item) {
      return;
    }

    store.weeklyPlanEntries.push({
      id: uid("plan"),
      weekday: state.selectedWeekday,
      mealLabel: favorite.mealLabel || favorite.name,
      foodId: item.foodId,
      foodName: item.foodName,
      grams: item.grams,
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

    const confirmed = window.confirm(`Obrisi "${item.foodName}" iz omiljenog obroka "${favorite.name}"?`);
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
    const confirmed = window.confirm(
      entry
        ? `Obrisi stavku "${entry.foodName}" (${roundValue(entry.grams, 0)} g) iz ${entry.mealLabel}?`
        : "Obrisi ovu stavku iz plana?"
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
    const weightInput = document.querySelector("#profile-weight");
    const weightKg = toNumber(weightInput?.value || store.profile.weightKg);
    document.querySelector("#goal-protein").value = roundValue(weightKg * 2.5, 1);
    document.querySelector("#goal-carbs").value = roundValue(weightKg * 1.2, 1);
    document.querySelector("#goal-fat").value = roundValue(weightKg * 0.8, 1);
    document.querySelector("#goal-calories").value = roundValue(weightKg * 2.5 * 4 + weightKg * 1.2 * 4 + weightKg * 0.8 * 9, 0);
    return;
  }

  if (action === "export-data") {
    exportData();
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
    actionTarget.textContent = nextVisible ? "Sakrij" : "Prikazi";
    actionTarget.setAttribute("aria-pressed", String(nextVisible));
    return;
  }

  if (action === "sign-out") {
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
    const mealLabel = String(formData.get("mealLabel") || "").trim();
    const foodId = String(formData.get("foodId") || "").trim();
    const grams = toNumber(formData.get("grams"));
    const food = getFoodById(foodId);

    if (!mealLabel || !food || !grams) {
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

    store.foods.push({
      id: uid("food"),
      name,
      category: String(formData.get("category") || "Ostalo").trim() || "Ostalo",
      servingBaseGrams: 100,
      kcal: toNumber(formData.get("kcal")),
      protein: toNumber(formData.get("protein")),
      carbs: toNumber(formData.get("carbs")),
      fat: toNumber(formData.get("fat")),
    });
    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "favorite-meal-form") {
    const favoriteName = String(formData.get("favoriteName") || "").trim();
    const mealLabel = String(formData.get("mealLabel") || "").trim();
    const foodId = String(formData.get("foodId") || "").trim();
    const grams = toNumber(formData.get("grams"));
    const saved = saveFavoriteMealItem(favoriteName, mealLabel, foodId, grams);

    if (!saved) {
      return;
    }

    persist();
    resetFavoriteDraft();
    event.target.reset();
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
    const burnKcal = Math.max(0, toNumber(formData.get("burnKcal")));
    store.trainingBurnByWeekday[state.selectedWeekday] = burnKcal;
    persist();
    render();
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
    store.profile.name = String(formData.get("name") || "").trim();
    store.profile.age = toNumber(formData.get("age"));
    store.profile.weightKg = toNumber(formData.get("weightKg"));
    store.goals.calories = toNumber(formData.get("calories"));
    store.goals.protein = toNumber(formData.get("protein"));
    store.goals.carbs = toNumber(formData.get("carbs"));
    store.goals.fat = toNumber(formData.get("fat"));
    persist();
    render();
  }
}

function handleInput(event) {
  const target = event.target;

  if (target instanceof HTMLInputElement && target.id === "food-search") {
    state.foodSearch = target.value;
    render();
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

function handleImport(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === "grams") {
    render();
    return;
  }

  if (!(target instanceof HTMLInputElement) || target.id !== "import-json" || !target.files?.[0]) {
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      replaceStore(parsed);
      persist();
      render();
    } catch (error) {
      window.alert("Backup nije validan JSON.");
    }
  };
  reader.readAsText(target.files[0]);
  target.value = "";
}

document.addEventListener("click", handleDocumentClick);
document.addEventListener("submit", handleSubmit);
document.addEventListener("input", handleInput);
document.addEventListener("change", handleImport);

window.addEventListener("hashchange", () => {
  const nextTab = getInitialTab();
  if (nextTab !== state.activeTab) {
    state.activeTab = nextTab;
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
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("SW registration failed", error);
    });
  });
}
