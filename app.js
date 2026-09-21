import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { collection, doc, getDoc, getDocs, getFirestore, limit, query, runTransaction, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const STORAGE_KEY = "fitness-tracker-state-v1";
// Local copies are kept PER ACCOUNT (`${STORAGE_KEY}:${uid}`) so one person's
// data never leaks into the next account that signs in on the same device — the
// public demo → "register my own account" flow used to inherit the demo's
// measurements, logs and photos. The bare key above is the pre-account blob; it
// is only read to migrate a device's single copy into the account that owned it.
const LAST_UID_KEY = "fitness-tracker-last-uid";
// Per-account sync bookkeeping: { rev, dirty }. `rev` is the cloud rev this
// device last loaded/wrote; `dirty` means local edits exist that never reached
// the cloud (offline, backgrounded before the debounce fired, write failed).
const SYNC_META_KEY_PREFIX = "fitness-tracker-sync-v1";

// localStorage can throw (Safari "block all cookies", sandboxed webviews, quota)
// — never let that take the whole app down at module evaluation.
function safeLocalGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}
function safeLocalSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}
function safeLocalRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    // ignore
  }
}

let activeStorageUid = safeLocalGet(LAST_UID_KEY) || null;
function getStoreStorageKey(uid = activeStorageUid) {
  return uid ? `${STORAGE_KEY}:${uid}` : STORAGE_KEY;
}
function readSyncMeta(uid) {
  if (!uid) {
    return {};
  }
  try {
    const parsed = JSON.parse(safeLocalGet(`${SYNC_META_KEY_PREFIX}:${uid}`) || "null");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}
function writeSyncMeta(uid, patch) {
  if (!uid) {
    return;
  }
  safeLocalSet(`${SYNC_META_KEY_PREFIX}:${uid}`, JSON.stringify({ ...readSyncMeta(uid), ...patch }));
}
// Progress-photo blobs (base64 JPEGs) live in IndexedDB, not in the localStorage
// state blob — base64 photos quickly blow the ~5MB localStorage quota, which used
// to break ALL saves (plan, foods, measurements) once a user had ~15+ photos.
// IndexedDB has no such practical limit. `photoIdsInIdb` tracks which photo ids
// are confirmed safely stored in IDB; only those have their heavy previewUrl
// stripped from the localStorage snapshot, so a photo's blob is always in
// localStorage OR IndexedDB (or both mid-migration), never lost. If IndexedDB is
// unavailable (e.g. Safari private mode) the set stays empty and we fall back to
// the legacy behavior of keeping blobs in localStorage.
const PHOTO_DB_NAME = "fit-tracker-photos";
const PHOTO_DB_STORE = "photos";
// Recipe photos (base64 JPEGs on favoriteMeals[].imageUrl) share the same
// IndexedDB store under a prefixed id. They used to ride along inside the cloud
// doc: 2-4 phone photos pushed it past Firestore's 1 MiB document limit, every
// save then failed silently, and the next launch's hydrate rolled the account
// back to the last good cloud copy. Like progress photos they now stay on the
// device (stitched back in by reconcilePhotos) and never enter the cloud doc.
const RECIPE_IMAGE_KEY_PREFIX = "recipe-image:";
function getRecipeImageKey(favoriteId) {
  return `${RECIPE_IMAGE_KEY_PREFIX}${favoriteId}`;
}
function isInlineImageData(url) {
  return typeof url === "string" && url.startsWith("data:");
}
const photoIdsInIdb = new Set();
let photoDbPromise = null;

function openPhotoDb() {
  if (photoDbPromise) {
    return photoDbPromise;
  }
  photoDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(PHOTO_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PHOTO_DB_STORE)) {
        db.createObjectStore(PHOTO_DB_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  }).catch((error) => {
    photoDbPromise = null;
    throw error;
  });
  return photoDbPromise;
}

// Returns a Map<id, previewUrl> of every stored photo blob, or null if IndexedDB
// is unavailable (so callers can fall back to legacy localStorage behavior).
async function idbAllPhotos() {
  try {
    const db = await openPhotoDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_DB_STORE, "readonly");
      const request = tx.objectStore(PHOTO_DB_STORE).getAll();
      request.onsuccess = () => {
        const map = new Map();
        (request.result || []).forEach((row) => {
          if (row && row.id && row.previewUrl) {
            map.set(row.id, row.previewUrl);
          }
        });
        resolve(map);
      };
      request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
    });
  } catch (error) {
    console.error("Photo IndexedDB read failed", error);
    return null;
  }
}

// Persists one or more {id, previewUrl} blobs. Resolves true on success. On
// success the ids are recorded in photoIdsInIdb so persistLocal can drop their
// base64 from the localStorage snapshot.
async function idbPutPhotos(records) {
  const rows = (records || []).filter((row) => row && row.id && row.previewUrl);
  if (!rows.length) {
    return true;
  }
  try {
    const db = await openPhotoDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_DB_STORE, "readwrite");
      const objectStore = tx.objectStore(PHOTO_DB_STORE);
      rows.forEach((row) => objectStore.put({ id: row.id, previewUrl: row.previewUrl }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted"));
    });
    rows.forEach((row) => photoIdsInIdb.add(row.id));
    return true;
  } catch (error) {
    console.error("Photo IndexedDB write failed", error);
    return false;
  }
}

async function idbDeletePhoto(id) {
  if (!id) {
    return;
  }
  try {
    const db = await openPhotoDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_DB_STORE, "readwrite");
      tx.objectStore(PHOTO_DB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB delete failed"));
    });
  } catch (error) {
    console.error("Photo IndexedDB delete failed", error);
  } finally {
    photoIdsInIdb.delete(id);
  }
}

const CLOUD_SCHEMA_VERSION = 1;
const DEMO_RECIPE_SEED_VERSION = 1;
// "Vrati na fabrička" dugme se prikazuje SAMO za ovaj nalog. Napravi Firebase
// Email/Password korisnika sa tačno ovim emailom da bude javni demo nalog.
const DEMO_EMAIL = "demo@fittracker.app";
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
// Arbitrary but stable-forever anchor Monday used only to derive an
// alternating 0/1 week track for the meal plan's Week A / Week B cycle.
// 2024-01-01 is a Monday. Declared here (not near getCurrentWeekTrack below)
// because `state`'s initializer calls getCurrentWeekTrack() at module-load
// time, before that later part of the file would otherwise have run.
const WEEK_TRACK_EPOCH_MONDAY_UTC = Date.UTC(2024, 0, 1);

// Fixed 14-slot chronological cycle: track 0's 7 weekdays (WEEKDAYS order), then
// track 1's 7 weekdays (WEEKDAYS order), then repeats. This ordering always
// matches real chronological progression regardless of which track happens to
// be "currently active" right now — used for meal-prep's cross-track wraparound.
const WEEK_TRACK_CYCLE = [0, 1].flatMap((weekTrack) => WEEKDAYS.map((weekday) => ({ weekday, weekTrack })));
// "Cetvrtak" stays the stored key (existing data is keyed by it); only the
// displayed label gets its diacritic. Other days need none.
function weekdayLabel(weekday) {
  return weekday === "Cetvrtak" ? "Četvrtak" : weekday;
}
// Accusative, lowercase — for "za <dan>" phrases ("Obroci za sredu", not "za Sreda").
const WEEKDAY_ACCUSATIVE = {
  Ponedeljak: "ponedeljak",
  Utorak: "utorak",
  Sreda: "sredu",
  Cetvrtak: "četvrtak",
  Petak: "petak",
  Subota: "subotu",
  Nedelja: "nedelju",
};
function weekdayAccusative(weekday) {
  return WEEKDAY_ACCUSATIVE[weekday] || weekdayLabel(weekday).toLowerCase();
}
const TABS = [
  { id: "plan", label: "Danas", icon: "🍽" },
  { id: "recipes", label: "Recepti", icon: "🥣" },
  { id: "foods", label: "Namirnice", icon: "🥚" },
  { id: "training", label: "Trening", icon: "🏋️" },
  { id: "running", label: "Trčanje", icon: "🏃" },
  { id: "routine", label: "Rutina", icon: "✅" },
  { id: "progress", label: "Napredak", icon: "📏" },
  { id: "goals", label: "Ciljevi", icon: "🎯" },
];
// Routable but hidden from the main nav: Nutricionista (rarely used; reachable
// from a link in Namirnice). Settings is folded into the Ciljevi tab.
const HIDDEN_ROUTES = ["nutrition"];
// Includes the hidden routes so the header title/icon + hash routing still
// resolve when one is opened, even though they're not in the nav menu.
const ALL_TABS = [...TABS, { id: "nutrition", label: "Nutricionista", icon: "🗂" }];
const TAB_META = {
  plan: { eyebrow: "Dnevni plan", description: "Pregled obroka, kalorija i dnevnog ritma za izabrani dan." },
  recipes: { eyebrow: "Biblioteka", description: "Sastavljaj obroke, čuvaj favorite i ubacuj ih u plan bez duplog unosa." },
  nutrition: { eyebrow: "Dokumenti", description: "Pregled uvezenih planova, preporuka i recepata sa mestom za sređivanje svega što parser pronađe." },
  foods: { eyebrow: "Baza", description: "Pretraži namirnice, proveri makroe i dopuni bazu novim unosima." },
  training: { eyebrow: "Performans", description: "Plan treninga, potrošnja i progres po vežbama na jednom mestu." },
  running: { eyebrow: "Kardio", description: "Beleži trčanja — distancu, vreme, tempo i puls, sa pregledom forme kroz vreme." },
  routine: { eyebrow: "Svakodnevica", description: "Navike, taskovi i nedeljni pregled koji pomažu da plan ostane realan." },
  progress: { eyebrow: "Praćenje", description: "Merenja, trendovi i progress slike za jasan pregled napretka kroz vreme." },
  goals: { eyebrow: "Metabolizam", description: "Profil, kalorijski cilj, makroi i nedeljni pregled u odnosu na plan." },
  settings: { eyebrow: "Sigurnost", description: "Nalog, cloud sync i backup opcije za mirniji rad sa podacima." },
};

// Lucide-style line icons (ISC) so navigation renders identically across devices
// instead of relying on platform emoji fonts.
const TAB_ICON_PATHS = {
  plan: '<path d="M3 2v7c0 1.1.9 2 2 2h2a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  recipes: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  nutrition: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  foods: '<path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z"/><path d="M10 2c1 .5 2 2 2 5"/>',
  training: '<path d="M14.4 14.4 9.6 9.6"/><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/>',
  running: '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>',
  routine: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  progress: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  goals: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};

function renderTabIcon(id) {
  const paths = TAB_ICON_PATHS[id];
  if (!paths) return "";
  return `<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

// Primary destinations for the iOS-style bottom tab bar (phones).
// Everything else lives behind "Više", which opens the full sidebar.
// Navigation is six groups over the eight routes: Hrana = Namirnice | Recepti,
// Trening = Trening | Trčanje (switched with a segmented control inside the
// group). Tab ids stay the routes (#foods, #recipes...), so links keep working.
const NAV_GROUPS = [
  { id: "plan", label: "Danas", icon: "plan", tabs: ["plan"] },
  { id: "food", label: "Hrana", icon: "foods", tabs: ["foods", "recipes", "nutrition"], navTabs: [["foods", "Namirnice"], ["recipes", "Recepti"]] },
  { id: "training", label: "Trening", icon: "training", tabs: ["training", "running"], navTabs: [["training", "Trening"], ["running", "Trčanje"]] },
  { id: "progress", label: "Napredak", icon: "progress", tabs: ["progress"] },
  { id: "routine", label: "Rutina", icon: "routine", tabs: ["routine"] },
  { id: "goals", label: "Ciljevi", icon: "goals", tabs: ["goals"] },
];
const PRIMARY_GROUPS = ["plan", "food", "training", "routine"];

function getNavGroupForTab(tabId) {
  return NAV_GROUPS.find((group) => group.tabs.includes(tabId)) || NAV_GROUPS[0];
}

// Tapping a group reopens the sub-tab you last used in it.
function getGroupTargetTab(group) {
  const remembered = state.lastTabInGroup && state.lastTabInGroup[group.id];
  return group.tabs.includes(remembered) ? remembered : group.tabs[0];
}

function renderGroupSegNav() {
  const group = getNavGroupForTab(state.activeTab);
  if (!group.navTabs) {
    return "";
  }
  return `<div class="seg-nav group-seg-nav" role="tablist" aria-label="${group.label}">${group.navTabs
    .map(
      ([id, label]) =>
        `<button type="button" class="seg-nav-btn ${id === state.activeTab ? "is-active" : ""}" role="tab" aria-selected="${id === state.activeTab}" data-action="switch-tab" data-tab="${id}">${label}</button>`
    )
    .join("")}</div>`;
}

function renderTabBar() {
  const activeGroup = getNavGroupForTab(state.activeTab);
  const items = PRIMARY_GROUPS.map((groupId) => {
    const group = NAV_GROUPS.find((entry) => entry.id === groupId);
    if (!group) return "";
    const isActive = activeGroup.id === group.id;
    return `
      <button class="tab-bar-item ${isActive ? "is-active" : ""}" type="button" data-action="switch-tab" data-tab="${getGroupTargetTab(group)}" aria-label="${group.label}" aria-current="${isActive ? "page" : "false"}">
        <span class="tab-bar-icon">${renderTabIcon(group.icon)}</span>
        <span class="tab-bar-label">${group.label}</span>
      </button>
    `;
  }).join("");

  const isMoreActive = !PRIMARY_GROUPS.includes(activeGroup.id);
  return `
    <nav class="tab-bar" aria-label="Glavna navigacija">
      <div class="tab-bar-inner">
        ${items}
        <button class="tab-bar-item tab-bar-more ${isMoreActive ? "is-active" : ""} ${state.navMenuOpen ? "is-open" : ""}" type="button" data-action="toggle-nav-menu" aria-label="Više" aria-expanded="${state.navMenuOpen}" aria-controls="app-menu">
          <span class="tab-bar-icon"><svg class="tab-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></span>
          <span class="tab-bar-label">Više</span>
        </button>
      </div>
    </nav>
  `;
}

// Compact "Više" popover for mobile — the few secondary destinations + quick
// toggles, popping up above the tab bar instead of a full-screen slide-out.
function renderMoreSheet() {
  const activeGroup = getNavGroupForTab(state.activeTab);
  const moreTabs = NAV_GROUPS.filter((group) => !PRIMARY_GROUPS.includes(group.id)).map((group) => ({
    id: getGroupTargetTab(group),
    label: group.label,
    icon: group.icon,
    isActive: activeGroup.id === group.id,
  }));
  const userEmail = String(state.authUser?.email || "").trim();
  const isDemo = isDemoAccount();
  const profileName = String(store.profile?.name || "").trim();
  const displayName = isDemo ? "Demo nalog" : profileName || (userEmail ? userEmail.split("@")[0] : "Nalog");
  const userInitial = (displayName || userEmail || "?").charAt(0).toUpperCase() || "?";
  return `
    <div class="more-sheet ${state.navMenuOpen ? "is-open" : ""}" role="menu" aria-label="Više">
      ${
        userEmail || profileName
          ? `<button class="more-sheet-user" type="button" data-action="open-account" aria-label="Nalog i profil">
              <span class="more-sheet-user-avatar" aria-hidden="true">${escapeHtml(userInitial)}</span>
              <div class="more-sheet-user-info">
                <span class="more-sheet-user-name">${escapeHtml(displayName)}${isDemo ? `<span class="more-sheet-user-badge">DEMO</span>` : ""}</span>
                ${userEmail ? `<span class="more-sheet-user-email">${escapeHtml(userEmail)}</span>` : ""}
              </div>
              <span class="more-sheet-user-chevron" aria-hidden="true">${renderSideChevronIcon(false)}</span>
            </button>`
          : ""
      }
      <div class="more-sheet-tabs">
        ${moreTabs
          .map(
            (tab) => `
              <button class="more-sheet-item ${tab.isActive ? "is-active" : ""}" type="button" data-action="switch-tab" data-tab="${tab.id}" role="menuitem">
                <span class="more-sheet-icon">${renderTabIcon(tab.icon)}</span>
                <span class="more-sheet-label">${tab.label}</span>
                ${tab.isActive ? `<span class="more-sheet-dot" aria-hidden="true"></span>` : ""}
              </button>
            `
          )
          .join("")}
      </div>
      <div class="more-sheet-footer">
        <button class="ghost-button theme-toggle button-with-icon" type="button" data-action="toggle-theme" aria-label="Promeni temu">
          <span class="theme-toggle-face to-dark">
            <svg class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
            <span class="button-label">Tamna tema</span>
          </span>
          <span class="theme-toggle-face to-light">
            <svg class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
            <span class="button-label">Svetla tema</span>
          </span>
        </button>
      </div>
    </div>
  `;
}

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
// Weekly rate (kg/week) per pace level → exact daily kcal deficit/surplus.
const PACE_LEVELS = [
  { id: "blago", label: "Blago", loseKgPerWeek: 0.25, gainKgPerWeek: 0.125 },
  { id: "umereno", label: "Umereno", loseKgPerWeek: 0.5, gainKgPerWeek: 0.25 },
  { id: "agresivno", label: "Agresivno", loseKgPerWeek: 0.75, gainKgPerWeek: 0.5 },
];
const KCAL_PER_KG = 7700;

const SUPPLEMENT_TIMINGS = [
  { id: "morning", label: "Ujutru" },
  { id: "breakfast", label: "Uz doručak" },
  { id: "lunch", label: "Uz ručak" },
  { id: "postworkout", label: "Posle treninga" },
  { id: "evening", label: "Uveče" },
];

// Vrste trčanja — koriste se u formi za unos i kao oznaka (pill) na kartici.
const RUN_TYPES = [
  { id: "lagano", label: "Lagano" },
  { id: "tempo", label: "Tempo" },
  { id: "intervali", label: "Intervali" },
  { id: "dugo", label: "Dugačko" },
  { id: "trka", label: "Trka" },
];

const defaultMeals = [
  "1. Doručak",
  "2. Prva užina",
  "3. Ručak",
  "4. Druga užina",
  "5. Večera",
];

// Kafa se beleži kao broj popijenih šoljica po danu (kao voda i koraci), samo
// što šoljica nosi i kalorije, pa ulazi u dnevni zbir.
//
// Jedan broj — kcal po šoljici — a ne veza sa namirnicom iz baze. Prva verzija
// je bila vezana: šoljica = 200 ml namirnice „Turska kafa“, što je davalo
// 76 kcal. Aritmetika je bila tačna (38 kcal/100 ml × 2), ali ta namirnica nosi
// 9,5 g šećera na 100 ml — to je kafa zaslađena sa 4-5 kašičica, ne obična.
// Crna kafa je ~10 kcal na šoljicu od 200 ml i nema makroa vrednih računanja,
// pa je veza sa bazom nosila celu komplikaciju (koja kafa, ml ili komad,
// namirnica obrisana iz baze) a nije davala ništa. Ko pije kafu sa šećerom ili
// mlekom upiše svoj broj i tu je kraj priče.
const COFFEE_KCAL_DEFAULT = 10;

// Merenje je namerno usko: datum + težina su srž, obimi su opcioni dodatak koji
// u formi stoji sklopljen. "Trening" je izbačen — bio je slobodan tekst koji
// ništa u aplikaciji nije čitalo osim jedne pilule u istoriji, a trening ionako
// ima svoj log. Kalorije se više ne kucaju: cilj koji je važio na dan merenja se
// zamrzne na unos pri čuvanju (getCalorieGoalForDate), pa kasnija promena cilja
// ne prepravlja istoriju unazad.
const measurementFields = [
  { id: "weightKg", label: "Težina", type: "number", step: "0.1", unit: "kg" },
  { id: "thighCm", label: "Butine", type: "number", step: "0.1", unit: "cm" },
  { id: "upperWaistCm", label: "Stomak gornji", type: "number", step: "0.1", unit: "cm" },
  { id: "lowerWaistCm", label: "Stomak donji", type: "number", step: "0.1", unit: "cm" },
  { id: "chestCm", label: "Grudi", type: "number", step: "0.1", unit: "cm" },
  { id: "armCm", label: "Ruke", type: "number", step: "0.1", unit: "cm" },
];

// Težina je jedino obavezno polje; sve ostalo ide pod „Dodatne mere“.
const optionalMeasurementFieldIds = measurementFields
  .filter((field) => field.id !== "weightKg")
  .map((field) => field.id);

const PHOTO_TAGS = ["front", "side", "back"];
const PHOTO_TAG_LABELS = { front: "Front", side: "Bok", back: "Leđa" };

// Common blood-work markers with orientational reference ranges + units. Ranges
// vary by lab, sex and age, so these are guidance only (not medical advice) and
// the user can track any custom marker too (no range -> no status, just trend).
const LAB_MARKERS = [
  { name: "Holesterol ukupni", unit: "mmol/L", low: null, high: 5.2 },
  { name: "LDL holesterol", unit: "mmol/L", low: null, high: 3.0 },
  { name: "HDL holesterol", unit: "mmol/L", low: 1.0, high: null },
  { name: "Trigliceridi", unit: "mmol/L", low: null, high: 1.7 },
  { name: "Glukoza", unit: "mmol/L", low: 3.9, high: 6.1 },
  { name: "HbA1c", unit: "%", low: null, high: 5.7 },
  { name: "Gvožđe", unit: "µmol/L", low: 11, high: 28 },
  { name: "Feritin", unit: "µg/L", low: 30, high: 300 },
  { name: "Vitamin D", unit: "ng/mL", low: 30, high: 100 },
  { name: "Vitamin B12", unit: "pg/mL", low: 200, high: 900 },
  { name: "TSH", unit: "mIU/L", low: 0.4, high: 4.0 },
  { name: "Hemoglobin", unit: "g/L", low: 120, high: 170 },
  { name: "Leukociti", unit: "10⁹/L", low: 4, high: 10 },
  { name: "CRP", unit: "mg/L", low: null, high: 5 },
  { name: "Kreatinin", unit: "µmol/L", low: 60, high: 110 },
  { name: "ALT", unit: "U/L", low: null, high: 40 },
  { name: "AST", unit: "U/L", low: null, high: 40 },
  { name: "Mokraćna kiselina", unit: "µmol/L", low: 200, high: 420 },
];
// Body-composition analysis (InBody / Sonka style). `dir` marks the healthy
// direction of change so a delta can be colored: "down" = lower is better,
// "up" = higher is better, "neutral" = depends on the goal (no judgment).
// `dec` = decimals used for display + input step.
const BODY_METRIC_GROUPS = [
  {
    group: "Osnovno",
    metrics: [
      { key: "weight", label: "Težina", unit: "kg", dir: "neutral", dec: 1 },
      { key: "bmi", label: "BMI", unit: "", dir: "neutral", dec: 1 },
      { key: "fatPct", label: "Procenat masti", unit: "%", dir: "down", dec: 1 },
      { key: "score", label: "Ukupna ocena", unit: "/100", dir: "up", dec: 1 },
    ],
  },
  {
    group: "Mišić i mast",
    metrics: [
      { key: "skeletalMuscle", label: "Skeletna mišićna masa", unit: "kg", dir: "up", dec: 1 },
      { key: "muscleMass", label: "Mišićna masa (ukupno)", unit: "kg", dir: "up", dec: 1 },
      { key: "fatMass", label: "Masna masa", unit: "kg", dir: "down", dec: 1 },
    ],
  },
  {
    group: "Telesne tečnosti",
    metrics: [
      { key: "bodyWater", label: "Telesna voda", unit: "kg", dir: "up", dec: 1 },
      { key: "icf", label: "Intraćelijska tečnost", unit: "L", dir: "neutral", dec: 1 },
      { key: "ecf", label: "Vanćelijska tečnost", unit: "L", dir: "neutral", dec: 1 },
      { key: "protein", label: "Proteini", unit: "kg", dir: "up", dec: 1 },
      { key: "minerals", label: "Minerali", unit: "kg", dir: "neutral", dec: 1 },
    ],
  },
  {
    group: "Mast — detaljno",
    metrics: [
      { key: "visceralGrade", label: "Visceralna mast (nivo)", unit: "", dir: "down", dec: 0 },
      { key: "visceralArea", label: "Površina visceralne masti", unit: "cm²", dir: "down", dec: 1 },
      { key: "subcutaneousArea", label: "Površina potkožne masti", unit: "cm²", dir: "down", dec: 1 },
      { key: "whr", label: "Odnos struk–kuk (WHR)", unit: "", dir: "down", dec: 2 },
    ],
  },
  {
    group: "Metabolizam",
    metrics: [
      { key: "bmr", label: "Bazalni metabolizam (BMR)", unit: "kcal", dir: "neutral", dec: 0 },
    ],
  },
  {
    group: "Segmenti — mišić",
    metrics: [
      { key: "armRMuscle", label: "Desna ruka — mišić", unit: "kg", dir: "up", dec: 1 },
      { key: "armLMuscle", label: "Leva ruka — mišić", unit: "kg", dir: "up", dec: 1 },
      { key: "torsoMuscle", label: "Trup — mišić", unit: "kg", dir: "up", dec: 1 },
      { key: "legRMuscle", label: "Desna noga — mišić", unit: "kg", dir: "up", dec: 1 },
      { key: "legLMuscle", label: "Leva noga — mišić", unit: "kg", dir: "up", dec: 1 },
    ],
  },
  {
    group: "Segmenti — mast",
    metrics: [
      { key: "armRFat", label: "Desna ruka — mast", unit: "kg", dir: "down", dec: 1 },
      { key: "armLFat", label: "Leva ruka — mast", unit: "kg", dir: "down", dec: 1 },
      { key: "torsoFat", label: "Trup — mast", unit: "kg", dir: "down", dec: 1 },
      { key: "legRFat", label: "Desna noga — mast", unit: "kg", dir: "down", dec: 1 },
      { key: "legLFat", label: "Leva noga — mast", unit: "kg", dir: "down", dec: 1 },
    ],
  },
];
const BODY_METRICS = BODY_METRIC_GROUPS.flatMap((g) => g.metrics);
const FOOD_MACRO_FILTERS = ["Sve", "Proteini", "UH", "Masti", "Ostalo"];
const NUTRITION_PROFILE_FILTERS = [
  { id: "Sve", label: "Sve" },
  { id: "Visok protein", label: "Više proteina" },
  { id: "Malo UH", label: "Malo UH" },
  { id: "Malo masti", label: "Malo masti" },
  { id: "Malo proteina", label: "Malo proteina" },
  { id: "Manje kcal", label: "Manje kcal" },
];
const RECIPE_NUTRITION_FILTERS = [
  { id: "Sve", label: "Sve" },
  { id: "Obrok do 500 kcal", label: "Obrok do 500 kcal" },
];
const IMPORT_AMOUNT_PATTERN =
  "(?:\\d+(?:[.,]\\d+)?\\s*-\\s*\\d+(?:[.,]\\d+)?|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?|[¼½¾])";
const IMPORT_UNIT_PATTERN =
  "kg|g|gr|grama?|ml|l|dl|litr[aeu]?|kom(?:ada)?|ka[sš]ik(?:a|e|om|u)|ka[sš]i?[čc]ic(?:a|e|om|u)|meric(?:a|e|om)|šolj[ae]|solj[ae]|ča[sš](?:a|e|i)?|cup|kri[sš]k(?:a|e)|pakovanj(?:e|a)|kesic(?:a|e)|konzerv(?:a|e)|par[cč]e|par[cč]eta|glavic(?:a|e)|čena?|cena?|komad(?:a)?|list(?:a|ova)?|kolut(?:a|ova)?";
const MEAL_LABEL_MAP = {
  "1. Dorucak": "1. Doručak",
  "2. Uzina": "2. Prva užina",
  "2. Užina": "2. Prva užina",
  "2. Prva uzina": "2. Prva užina",
  "3. Rucak": "3. Ručak",
  "3. Obrok pre treninga": "3. Ručak",
  "3. Obrok pred trening": "3. Ručak",
  "3. Obrok 2h pre treninga": "3. Ručak",
  "4. Druga uzina": "4. Druga užina",
  "4. Obrok posle treninga": "4. Druga užina",
  "5. Vecera": "5. Večera",
};

const state = {
  activeTab: getInitialTab(),
  lastTabInGroup: {},
  quickWeightOpen: false,
  onboarding: null,
  lastAddedEntryId: "",
  trainingProgressOpen: false,
  trainingProgressPrefill: "",
  selectedWeekday: getTodayWeekday(),
  selectedWeekTrack: getCurrentWeekTrack(),
  planSummaryExpanded: getInitialPlanSummaryExpanded(),
  planSupplementsExpanded: getInitialPlanSupplementsExpanded(),
  planQuickExpanded: getInitialPlanQuickExpanded(),
  shoppingExpanded: false,
  recipesBuilderExpanded: false,
  tabEnter: true,
  foodSearch: "",
  foodMacroFilter: "Sve",
  foodNutritionFilter: "Sve",
  foodCatalogView: "list",
  foodFiltersOpen: false,
  stepsEditOpen: false,
  foodMenuOpenId: "",
  foodEditorOpen: false,
  quickEntryOpen: false,
  quickEntryText: "",
  quickEntryOverrides: {},
  scannerOpen: false,
  scannerStatus: "",
  scannerTorchOn: false,
  scannerTorchSupported: false,
  scannedFood: null,
  scannedBarcode: "",
  scannerReturnTo: "",
  recipeMealFilter: "Sve",
  recipeSearch: "",
  recipeNutritionFilter: "Sve",
  editingEntryId: "",
  editingMealLabel: "",
  // Meal prep ("kuvaj unapred"): which meal's prep panel is open + chosen days.
  prepMealLabel: "",
  prepMode: "next",
  prepDays: 2,
  prepPickDays: [], // {weekday, weekTrack}[]
  // Bulk "delete all meals" picker (Plan tab) — shares the day-picker markup
  // with meal-prep's "pick exact days" mode.
  bulkDeletePanelOpen: false,
  bulkDeletePickDays: [], // {weekday, weekTrack}[]
  planDraft: {
    mealLabel: "",
    foodId: "",
    grams: "",
    amountUnit: "g",
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
    imageUrl: "",
    servings: "1",
    prepTimeMinutes: "",
    instructions: "",
    items: [],
    foodId: "",
    grams: "",
    amountUnit: "g",
  },
  recipeApplyDialog: {
    favoriteId: "",
    weekday: "",
    weekTrack: "",
    mealLabel: "",
  },
  isPlanHeroCompact: false,
  progressCompareTag: PHOTO_TAGS[0],
  progressCompareLeftId: "",
  progressCompareRightId: "",
  insightsPeriod: 30,
  progressView: "pregled",
  goalsView: "cilj",
  pendingUndo: null,
  editingFoodId: "",
  nutritionEditingFoodId: "",
  nutritionSelectedPlanId: "",
  editingHabitId: "",
  editingTaskId: "",
  editingSupplementId: "",
  // Datirani unosi u „Napredak“ su do sada mogli samo da se obrišu i unesu
  // ponovo. Ovo drži koji se unos trenutno izmenjuje; "" = forma dodaje nov.
  editingMeasurementId: "",
  editingRunId: "",
  editingLabId: "",
  editingBodyCompId: "",
  // Podaci poslednjeg trčanja učitani iz clipboard-a (Apple Prečica) — pune formu
  // dok se ne sačuva. null = nema učitanog drafta.
  runImportDraft: null,
  nutritionImportPending: false,
  nutritionImportStatus: "",
  authReady: false,
  authPending: false,
  authMode: "login",
  authUser: null,
  authError: "",
  syncStatus: "Lokalno čuvanje",
  syncConflict: null,
  navMenuOpen: false,
  sidebarCollapsed: false,
  updateReady: false,
  isOnline: typeof navigator === "undefined" || navigator.onLine !== false,
};

let pendingUndoTimer = null;
let cloudSaveTimer = null;
let isHydratingCloudState = false;
// The cloud doc carries a monotonically increasing `rev`. knownRev is the rev
// this device last loaded or wrote; if the remote rev moves past it, another
// device wrote in the meantime and we must not silently overwrite (conflict).
// null = baseline not established yet (before first hydrate/save).
let knownRev = null;
// True once this session has loaded (or created) the cloud doc, i.e. knownRev is
// a real baseline. While false (offline start, read error) we don't auto-write:
// a blind write could stomp another device's newer data. Edits are kept locally
// with the per-account `dirty` flag and reconciled on the next hydrate.
let cloudBaselineReady = false;
// Bumped by persist(); a save only clears `dirty` if nothing changed in flight.
let localMutationCounter = 0;
let cloudSyncRetryInFlight = false;
let serviceWorkerRegistration = null;
let appUpdateReloading = false;

// One guarded reload for the update flow — whichever signal fires first
// (worker "activated", controllerchange, or a fallback timeout) wins, and the
// others are ignored so we never double-reload or loop.
function reloadForUpdate() {
  if (appUpdateReloading) {
    return;
  }
  appUpdateReloading = true;
  window.location.reload();
}
let lockedScrollY = 0;
let feedbackToastTimer = null;
let heroScrollFrame = 0;
let lastHeaderScrollY = 0;
const externalScriptPromises = new Map();

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const firebaseAuth = getAuth(firebaseApp);
const firebaseDb = getFirestore(firebaseApp);

function cloneSeed() {
  const seed = JSON.parse(JSON.stringify(window.SEED_DATA || {}));
  mirrorSingleTrackPlan(seed);
  return seed;
}

// The meal plan and training are a two-week (Ova / Sledeća) cycle keyed to the
// calendar, but the factory seed was authored on one track only — so on every
// other week the demo opened on an empty "Ova" week with the whole plan sitting
// under "Sledeća". Mirror single-track data onto the other track so both weeks
// are populated. Returns true when something was added.
function mirrorSingleTrackPlan(targetStore) {
  let changed = false;
  const mirror = (list, prefix) => {
    if (!Array.isArray(list) || !list.length) {
      return;
    }
    list.forEach((item) => {
      if (item && typeof item === "object") {
        item.weekTrack = normalizeWeekTrack(item.weekTrack);
      }
    });
    const tracks = new Set(list.map((item) => normalizeWeekTrack(item && item.weekTrack)));
    if (tracks.size !== 1) {
      return;
    }
    const to = [...tracks][0] === 1 ? 0 : 1;
    const copies = list.map((item, index) => ({
      ...JSON.parse(JSON.stringify(item)),
      id: `${(item && item.id) || `${prefix}-${index + 1}`}-t${to}`,
      weekTrack: to,
      done: false,
    }));
    list.push(...copies);
    changed = true;
  };
  mirror(targetStore.weeklyPlanEntries, "plan");
  mirror(targetStore.trainingTemplates, "template");
  return changed;
}

// Prva verzija reda za kafu je čuvala „koja namirnica“ + „ml po šoljici“. Sada
// je to jedan broj (coffeeKcal), pa ti ključevi nemaju ko da ih čita — brišu se
// pri učitavanju da ne šetaju kroz cloud i backup zauvek.
function dropLegacyCoffeeGoalKeys(goals) {
  delete goals.coffeeCupMl;
  delete goals.coffeeFoodId;
  return goals;
}

function normalizeStoreSnapshot(rawStore = {}, fallback = cloneSeed()) {
  const fallbackUi = {
    plan: {
      expandedMealsByWeekday: {},
    },
    recipes: {
      expandedRecipeIds: [],
    },
  };

  const profileDefaults = {
    sex: "",
    heightCm: null,
    activityLevel: "moderate",
  };

  const goalDefaults = {
    targetMode: "lose",
    paceLevel: "umereno",
    waterMl: 2500,
    stepsGoal: 10000,
    basisWeightKg: null,
    targetWeightKg: null,
    coffeeKcal: COFFEE_KCAL_DEFAULT,
  };

  return {
    ...fallback,
    ...rawStore,
    profile: { ...profileDefaults, ...fallback.profile, ...(rawStore.profile || {}) },
    goals: dropLegacyCoffeeGoalKeys({ ...goalDefaults, ...fallback.goals, ...(rawStore.goals || {}) }),
    onboarded: Boolean(rawStore.onboarded),
    meta: { ...fallback.meta, ...(rawStore.meta || {}) },
    foods: Array.isArray(rawStore.foods) ? rawStore.foods : fallback.foods,
    weeklyPlanEntries: Array.isArray(rawStore.weeklyPlanEntries)
      ? rawStore.weeklyPlanEntries
      : fallback.weeklyPlanEntries,
    // Legacy templates (saved before the two-week track existed) get stamped with
    // whatever track is live right now, the first time they're loaded after this
    // shipped — so an existing schedule becomes "Ova nedelja" today rather than
    // landing on whichever physical track index happens to default to 0.
    trainingTemplates: (Array.isArray(rawStore.trainingTemplates) ? rawStore.trainingTemplates : fallback.trainingTemplates).map(
      (template) => ({
        ...template,
        weekTrack: template.weekTrack == null ? getCurrentWeekTrack() : normalizeWeekTrack(template.weekTrack),
      })
    ),
    habits: Array.isArray(rawStore.habits) ? rawStore.habits : [],
    // Same one-time stamp as trainingTemplates above, for the same reason.
    dayTasks: (Array.isArray(rawStore.dayTasks) ? rawStore.dayTasks : []).map((task) => ({
      ...task,
      weekTrack: task.weekTrack == null ? getCurrentWeekTrack() : normalizeWeekTrack(task.weekTrack),
    })),
    favoriteTrainings: Array.isArray(rawStore.favoriteTrainings) ? rawStore.favoriteTrainings : [],
    trainingLogs: Array.isArray(rawStore.trainingLogs) ? rawStore.trainingLogs : [],
    trainingProgressLogs: Array.isArray(rawStore.trainingProgressLogs) ? rawStore.trainingProgressLogs : [],
    runs: Array.isArray(rawStore.runs) ? rawStore.runs : [],
    trainingBurnByWeekday:
      rawStore.trainingBurnByWeekday && typeof rawStore.trainingBurnByWeekday === "object"
        ? rawStore.trainingBurnByWeekday
        : {},
    trainingSectionBurnByWeekday:
      rawStore.trainingSectionBurnByWeekday && typeof rawStore.trainingSectionBurnByWeekday === "object"
        ? rawStore.trainingSectionBurnByWeekday
        : {},
    trainingCompletionsByWeekday:
      rawStore.trainingCompletionsByWeekday && typeof rawStore.trainingCompletionsByWeekday === "object"
        ? rawStore.trainingCompletionsByWeekday
        : {},
    measurements: Array.isArray(rawStore.measurements) ? rawStore.measurements : [],
    labResults: Array.isArray(rawStore.labResults) ? rawStore.labResults : [],
    bodyComposition: Array.isArray(rawStore.bodyComposition) ? rawStore.bodyComposition : [],
    progressPhotos: Array.isArray(rawStore.progressPhotos) ? rawStore.progressPhotos : [],
    foodUsage: rawStore.foodUsage && typeof rawStore.foodUsage === "object" ? rawStore.foodUsage : {},
    stepsByDate: rawStore.stepsByDate && typeof rawStore.stepsByDate === "object" ? rawStore.stepsByDate : {},
    coffeeByDate: rawStore.coffeeByDate && typeof rawStore.coffeeByDate === "object" ? rawStore.coffeeByDate : {},
    activityByDate: rawStore.activityByDate && typeof rawStore.activityByDate === "object" ? rawStore.activityByDate : {},
    shortcutNames: {
      run: String(rawStore.shortcutNames?.run || ""),
      activity: String(rawStore.shortcutNames?.activity || ""),
    },
    shoppingChecked:
      rawStore.shoppingChecked && typeof rawStore.shoppingChecked === "object" ? rawStore.shoppingChecked : {},
    shoppingStaples:
      rawStore.shoppingStaples && typeof rawStore.shoppingStaples === "object" ? rawStore.shoppingStaples : {},
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

// `allowLegacy` lets the first sign-in after the per-account split adopt the
// device's old single blob; a *different* account must not (it isn't theirs).
function readLocalSnapshot({ uid = activeStorageUid, allowLegacy = true } = {}) {
  const seed = cloneSeed();
  let storedRaw = safeLocalGet(getStoreStorageKey(uid));
  if (!storedRaw && uid && allowLegacy) {
    storedRaw = safeLocalGet(STORAGE_KEY);
  }
  if (!storedRaw) {
    return seed;
  }

  try {
    return normalizeStoreSnapshot(JSON.parse(storedRaw), seed);
  } catch (error) {
    console.error("State hydration failed", error);
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
  targetStore.runs = targetStore.runs || [];
  targetStore.trainingBurnByWeekday = targetStore.trainingBurnByWeekday || {};
  targetStore.trainingSectionBurnByWeekday = targetStore.trainingSectionBurnByWeekday || {};
  targetStore.trainingCompletionsByWeekday = targetStore.trainingCompletionsByWeekday || {};
  targetStore.measurements = targetStore.measurements || [];
  targetStore.labResults = targetStore.labResults || [];
  targetStore.bodyComposition = targetStore.bodyComposition || [];
  targetStore.foodUsage = targetStore.foodUsage && typeof targetStore.foodUsage === "object" ? targetStore.foodUsage : {};
  targetStore.progressPhotos = targetStore.progressPhotos || [];
  targetStore.shoppingChecked =
    targetStore.shoppingChecked && typeof targetStore.shoppingChecked === "object" ? targetStore.shoppingChecked : {};
  targetStore.shoppingStaples =
    targetStore.shoppingStaples && typeof targetStore.shoppingStaples === "object" ? targetStore.shoppingStaples : {};
  targetStore.waterByDate = targetStore.waterByDate && typeof targetStore.waterByDate === "object" ? targetStore.waterByDate : {};
  targetStore.stepsByDate = targetStore.stepsByDate && typeof targetStore.stepsByDate === "object" ? targetStore.stepsByDate : {};
  targetStore.coffeeByDate =
    targetStore.coffeeByDate && typeof targetStore.coffeeByDate === "object" ? targetStore.coffeeByDate : {};
  targetStore.activityByDate =
    targetStore.activityByDate && typeof targetStore.activityByDate === "object" ? targetStore.activityByDate : {};
  targetStore.shortcutNames =
    targetStore.shortcutNames && typeof targetStore.shortcutNames === "object" ? targetStore.shortcutNames : {};
  targetStore.shortcutNames.run = String(targetStore.shortcutNames.run || "");
  targetStore.shortcutNames.activity = String(targetStore.shortcutNames.activity || "");
  targetStore.history = targetStore.history && typeof targetStore.history === "object" ? targetStore.history : {};
  targetStore.preferences = targetStore.preferences && typeof targetStore.preferences === "object" ? targetStore.preferences : {};
  if (typeof targetStore.preferences.sharedFoods !== "boolean") {
    targetStore.preferences.sharedFoods = true;
  }
  targetStore.hiddenCatalogIds = Array.isArray(targetStore.hiddenCatalogIds) ? targetStore.hiddenCatalogIds.filter(Boolean) : [];
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
  targetStore.ui.recipes = targetStore.ui.recipes || {};
  if (!targetStore.ui.plan.expandedMealsByWeekday || typeof targetStore.ui.plan.expandedMealsByWeekday !== "object") {
    targetStore.ui.plan.expandedMealsByWeekday = {};
  }
  if (!Array.isArray(targetStore.ui.recipes.expandedRecipeIds)) {
    targetStore.ui.recipes.expandedRecipeIds = [];
  }
  targetStore.weeklyPlanEntries = (targetStore.weeklyPlanEntries || []).map((entry) => ({
    ...entry,
    mealLabel: normalizeMealLabel(entry.mealLabel),
    done: Boolean(entry.done),
    weekTrack: normalizeWeekTrack(entry.weekTrack),
  }));
  targetStore.favoriteMeals = targetStore.favoriteMeals.map((favorite) => normalizeFavoriteMealRecord(favorite));
  seedDemoFavoriteMeals(targetStore);
  cleanupNutritionImportedFoods(targetStore);
  normalizeFoodNamesAcrossStore(targetStore);
  normalizeFoodCategoriesAcrossStore(targetStore);
  normalizeFoodServingUnitsAcrossStore(targetStore);
  syncCatalogFoods(targetStore);
}

// ---------------------------------------------------------------------------
// Food catalog. The bundled seed (data/seed-data.js) is the app's official
// catalog. Every account keeps its OWN copy of each food (offline-first, one
// cloud doc), so the catalog only ever ADDS: a food that appears in a newer
// seed lands in the account on the next load; a catalog food the user deleted
// is remembered in `hiddenCatalogIds` and never comes back on its own (it stays
// reachable via "Iz kataloga" in the Namirnice search). Existing records are
// never overwritten — a user's edits to a catalog food are theirs.
// ---------------------------------------------------------------------------
function getCatalogFoods() {
  const seedFoods = Array.isArray(window.SEED_DATA?.foods) ? window.SEED_DATA.foods : [];
  return seedFoods.filter((food) => food && food.id && food.name);
}

function isCatalogFoodId(foodId) {
  return getCatalogFoods().some((food) => food.id === foodId);
}

function syncCatalogFoods(targetStore) {
  const catalog = getCatalogFoods();
  if (!catalog.length) {
    return;
  }
  targetStore.meta = targetStore.meta || {};
  const ownIds = new Set((targetStore.foods || []).map((food) => food.id));
  const hidden = new Set(targetStore.hiddenCatalogIds || []);
  if (!targetStore.meta.catalogSynced) {
    // First run with the catalog: whatever seed foods this account is missing
    // were deleted on purpose — remember that instead of re-adding them.
    catalog.forEach((food) => {
      if (!ownIds.has(food.id)) {
        hidden.add(food.id);
      }
    });
    targetStore.hiddenCatalogIds = [...hidden];
    targetStore.meta.catalogSynced = true;
    return;
  }
  catalog.forEach((food) => {
    if (!ownIds.has(food.id) && !hidden.has(food.id)) {
      targetStore.foods.push(JSON.parse(JSON.stringify(food)));
    }
  });
}

function hideCatalogFood(foodId) {
  if (!isCatalogFoodId(foodId)) {
    return;
  }
  store.hiddenCatalogIds = Array.isArray(store.hiddenCatalogIds) ? store.hiddenCatalogIds : [];
  if (!store.hiddenCatalogIds.includes(foodId)) {
    store.hiddenCatalogIds.push(foodId);
  }
}

// Catalog foods not currently in the account (deleted or never added) that
// match the query — offered under "Iz kataloga" in the Namirnice search.
function searchCatalogFoods(queryText, max = 6) {
  const tokens = normalizeLookupValue(queryText || "").split(" ").filter(Boolean);
  if (!tokens.length) {
    return [];
  }
  const ownIds = new Set((store.foods || []).map((food) => food.id));
  return getCatalogFoods()
    .filter((food) => !ownIds.has(food.id))
    .filter((food) => {
      const haystack = normalizeLookupValue(food.name);
      return tokens.every((token) => haystack.includes(token));
    })
    .slice(0, max);
}

function restoreCatalogFood(catalogId) {
  const catalogFood = getCatalogFoods().find((food) => food.id === catalogId);
  if (!catalogFood || (store.foods || []).some((food) => food.id === catalogId)) {
    return null;
  }
  const food = JSON.parse(JSON.stringify(catalogFood));
  store.foods.push(food);
  store.hiddenCatalogIds = (store.hiddenCatalogIds || []).filter((id) => id !== catalogId);
  return food;
}

// ---------------------------------------------------------------------------
// Shared products (sharedFoods/{barcode}). Written whenever anyone saves a
// scanned product (per 100 g), readable by every signed-in account. Besides the
// scan-time lookup they're searchable by name here: the collection is small
// (one doc per distinct barcode ever scanned), so it's fetched once per session
// and filtered locally — no extra index, no rule change. Governed by
// store.preferences.sharedFoods ("Deljeni proizvodi" in Nalog).
// ---------------------------------------------------------------------------
let sharedFoodsIndex = null;
let sharedFoodsIndexLoadedAt = 0;
let sharedFoodsIndexPromise = null;
const SHARED_FOODS_INDEX_TTL_MS = 10 * 60 * 1000;

function isSharedFoodsEnabled() {
  return store.preferences?.sharedFoods !== false;
}

async function loadSharedFoodsIndex() {
  if (!state.authUser || !isSharedFoodsEnabled()) {
    return [];
  }
  if (sharedFoodsIndex && Date.now() - sharedFoodsIndexLoadedAt < SHARED_FOODS_INDEX_TTL_MS) {
    return sharedFoodsIndex;
  }
  if (sharedFoodsIndexPromise) {
    return sharedFoodsIndexPromise;
  }
  sharedFoodsIndexPromise = (async () => {
    try {
      const snapshot = await getDocs(query(collection(firebaseDb, "sharedFoods"), limit(500)));
      const rows = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const name = String(data.name || "").trim();
        if (!name) {
          return;
        }
        rows.push({
          barcode: String(data.barcode || docSnap.id),
          name,
          kcal: nutNumber(data.kcal),
          protein: nutNumber(data.protein),
          carbs: nutNumber(data.carbs),
          fat: nutNumber(data.fat),
        });
      });
      sharedFoodsIndex = rows;
      sharedFoodsIndexLoadedAt = Date.now();
      return rows;
    } catch (error) {
      console.warn("Shared foods index failed", error);
      return sharedFoodsIndex || [];
    } finally {
      sharedFoodsIndexPromise = null;
    }
  })();
  return sharedFoodsIndexPromise;
}

function searchSharedFoods(rows, queryText, max = 6) {
  const tokens = normalizeLookupValue(queryText || "").split(" ").filter(Boolean);
  if (!tokens.length) {
    return [];
  }
  const ownBarcodes = new Set((store.foods || []).map((food) => String(food.barcode || "")).filter(Boolean));
  const ownNames = new Set((store.foods || []).map((food) => normalizeLookupValue(food.name)));
  return rows
    .filter((row) => !ownBarcodes.has(row.barcode) && !ownNames.has(normalizeLookupValue(row.name)))
    .filter((row) => {
      const haystack = normalizeLookupValue(row.name);
      return tokens.every((token) => haystack.includes(token));
    })
    .slice(0, max);
}

function addSharedFoodToStore(row) {
  if (!row || !row.name) {
    return null;
  }
  const base = {
    name: row.name,
    servingUnit: "grams",
    servingBaseGrams: 100,
    kcal: toNumber(row.kcal),
    protein: toNumber(row.protein),
    carbs: toNumber(row.carbs),
    fat: toNumber(row.fat),
  };
  const food = {
    id: uid("food"),
    ...base,
    barcode: row.barcode || "",
    category: getRecommendedFoodCategory(base),
    source: "shared",
  };
  store.foods.push(food);
  return food;
}

// Renders the "Iz kataloga" / "Deljeni proizvodi" groups under the Namirnice
// list for the current search. Catalog matches are instant; shared matches
// arrive when the index loads (first call per session hits the network).
let externalFoodResultsTimer = null;
function updateExternalFoodResults(queryText) {
  const container = document.querySelector('[data-role="foods-external"]');
  if (!container) {
    return;
  }
  const text = String(queryText || "").trim();
  if (text.length < 2) {
    container.innerHTML = "";
    return;
  }
  const paint = (sharedRows) => {
    const catalogMatches = searchCatalogFoods(text);
    const sharedMatches = searchSharedFoods(sharedRows || [], text);
    if (!catalogMatches.length && !sharedMatches.length) {
      container.innerHTML = "";
      return;
    }
    const row = (item, action, idAttr, idValue, meta) => `
      <div class="foods-external-row">
        <div class="foods-external-copy">
          <strong>${escapeHtml(item.name)}</strong>
          <span class="foods-external-meta">${meta}</span>
        </div>
        <button class="ghost-button button-with-icon foods-external-add" type="button" data-action="${action}" ${idAttr}="${escapeHtml(String(idValue))}" aria-label="Dodaj ${escapeHtml(item.name)} u moje namirnice">
          ${renderButtonContent("Dodaj", "add")}
        </button>
      </div>`;
    const macroMeta = (item) =>
      `${getFoodNutritionBasisLabel(item)} · <b>${roundValue(toNumber(item.kcal), 0)} kcal</b> · P ${roundValue(toNumber(item.protein), 1)} · UH ${roundValue(toNumber(item.carbs), 1)} · M ${roundValue(toNumber(item.fat), 1)} g`;
    container.innerHTML = `
      ${
        catalogMatches.length
          ? `<div class="foods-external-group">
              <div class="foods-external-label">Iz kataloga</div>
              ${catalogMatches.map((item) => row(item, "add-catalog-food", "data-catalog-id", item.id, macroMeta(item))).join("")}
            </div>`
          : ""
      }
      ${
        sharedMatches.length
          ? `<div class="foods-external-group">
              <div class="foods-external-label">Deljeni proizvodi <span class="foods-external-hint">skenirali drugi korisnici · na 100 g</span></div>
              ${sharedMatches.map((item) => row(item, "add-shared-food", "data-barcode", item.barcode, macroMeta({ ...item, servingUnit: "grams", servingBaseGrams: 100 }))).join("")}
            </div>`
          : ""
      }`;
  };
  paint(sharedFoodsIndex || []);
  const isCurrentQuery = () => {
    const current = document.querySelector("#food-search");
    return current instanceof HTMLInputElement && current.value.trim() === text;
  };
  window.clearTimeout(externalFoodResultsTimer);
  externalFoodResultsTimer = window.setTimeout(async () => {
    if (!isSharedFoodsEnabled() || !state.authUser) {
      return;
    }
    const sharedRows = await loadSharedFoodsIndex();
    // Query may have changed while the index was loading.
    if (isCurrentQuery()) {
      paint(sharedRows);
    }
  }, 220);
}

// A gram-based food with a 1 g basis is nonsense (100 g of it computes as
// 100× the listed macros — the seed's "Espreso sa mlekom" came out at 3500 kcal
// per 100 g). The food form always stores 100 for gram foods, so a basis of 1
// can only mean the record is really a per-piece item — mark it as one.
function normalizeFoodServingUnitsAcrossStore(targetStore) {
  (targetStore.foods || []).forEach((food) => {
    if (!food || getFoodServingUnit(food) === "piece") {
      return;
    }
    if (toNumber(food.servingBaseGrams) === 1) {
      food.servingUnit = "piece";
    }
  });
}

function normalizeFoodNamesAcrossStore(targetStore) {
  (targetStore.foods || []).forEach((food) => {
    const nextName = formatFoodDisplayName(food.name);
    if (!nextName || nextName === food.name) {
      return;
    }

    food.name = nextName;
    syncFoodNameAcrossCollections(targetStore, food.id, nextName);
  });
}

function normalizeFoodCategoriesAcrossStore(targetStore) {
  (targetStore.foods || []).forEach((food) => {
    const nextCategory = getRecommendedFoodCategory(food);
    if (!nextCategory || nextCategory === String(food.category || "").trim()) {
      return;
    }

    food.category = nextCategory;
  });
}

function replaceStore(nextStore) {
  // Normalize first: if the input is unusable this throws and the live store is
  // untouched (it used to be emptied before normalization ran).
  const normalized = normalizeStoreSnapshot(nextStore);
  ensureStoreCollections(normalized);
  Object.keys(store).forEach((key) => {
    delete store[key];
  });
  Object.assign(store, normalized);
}

function getSerializableStoreSnapshot(source = store) {
  return JSON.parse(JSON.stringify(source));
}

function getCloudStoreSnapshot(source = store) {
  const snapshot = getSerializableStoreSnapshot(source);
  delete snapshot.progressPhotos;
  if (Array.isArray(snapshot.favoriteMeals)) {
    snapshot.favoriteMeals = snapshot.favoriteMeals.map((favorite) =>
      favorite && isInlineImageData(favorite.imageUrl) ? { ...favorite, imageUrl: "" } : favorite
    );
  }
  return snapshot;
}

// The cloud `state` must be a plain object before we let it replace the local
// store. A null/array/primitive (corrupted or partially-written doc) would wipe
// good local data once normalized, so we reject it and keep working locally.
function isValidCloudState(data) {
  return Boolean(data) && typeof data === "object" && !Array.isArray(data);
}

// A backup is whatever exportData() wrote: the store itself. Require a couple of
// its top-level collections so a random JSON (package.json, another app's
// export) can't replace the whole store with seed + junk and get pushed to
// the cloud with a "success" toast.
const BACKUP_MARKER_KEYS = ["foods", "weeklyPlanEntries", "goals", "profile", "measurements", "trainingTemplates", "favoriteMeals", "habits", "trainingLogs"];
function looksLikeBackupSnapshot(parsed) {
  return isValidCloudState(parsed) && BACKUP_MARKER_KEYS.filter((key) => key in parsed).length >= 2;
}

function getUserStateRef(uid) {
  return doc(firebaseDb, "users", uid, "app", "state");
}

function isDemoAccount() {
  const email = state.authUser?.email;
  return Boolean(email) && email.toLowerCase() === DEMO_EMAIL.toLowerCase();
}

// Vrati trenutni nalog na originalni seed (jelovnik, namirnice, trening, obroci).
// Briše i lokalne slike napretka (one ionako nisu na cloudu) i forsira upis u cloud.
async function resetDemoToFactory() {
  replaceStore(cloneSeed());
  persistLocal();
  const saved = await saveCloudStateNow({ force: true, overwrite: true });
  if (!saved) {
    throw new Error("cloud-save-failed");
  }
}

// Reset PRAVOG (ne-demo) naloga: briše plan, trening, rutinu, dnevnik,
// istoriju, merenja i slike. NE dira namirnice (tvoja baza, uključujući sve
// što si sam dodao — ne vraća se na generički seed), profil ni ciljeve
// (kalorije/makroi/deficit ostaju kako su izračunati), pa se onboarding ne
// ponavlja. Ne sme se pozvati za demo nalog.
async function resetRealAccountToBlank() {
  const photoIdsToDelete = (store.progressPhotos || []).map((photo) => photo?.id).filter(Boolean);
  const keepFoods = store.foods;
  const keepProfile = store.profile;
  const keepGoals = store.goals;
  const keepFavoriteMeals = store.favoriteMeals;
  replaceStore({});
  store.foods = keepFoods;
  store.profile = keepProfile;
  store.goals = keepGoals;
  store.favoriteMeals = keepFavoriteMeals;
  store.weeklyPlanEntries = [];
  store.trainingTemplates = [];
  store.onboarded = true;
  persistLocal();
  await Promise.all(photoIdsToDelete.map((id) => idbDeletePhoto(id)));
  // saveCloudStateNow resolves false (not throws) on failure; surface it so the
  // button shows the error toast instead of "Podaci su obrisani". The local
  // reset is already done and flagged dirty, so the next hydrate completes it.
  const saved = await saveCloudStateNow({ force: true, overwrite: true });
  if (!saved) {
    throw new Error("cloud-save-failed");
  }
}

function getAuthErrorMessage(error) {
  switch (error?.code) {
    case "auth/email-already-in-use":
      return "Taj email je već zauzet. Probaj prijavu.";
    case "auth/invalid-email":
      return "Email nije ispravan.";
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "Pogrešan email ili lozinka.";
    case "auth/weak-password":
      return "Lozinka treba da ima bar 6 karaktera.";
    case "auth/network-request-failed":
      return "Nema veze sa internetom. Pokušaj ponovo.";
    default:
      return "Prijava nije uspela. Pokušaj ponovo.";
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

  const uid = state.authUser.uid;
  const ref = getUserStateRef(uid);
  const mutationAtStart = localMutationCounter;
  writeSyncMeta(uid, { dirty: true });
  try {
    // Read-before-write in a transaction so two devices can't silently clobber
    // each other: if the remote rev moved past what we last synced and we aren't
    // explicitly overwriting, abort and surface a conflict instead of writing.
    const nextRev = await runTransaction(firebaseDb, async (tx) => {
      const snapshot = await tx.get(ref);
      const data = snapshot.exists() ? snapshot.data() || {} : null;
      const remoteRev = data && typeof data.rev === "number" ? data.rev : 0;

      if (data && knownRev !== null && remoteRev !== knownRev && !options.overwrite) {
        const conflict = new Error("sync-conflict");
        conflict.code = "sync-conflict";
        conflict.remoteRev = remoteRev;
        throw conflict;
      }

      const rev = remoteRev + 1;
      // Always replace the whole doc. `set(..., { merge: true })` only wrote the
      // keys present locally, so a map key deleted here (an un-checked exercise,
      // an un-ticked shopping item, a removed staple) survived in the cloud and
      // came back on the next launch / never reached the other device.
      tx.set(ref, {
        schemaVersion: CLOUD_SCHEMA_VERSION,
        updatedAt: serverTimestamp(),
        rev,
        state: getCloudStoreSnapshot(),
      });
      return rev;
    });

    knownRev = nextRev;
    cloudBaselineReady = true;
    // Only mark clean if nothing changed while the write was in flight — the
    // pending debounce will save (and clear) the newer edit.
    writeSyncMeta(uid, { rev: nextRev, dirty: localMutationCounter !== mutationAtStart });
    state.syncStatus = "Sync je uključen";
    state.syncConflict = null;
    if (options.renderAfterSave) {
      render();
    }
    return true;
  } catch (error) {
    if (error && error.code === "sync-conflict") {
      // Don't overwrite the other device. Pause auto-sync and let the user pick.
      state.syncStatus = "Izmene sa drugog uređaja";
      state.syncConflict = { remoteRev: error.remoteRev };
      render();
      return false;
    }
    console.error("Cloud persist failed", error);
    // Edits are safe locally and flagged dirty; they're retried when we're back
    // online/visible and reconciled on the next hydrate.
    state.syncStatus = isCloudPayloadTooLarge(error)
      ? "Podaci su preveliki za cloud — ukloni slike recepata"
      : "Sačuvano lokalno · čeka sync";
    if (options.renderAfterSave) {
      render();
    }
    return false;
  }
}

// Firestore rejects documents over 1 MiB with invalid-argument.
function isCloudPayloadTooLarge(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.code === "invalid-argument" && /exceeds|maximum size|too large|1048576/.test(message);
}

// Fire a debounced save immediately (page going to background / being closed).
// Mobile OSes suspend timers, so a save scheduled 650 ms ago may never run.
function flushPendingCloudSave() {
  if (!cloudSaveTimer || !state.authUser || !cloudBaselineReady || state.syncConflict) {
    return;
  }
  saveCloudStateNow();
}

// After a failed hydrate (offline start) or a failed save, pick sync back up as
// soon as we're online/visible again instead of waiting for the next edit.
async function retryCloudSync() {
  if (!state.authUser || !state.authReady || isHydratingCloudState || cloudSyncRetryInFlight || state.syncConflict) {
    return;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return;
  }
  const uid = state.authUser.uid;
  cloudSyncRetryInFlight = true;
  try {
    if (!cloudBaselineReady) {
      await hydrateStoreFromCloud(state.authUser);
      await reconcilePhotos();
      render();
    } else if (readSyncMeta(uid).dirty && !cloudSaveTimer) {
      await saveCloudStateNow({ renderAfterSave: true });
    }
  } finally {
    cloudSyncRetryInFlight = false;
  }
}

function scheduleCloudPersist() {
  if (!state.authUser || isHydratingCloudState) {
    return;
  }

  writeSyncMeta(state.authUser.uid, { dirty: true });
  if (state.syncConflict) {
    // Auto-sync is paused until the user picks a side in the conflict banner.
    return;
  }
  if (!cloudBaselineReady) {
    state.syncStatus = "Sačuvano lokalno · čeka sync";
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
  cloudBaselineReady = false;
  state.syncStatus = "Učitavam podatke iz clouda...";
  render();

  // Switch the local copy to this account. The device's pre-account blob is
  // adopted only if it belonged to this account (or predates the split) — a
  // different account must never inherit it.
  const previousUid = safeLocalGet(LAST_UID_KEY);
  const isSameDeviceUser = !previousUid || previousUid === user.uid;
  const legacyAdopted = isSameDeviceUser && !safeLocalGet(getStoreStorageKey(user.uid)) && Boolean(safeLocalGet(STORAGE_KEY));
  activeStorageUid = user.uid;
  safeLocalSet(LAST_UID_KEY, user.uid);
  let persistedToAccountKey = false;
  const persistAccountCopy = () => {
    persistedToAccountKey = persistLocal() || persistedToAccountKey;
  };

  const localSnapshot = readLocalSnapshot({ uid: user.uid, allowLegacy: isSameDeviceUser });
  const localPhotos = Array.isArray(localSnapshot.progressPhotos) ? localSnapshot.progressPhotos : [];

  try {
    const syncMeta = readSyncMeta(user.uid);
    const hasUnsyncedLocalEdits = Boolean(syncMeta.dirty);
    const snapshot = await getDoc(getUserStateRef(user.uid));

    if (snapshot.exists()) {
      const docData = snapshot.data() || {};
      const cloudData = docData.state;
      const remoteRev = typeof docData.rev === "number" ? docData.rev : 0;

      if (isValidCloudState(cloudData)) {
        if (hasUnsyncedLocalEdits && syncMeta.rev === remoteRev) {
          // Local edits never reached the cloud (offline, killed mid-debounce)
          // and nobody else wrote since — push them instead of discarding them.
          knownRev = remoteRev;
          replaceStore({ ...localSnapshot, progressPhotos: localPhotos });
          persistAccountCopy();
          cloudBaselineReady = true;
          const saved = await saveCloudStateNow({ force: true, overwrite: true });
          state.syncStatus = saved ? "Sync je uključen" : "Sačuvano lokalno · čeka sync";
          return;
        }

        if (hasUnsyncedLocalEdits) {
          // Both sides changed since our last sync — keep the local copy on
          // screen and let the user pick (same banner as a live conflict).
          knownRev = typeof syncMeta.rev === "number" ? syncMeta.rev : remoteRev;
          replaceStore({ ...localSnapshot, progressPhotos: localPhotos });
          persistAccountCopy();
          cloudBaselineReady = true;
          state.syncStatus = "Izmene sa drugog uređaja";
          state.syncConflict = { remoteRev };
          return;
        }

        knownRev = remoteRev;
        replaceStore({ ...cloudData, progressPhotos: localPhotos });
        persistAccountCopy();
        writeSyncMeta(user.uid, { rev: remoteRev, dirty: false });
        cloudBaselineReady = true;
        state.syncStatus = "Sync je uključen";
        return;
      }

      // Doc exists but its state is corrupt/unexpected — keep the (good) local
      // data rather than wiping it; the next edit's save will repair the cloud.
      knownRev = remoteRev;
      replaceStore({ ...localSnapshot, progressPhotos: localPhotos });
      persistAccountCopy();
      cloudBaselineReady = true;
      state.syncStatus = "Cloud podaci su neispravni — radiš lokalno";
      return;
    }

    // No cloud doc = brand-new account. The demo account inherits the full
    // factory plan (the creator's seed) as a template; a real new user keeps the
    // generic food database but starts WITHOUT the creator's identity, goals,
    // plan, recipes or training, so onboarding runs and they start clean.
    // localSnapshot here is either this account's own copy or the untouched seed
    // (another account's local copy is never adopted — see readLocalSnapshot).
    replaceStore({ ...localSnapshot, progressPhotos: localPhotos });
    if (!isDemoAccount()) {
      store.profile = { ...store.profile, name: "", age: null, weightKg: null };
      store.goals = { ...store.goals, calories: 0, protein: 0, carbs: 0, fat: 0 };
      store.weeklyPlanEntries = [];
      store.favoriteMeals = [];
      store.trainingTemplates = [];
      store.onboarded = false;
    }
    persistAccountCopy();
    cloudBaselineReady = true;
    const saved = await saveCloudStateNow({ force: true });
    state.syncStatus = saved ? "Prvi sync je završen" : "Sačuvano lokalno · čeka sync";
  } catch (error) {
    console.error("Cloud hydration failed", error);
    cloudBaselineReady = false;
    // Work offline on THIS account's local copy (boot may have loaded the
    // previous account's). Edits are flagged dirty and pushed on the next hydrate.
    try {
      replaceStore({ ...localSnapshot, progressPhotos: localPhotos });
    } catch (replaceError) {
      console.error("Local fallback failed", replaceError);
    }
    state.syncStatus = "Cloud nije dostupan, radiš lokalno";
  } finally {
    isHydratingCloudState = false;
    if (legacyAdopted && persistedToAccountKey) {
      // The blob now lives under the account key — free the duplicate.
      safeLocalRemove(STORAGE_KEY);
    }
  }
}

// The localStorage snapshot drops the heavy previewUrl from photos already saved
// in IndexedDB (see photoIdsInIdb). Photos not yet confirmed in IDB keep their
// blob here so they survive a reload even if the IDB write hasn't landed.
function getLocalStoreSnapshot() {
  if (!photoIdsInIdb.size) {
    return store;
  }
  const snapshot = { ...store };
  if (Array.isArray(store.progressPhotos)) {
    snapshot.progressPhotos = store.progressPhotos.map((photo) => {
      if (photo && photoIdsInIdb.has(photo.id)) {
        const { previewUrl, ...meta } = photo;
        return meta;
      }
      return photo;
    });
  }
  if (Array.isArray(store.favoriteMeals)) {
    snapshot.favoriteMeals = store.favoriteMeals.map((favorite) =>
      favorite && isInlineImageData(favorite.imageUrl) && photoIdsInIdb.has(getRecipeImageKey(favorite.id))
        ? { ...favorite, imageUrl: "" }
        : favorite
    );
  }
  return snapshot;
}

function persistLocal(rollback) {
  try {
    localStorage.setItem(getStoreStorageKey(), JSON.stringify(getLocalStoreSnapshot()));
    return true;
  } catch (error) {
    if (typeof rollback === "function") {
      rollback();
    }
    console.error("Persist failed", error);
    window.alert("Ponestaje prostora za čuvanje podataka na ovom uređaju. Napravi backup (Ciljevi → Izvezi backup) za svaki slučaj.");
    return false;
  }
}

function persist(rollback) {
  localMutationCounter += 1;
  try {
    recordTodaySnapshot();
  } catch (error) {
    console.error("History snapshot failed", error);
  }
  const savedLocal = persistLocal(rollback);
  if (savedLocal) {
    scheduleCloudPersist();
  }
  return savedLocal;
}

// Reconcile in-memory photos with IndexedDB: migrate any blob not yet in IDB
// (legacy photos that lived in the localStorage blob, plus a safety net for adds)
// and stitch IDB blobs back onto records that loaded from localStorage without
// their previewUrl. Idempotent — safe to call at startup and after cloud hydrate.
async function reconcilePhotos() {
  const idbMap = await idbAllPhotos();
  if (!idbMap) {
    return; // IndexedDB unavailable — keep legacy localStorage-only behavior.
  }
  idbMap.forEach((_previewUrl, id) => photoIdsInIdb.add(id));

  const toMigrate = [];
  let stitched = 0;
  (store.progressPhotos || []).forEach((photo) => {
    if (!photo || !photo.id) {
      return;
    }
    if (photo.previewUrl) {
      if (!idbMap.has(photo.id)) {
        toMigrate.push(photo);
      }
    } else if (idbMap.has(photo.id)) {
      photo.previewUrl = idbMap.get(photo.id);
      stitched += 1;
    }
  });

  // Recipe photos: same migrate/stitch dance. Content is compared (not just the
  // id) so a replaced photo overwrites the stored one instead of resurrecting
  // the old image on the next load.
  (store.favoriteMeals || []).forEach((favorite) => {
    if (!favorite || !favorite.id) {
      return;
    }
    const key = getRecipeImageKey(favorite.id);
    if (isInlineImageData(favorite.imageUrl)) {
      if (idbMap.get(key) !== favorite.imageUrl) {
        toMigrate.push({ id: key, previewUrl: favorite.imageUrl });
      }
    } else if (!favorite.imageUrl && idbMap.has(key)) {
      favorite.imageUrl = idbMap.get(key);
      stitched += 1;
    }
  });

  if (toMigrate.length && (await idbPutPhotos(toMigrate))) {
    // Blobs are durable in IndexedDB now — shrink the localStorage snapshot.
    persistLocal();
  }
  if (stitched || toMigrate.length) {
    render();
  }
}

function clearPendingUndo() {
  state.pendingUndo = null;
  if (pendingUndoTimer) {
    window.clearTimeout(pendingUndoTimer);
    pendingUndoTimer = null;
  }
}

// Generic "soft delete with undo": stash a restore() closure and show an undo
// banner for a few seconds instead of a blocking confirm() dialog.
function queuePendingUndo(message, restore, extra = null) {
  clearPendingUndo();
  state.pendingUndo = { message, restore, extra };
  pendingUndoTimer = window.setTimeout(() => {
    state.pendingUndo = null;
    pendingUndoTimer = null;
    render();
  }, 7000);
}

function uid(prefix) {
  if (window.crypto?.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Derived from getDay() (Sunday=0) rather than Intl: `sr-RS` formats weekdays
// in Cyrillic ("\u0441\u0440\u0435\u0434\u0430"), so a Latin lookup table never matched and every day
// silently resolved to the "Ponedeljak" fallback \u2014 the app opened on Monday,
// today's history snapshot recorded Monday's meals, etc.
function getTodayWeekday() {
  return WEEKDAYS[(new Date().getDay() + 6) % 7];
}

function getInitialTab() {
  const hash = window.location.hash.replace("#", "");
  return ALL_TABS.some((tab) => tab.id === hash) ? hash : "plan";
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
    imageUrl: String(favorite.imageUrl || "").trim(),
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

const FOOD_NAME_DISPLAY_OVERRIDES = {
  "4 godisnja doba frikom": "4 godišnja doba Frikom",
  "coca cola zero": "Coca Cola Zero",
  "dm bio": "DM Bio",
  "sirup od agave dm bio": "Sirup od agave DM Bio",
  "turska kafa bez secera": "Turska kafa bez šećera",
  "kafa turska": "Turska kafa",
  "kineska mesavina frikom": "Kineska mešavina Frikom",
  "meksicka mesavina frikom": "Meksička mešavina Frikom",
  "imlek slana karamela puding": "Imlek slana karamela puding",
  "grcki jogurt dukatos": "Grčki jogurt Dukatos",
  "grcki jogurt pilos kokos": "Grčki jogurt Pilos kokos",
};

const FOOD_NAME_WORD_OVERRIDES = {
  prsuta: "pršuta",
  pecenica: "pečenica",
  oslic: "oslić",
  grcki: "grčki",
  cokoladno: "čokoladno",
  pileca: "pileća",
  pilecih: "pilećih",
  pileceg: "pilećeg",
  govedja: "goveđa",
  cia: "čia",
  secerac: "šećerac",
  secera: "šećera",
  spanac: "spanać",
  sampinjoni: "šampinjoni",
  zacinjen: "začinjen",
  zacini: "začini",
  mesavina: "mešavina",
  meksicka: "meksička",
  sargarepa: "šargarepa",
  sunka: "šunka",
  spagete: "špagete",
  pirincani: "pirinčani",
  pomorandze: "pomorandže",
  lesnik: "lešnik",
  kospica: "košpica",
  grozdja: "grožđa",
  godisnja: "godišnja",
  breskva: "breskva",
};

function capitalizeFirstLetter(value) {
  return String(value || "").replace(/[a-zA-ZčćžšđČĆŽŠĐ]/, (letter) => letter.toLocaleUpperCase("sr-RS"));
}

function formatFoodDisplayName(name) {
  const cleanedName = String(name || "").replace(/\s+/g, " ").trim();
  if (!cleanedName) {
    return "";
  }

  const exactOverride = FOOD_NAME_DISPLAY_OVERRIDES[normalizeLookupValue(cleanedName)];
  if (exactOverride) {
    return exactOverride;
  }

  const replaced = cleanedName.replace(/[A-Za-zÀ-ž0-9.%]+/g, (token) => {
    const override = FOOD_NAME_WORD_OVERRIDES[normalizeLookupValue(token)];
    if (!override) {
      return token;
    }

    if (/^[A-ZČĆŽŠĐ0-9.%]+$/.test(token) && token.length > 1) {
      return override.toLocaleUpperCase("sr-RS");
    }

    if (/^[A-ZČĆŽŠĐ]/.test(token)) {
      return capitalizeFirstLetter(override);
    }

    return override;
  });

  return capitalizeFirstLetter(replaced);
}

const store = hydrateStore();
ensureStoreCollections(store);

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
    return defaultMeals[2];
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

// Recipe items are stored for the whole batch; one serving's worth is applied.
function scaleItemsToOneServing(items, servings) {
  const divisor = Math.max(1, toNumber(servings) || 1);
  return (items || [])
    .filter((item) => item.foodId)
    .map((item) => ({ ...item, grams: Math.max(0.1, roundValue(toNumber(item.grams) / divisor, 1)) }));
}

function getNutritionPlanMealApplyItems(meal) {
  if (Array.isArray(meal.items) && meal.items.length) {
    const items = meal.items.filter((item) => item.foodId);
    // Plans saved before per-serving scaling carried whole-batch recipe grams
    // next to per-serving totals; detect that (items ≈ servings × totals) and
    // scale down so "Primeni" adds what the card shows, not the whole batch.
    const servings = toNumber(meal.servings);
    const shownKcal = toNumber(meal.totals?.kcal);
    if (meal.linkedRecipeId && servings > 1 && shownKcal > 0) {
      const itemsKcal = getDayTotals(items).kcal;
      if (Math.abs(itemsKcal / shownKcal - servings) < 0.05 * servings) {
        return scaleItemsToOneServing(items, servings);
      }
    }
    return items;
  }

  if (meal.linkedRecipeId) {
    const linkedRecipe = getFavoriteMealsDetailed().find((recipe) => recipe.id === meal.linkedRecipeId);
    if (linkedRecipe) {
      return scaleItemsToOneServing(linkedRecipe.items, getRecipeServingCount(linkedRecipe));
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
    store.weeklyPlanEntries = store.weeklyPlanEntries.filter(
      (entry) => !(entry.weekday === state.selectedWeekday && normalizeWeekTrack(entry.weekTrack) === state.selectedWeekTrack)
    );
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
        weekTrack: state.selectedWeekTrack,
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
  // A linked recipe's items are whole-batch grams while the card shows one
  // serving — scale them down here so items, totals and "Primeni" all agree.
  const rawItems = parsedItems.length
    ? parsedItems
    : recipeItems.map((item) => ({ ...item, grams: toNumber(item.grams) / getRecipeServingCount(linkedRecipe || {}) }));
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
    totals: getDayTotals(items),
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

// ---- Izmena datiranih unosa (merenje, trčanje, nalaz, analiza) -------------
// Svi se drže u listi obrnuto hronološki i dodaju preko unshift, pa izmena ne
// sme da ide „obriši + dodaj“: unos bi odskočio na vrh liste i promenio red.
function getEditingRecord(collection, id) {
  const recordId = String(id || "").trim();
  return recordId ? (collection || []).find((entry) => entry && entry.id === recordId) || null : null;
}

function replaceRecordInPlace(collection, id, next) {
  const index = (collection || []).findIndex((entry) => entry && entry.id === id);
  if (index < 0) {
    return false;
  }
  collection[index] = next;
  return true;
}

// Olovka na redu: ista ikonica i isti oblik kao brze akcije na stavci u obroku.
function renderEditRecordButton(action, idAttr, id, label) {
  return `<button class="ghost-button button-with-icon icon-only-action" type="button" data-action="${action}" ${idAttr}="${id}" aria-label="${escapeHtml(label)}" title="Izmeni">${renderButtonContent("Izmeni", "edit")}</button>`;
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
      statusDetail: "Vrednosti su sačuvane kao nula na 100 g.",
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
  state.foodEditorOpen = false;
  state.scannedFood = null;
  state.scannedBarcode = "";
}

function openFoodEditorDialog(foodId = "") {
  state.activeTab = "foods";
  state.nutritionEditingFoodId = "";
  state.editingFoodId = foodId;
  state.foodEditorOpen = true;
}

function closeFoodEditorDialog() {
  resetFoodEditing();
}

function resetRoutineEditing() {
  state.editingHabitId = "";
  state.editingTaskId = "";
  state.editingSupplementId = "";
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

function deleteFoodFromCollections(targetStore, foodId) {
  const result = {
    removedPlanEntries: 0,
    removedRecipeItems: 0,
    removedRecipes: 0,
    removedFavoriteReferences: 0,
  };

  const planEntries = targetStore.weeklyPlanEntries || [];
  result.removedPlanEntries = planEntries.filter((entry) => entry.foodId === foodId).length;
  targetStore.weeklyPlanEntries = planEntries.filter((entry) => entry.foodId !== foodId);

  targetStore.favoriteMeals = (targetStore.favoriteMeals || [])
    .map((favorite) => {
      const removedCount = (favorite.items || []).filter((item) => item.foodId === foodId).length;
      result.removedRecipeItems += removedCount;
      return {
        ...favorite,
        items: (favorite.items || []).filter((item) => item.foodId !== foodId),
      };
    })
    .filter((favorite) => {
      const keep = (favorite.items || []).length > 0;
      if (!keep) {
        result.removedRecipes += 1;
      }
      return keep;
    });

  const hadFavoriteReference = (targetStore.favoriteFoods || []).includes(foodId);
  targetStore.favoriteFoods = mergeUniqueStrings((targetStore.favoriteFoods || []).filter((entry) => entry !== foodId));
  if (hadFavoriteReference) {
    result.removedFavoriteReferences = 1;
  }

  targetStore.foods = (targetStore.foods || []).filter((food) => food.id !== foodId);
  targetStore.nutritionLibrary.importedFoodIds = mergeUniqueStrings(
    (targetStore.nutritionLibrary?.importedFoodIds || []).filter((entry) => entry !== foodId)
  );

  return result;
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

function getRecommendedFoodCategory(food = {}) {
  const protein = Math.max(0, toNumber(food.protein));
  const carbs = Math.max(0, toNumber(food.carbs));
  const fat = Math.max(0, toNumber(food.fat));
  const kcal = Math.max(0, toNumber(food.kcal));

  const macros = [
    { label: "Proteini", value: protein },
    { label: "UH", value: carbs },
    { label: "Masti", value: fat },
  ].sort((left, right) => right.value - left.value);

  if (!macros[0] || macros[0].value <= 0) {
    return kcal > 0 ? "Ostalo" : "Ostalo";
  }

  return macros[0].label;
}

function getFoodServingUnit(food = {}) {
  const normalizedFood = food || {};
  return String(normalizedFood.servingUnit || "").trim() === "piece" ? "piece" : "grams";
}

function getFoodServingBaseValue(food = {}) {
  const normalizedFood = food || {};
  const fallbackValue = getFoodServingUnit(normalizedFood) === "piece" ? 1 : 100;
  return Math.max(1, roundValue(toNumber(normalizedFood.servingBaseGrams || fallbackValue), 0)) || fallbackValue;
}

function getFoodNutritionBasisLabel(food = {}) {
  return getFoodServingUnit(food) === "piece" ? "1 komad" : `${roundValue(getFoodServingBaseValue(food), 0)} g`;
}

function getFoodQuantityPlaceholder(food = {}) {
  return getFoodServingUnit(food) === "piece" ? "1" : "100";
}

function formatFoodAmount(food, amount) {
  const value = toNumber(amount);
  if (getFoodServingUnit(food) === "piece") {
    return `${roundValue(value, Number.isInteger(value) ? 0 : 1)} kom`;
  }
  return `${roundValue(value, 0)} g`;
}

// Lets gram-based foods (medovi, ulja, začini...) be entered as kašičica/
// kašika instead of typing a gram estimate — same conversion factors the
// recipe-import text parser already uses (see convertImportedPortionToGrams),
// so a spoon means the same thing everywhere in the app.
const AMOUNT_UNIT_FACTORS = { g: 1, tsp: 5, tbsp: 15 };

function amountUnitLabel(unit) {
  return unit === "tsp" ? "kašičica" : unit === "tbsp" ? "kašika" : "g";
}

// Serbian plural: 1 = singular, 2-4 = "few" form, 5+ reverts to the
// singular spelling (genitive plural) — the range recipes actually use.
function pluralizeSpoonUnit(unit, count) {
  const n = Math.abs(Math.round(toNumber(count)));
  if (unit === "tbsp") {
    return n === 1 ? "kašika" : n >= 2 && n <= 4 ? "kašike" : "kašika";
  }
  if (unit === "tsp") {
    return n === 1 ? "kašičica" : n >= 2 && n <= 4 ? "kašičice" : "kašičica";
  }
  return "g";
}

function convertAmountUnitToGrams(amount, unit) {
  return toNumber(amount) * (AMOUNT_UNIT_FACTORS[unit] || 1);
}

function convertGramsToAmountUnit(grams, unit) {
  const factor = AMOUNT_UNIT_FACTORS[unit] || 1;
  return roundValue(toNumber(grams) / factor, unit === "g" ? 0 : 2);
}

// ---------------------------------------------------------------------------
// Food search ranking shared by the Namirnice list and the Plan composer.
// Lower score = better: exact name, name starts with the query, a word starts
// with it, all tokens somewhere in the name, one-typo match, category-only hit.
// Ties break on how recently the food was logged, then alphabetically.
// ---------------------------------------------------------------------------
function isWithinOneEdit(a, b) {
  if (a === b) {
    return true;
  }
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) {
    return false;
  }
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) {
    i += 1;
  }
  if (i === la || i === lb) {
    return true;
  }
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) {
      return true;
    }
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// "piletna" → "piletina", "jogrut" → "jogurt": the token may differ from the
// word's prefix by one insertion, deletion, substitution or swap.
function wordMatchesFuzzy(token, word) {
  if (token.length < 4) {
    return false;
  }
  return (
    isWithinOneEdit(token, word.slice(0, token.length)) ||
    isWithinOneEdit(token, word.slice(0, token.length + 1)) ||
    isWithinOneEdit(token, word.slice(0, token.length - 1))
  );
}

function scoreNameForQuery(name, haystack, normalizedQuery, tokens) {
  if (!tokens.length) {
    return 0;
  }
  if (name === normalizedQuery) {
    return 0;
  }
  if (name.startsWith(normalizedQuery)) {
    return 1;
  }
  const words = name.split(" ").filter(Boolean);
  const allInName = tokens.every((token) => name.includes(token));
  if (allInName) {
    return words.some((word) => word.startsWith(tokens[0])) ? 2 : 3;
  }
  if (tokens.every((token) => haystack.includes(token) || words.some((word) => wordMatchesFuzzy(token, word)))) {
    return tokens.every((token) => haystack.includes(token)) ? 5 : 4;
  }
  return null;
}

function rankFoodsForQuery(query, foods = getSelectableFoods(), limit = 8) {
  const normalizedQuery = normalizeLookupValue(query || "");
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (!tokens.length) {
    return [];
  }
  const usage = store.foodUsage || {};
  const now = Date.now();
  return foods
    .map((food) => {
      const name = normalizeLookupValue(food.name);
      const haystack = normalizeLookupValue([food.name, canonicalizeImportedFoodName(food.name), food.category].filter(Boolean).join(" "));
      const score = scoreNameForQuery(name, haystack, normalizedQuery, tokens);
      if (score === null) {
        return null;
      }
      const lastAt = toNumber(usage[food.id]?.lastAt) || 0;
      return { food, score, lastAt, recent: lastAt > 0 && now - lastAt < 14 * DAY_IN_MS };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || b.lastAt - a.lastAt || String(a.food.name).localeCompare(String(b.food.name), "sr"))
    .slice(0, limit);
}

// Wraps the parts of `text` that match any token in <mark>, matching without
// case or diacritics but highlighting the original characters.
function highlightMatch(text, tokens) {
  const source = String(text || "");
  const chunks = [...source].map((ch) => normalizeLookupValue(ch) || (/\s/.test(ch) ? " " : ""));
  const normalized = chunks.join("");
  const offsets = [];
  let cursor = 0;
  chunks.forEach((chunk) => {
    offsets.push(cursor);
    cursor += chunk.length;
  });
  const marked = new Array(source.length).fill(false);
  tokens.forEach((token) => {
    if (!token) {
      return;
    }
    let from = 0;
    let hit = normalized.indexOf(token, from);
    while (hit !== -1) {
      const end = hit + token.length;
      offsets.forEach((offset, index) => {
        const chunkEnd = offset + chunks[index].length;
        if (chunks[index] && offset < end && chunkEnd > hit) {
          marked[index] = true;
        }
      });
      from = end;
      hit = normalized.indexOf(token, from);
    }
  });
  let html = "";
  let open = false;
  [...source].forEach((ch, index) => {
    if (marked[index] && !open) {
      html += "<mark>";
      open = true;
    } else if (!marked[index] && open) {
      html += "</mark>";
      open = false;
    }
    html += escapeHtml(ch);
  });
  if (open) {
    html += "</mark>";
  }
  return html;
}

// Suggestion list under the Plan composer's food field (replaces the native
// <datalist>: ranked, shows kcal, keyboard-navigable, typo tolerant).
function updateFoodSuggestions(query, selectedFood = null) {
  const list = document.querySelector("#food-suggest");
  if (!list) {
    return;
  }
  const normalizedQuery = normalizeLookupValue(query || "");
  const mealLabel = normalizeMealLabel(state.planDraft.mealLabel || state.editingMealLabel || defaultMeals[0]);
  const usage = store.foodUsage || {};
  const row = (food, tokens, meta) => {
    const grams = quickAddGramsFor(food, usage[food.id]);
    const kcal = roundValue(calculateEntry(food, grams).kcal, 0);
    return `
      <div class="food-suggest-row">
        <button type="button" class="food-suggest-item" role="option" aria-selected="false" data-action="pick-plan-food" data-food-id="${food.id}">
          <span class="food-suggest-name">${tokens ? highlightMatch(food.name, tokens) : escapeHtml(food.name)}</span>
          <span class="food-suggest-meta">${meta}</span>
        </button>
        <button type="button" class="food-suggest-add" data-action="quick-add-food" data-food-id="${food.id}" data-meal-label="${escapeHtml(mealLabel)}" aria-label="Dodaj ${escapeHtml(food.name)}, ${formatFoodAmount(food, grams)}" title="Dodaj ${formatFoodAmount(food, grams)} · ${kcal} kcal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>`;
  };
  // Empty field: what you logged recently, at the amount you used last time —
  // the common case ("same breakfast as yesterday") is one tap on "+".
  if (!normalizedQuery && !selectedFood && !state.editingEntryId) {
    const recent = getQuickAddFoods(6);
    if (!recent.length) {
      list.hidden = true;
      list.innerHTML = "";
      return;
    }
    list.innerHTML =
      `<div class="food-suggest-heading">Nedavno</div>` +
      recent
        .map(({ food, usage: foodUsage }) => {
          const grams = quickAddGramsFor(food, foodUsage);
          return row(food, null, `${formatFoodAmount(food, grams)} · ${roundValue(calculateEntry(food, grams).kcal, 0)} kcal`);
        })
        .join("");
    list.hidden = false;
    markActiveSuggestion(list, 0);
    return;
  }
  if (normalizedQuery.length < 2 || (selectedFood && normalizeLookupValue(selectedFood.name) === normalizedQuery)) {
    list.hidden = true;
    list.innerHTML = "";
    return;
  }
  const ranked = rankFoodsForQuery(query, getSelectableFoods(), 6);
  if (!ranked.length) {
    list.hidden = true;
    list.innerHTML = "";
    return;
  }
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  list.innerHTML = ranked
    .map((entry) => row(entry.food, tokens, `${getFoodNutritionBasisLabel(entry.food)} · ${roundValue(entry.food.kcal, 0)} kcal${entry.recent ? ` · <em>nedavno</em>` : ""}`))
    .join("");
  list.hidden = false;
  markActiveSuggestion(list, 0);
}

function markActiveSuggestion(list, activeIndex) {
  [...list.querySelectorAll(".food-suggest-item")].forEach((item, index) => {
    item.classList.toggle("is-active", index === activeIndex);
    item.setAttribute("aria-selected", String(index === activeIndex));
  });
}

function resolveFoodFromQuery(query) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return null;
  }
  return findFoodByExactName(normalizedQuery) || findBestFoodMatchByName(normalizedQuery) || null;
}

function calculateEntry(food, grams) {
  const ratio = grams / getFoodServingBaseValue(food);
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

function addTotals(base = {}, extra = {}) {
  return {
    kcal: roundValue(toNumber(base.kcal) + toNumber(extra.kcal), 1),
    protein: roundValue(toNumber(base.protein) + toNumber(extra.protein), 1),
    carbs: roundValue(toNumber(base.carbs) + toNumber(extra.carbs), 1),
    fat: roundValue(toNumber(base.fat) + toNumber(extra.fat), 1),
  };
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

function getPlanEntriesForDay(weekday, weekTrack) {
  return store.weeklyPlanEntries
    .filter((entry) => entry.weekday === weekday && normalizeWeekTrack(entry.weekTrack) === weekTrack)
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

function getWeeklySummary(weekTrack = getCurrentWeekTrack()) {
  return WEEKDAYS.map((weekday) => {
    const entries = getPlanEntriesForDay(weekday, weekTrack);
    return {
      weekday,
      totals: getDayTotals(entries),
      count: entries.length,
    };
  });
}

function getWeeklyOverview(weekTrack = getCurrentWeekTrack()) {
  const days = getWeeklySummary(weekTrack).map((day) => {
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

function getTrainingForDay(weekday, weekTrack = state.selectedWeekTrack) {
  return store.trainingTemplates.filter(
    (template) => template.weekday === weekday && normalizeWeekTrack(template.weekTrack) === weekTrack
  );
}

// Fiksne sekcije za kalorije treninga, u redu u kom se i prikazuju. „Trening“
// su vežbe iz šablona tog dana; stomak i kardio se rade uz njih pa imaju svoje
// kalorije, a ukupno je njihov zbir — „cela potrošnja treninga“.
const TRAINING_BURN_SECTIONS = [
  { id: "main", label: "Trening" },
  { id: "abs", label: "Stomak" },
  { id: "cardio", label: "Kardio" },
];

function getTrainingSectionBurns(weekday) {
  const bucket = (store.trainingSectionBurnByWeekday || {})[String(weekday || "").trim()];
  const record = bucket && typeof bucket === "object" ? bucket : {};
  return TRAINING_BURN_SECTIONS.map((section) => ({
    ...section,
    kcal: Math.max(0, Math.round(toNumber(record[section.id]))),
  }));
}

function getTrainingSectionBurnTotal(weekday) {
  return getTrainingSectionBurns(weekday).reduce((sum, section) => sum + section.kcal, 0);
}

// Sirov broj iz „Potrošnja sa sata“, bez zbira sekcija. Forma mora da veže
// ovaj broj — inače bi u polje za sat upao zbir sekcija i sledeće čuvanje bi
// ga upisalo kao da je došao sa sata.
function getWatchBurnForDay(weekday) {
  return Math.max(0, toNumber(store.trainingBurnByWeekday?.[weekday]));
}

function getTrainingBurnForDay(weekday) {
  // Zbir sekcija pobeđuje. Broj sa sata je dnevni Move (uključuje i hodanje),
  // pa sabrati ga sa unosom po sekcijama znači duplo brojanje. Kad postoji
  // ručni unos po sekcijama, on je tačniji za sam trening i sat se ignoriše;
  // na danima kad ništa ne upišeš, sat (i njegov uvoz) rade kao i pre.
  const sections = getTrainingSectionBurnTotal(weekday);
  return sections > 0 ? sections : getWatchBurnForDay(weekday);
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

function getTasksForDay(weekday, weekTrack = state.selectedWeekTrack) {
  return store.dayTasks
    .filter((task) => task.weekday === weekday && normalizeWeekTrack(task.weekTrack) === weekTrack)
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

// Macro split that can't overshoot the calorie target. Plain g/kg factors work
// for normal-weight people, but on a heavier body they blow past the budget
// (protein + fat alone exceeding the target, carbs shown as "0 g"). So: cap
// protein at 40% of kcal when cutting (35% otherwise), fat at 35%, always keep
// at least 20% of kcal for carbs, and if the caps still don't fit, scale P and
// F down together. Carbs are the remainder. Whole grams — nobody weighs 259.6 g.
function splitMacros(targetCalories, weightKg, goalMode) {
  const kcal = Math.max(0, toNumber(targetCalories));
  const weight = Math.max(0, toNumber(weightKg));
  let proteinKcal = Math.min(weight * goalMode.proteinFactor * 4, kcal * (goalMode.id === "lose" ? 0.4 : 0.35));
  let fatKcal = Math.min(weight * goalMode.fatFactor * 9, kcal * 0.35);
  const carbFloorKcal = kcal * 0.2;
  const available = kcal - carbFloorKcal;
  if (proteinKcal + fatKcal > available && proteinKcal + fatKcal > 0) {
    const scale = available / (proteinKcal + fatKcal);
    proteinKcal *= scale;
    fatKcal *= scale;
  }
  const protein = roundValue(proteinKcal / 4, 0);
  const fat = roundValue(fatKcal / 9, 0);
  const carbs = roundValue(Math.max(0, kcal - protein * 4 - fat * 9) / 4, 0);
  return { protein, fat, carbs };
}

// Daily water target from body weight (~35 ml/kg), in 250 ml glasses, kept
// between 1.5 and 4 L. Editable in Ciljevi; this is just the sensible default.
function suggestWaterMl(weightKg) {
  const weight = toNumber(weightKg);
  if (!weight) {
    return 2500;
  }
  return Math.min(4000, Math.max(1500, Math.round((weight * 35) / 250) * 250));
}

function getGoalRecommendation(profile = store.profile, goals = store.goals) {
  const bmr = getBmrEstimate(profile);
  if (!bmr) {
    return null;
  }

  const activity = ACTIVITY_LEVELS.find((entry) => entry.id === profile.activityLevel) || ACTIVITY_LEVELS[2];
  const goalMode = GOAL_MODES.find((entry) => entry.id === goals.targetMode) || GOAL_MODES[0];
  const pace = PACE_LEVELS.find((entry) => entry.id === goals.paceLevel) || PACE_LEVELS[1];
  const weightKg = Math.max(0, toNumber(profile.weightKg));
  const maintenance = roundValue(bmr * activity.multiplier, 0);
  // Calorie target from a concrete weekly rate (kg/week), not a flat %.
  // 1 kg ≈ 7700 kcal → daily adjustment = rate * 7700 / 7.
  let rateKgPerWeek = 0;
  if (goalMode.id === "lose") {
    rateKgPerWeek = -pace.loseKgPerWeek;
  } else if (goalMode.id === "gain") {
    rateKgPerWeek = pace.gainKgPerWeek;
  }
  const floorCalories = Math.max(1200, roundValue(bmr, 0));
  let targetCalories = roundValue(maintenance + (rateKgPerWeek * KCAL_PER_KG) / 7, 0);
  const requestedRateKgPerWeek = rateKgPerWeek;
  if (rateKgPerWeek < 0) {
    targetCalories = Math.max(targetCalories, floorCalories);
    // The floor caps the real deficit, so report the pace that deficit actually
    // buys — ETA, the chart projection and the hero label all read this value.
    rateKgPerWeek = roundValue(((targetCalories - maintenance) * 7) / KCAL_PER_KG, 2);
  }
  const paceLimited = Math.abs(rateKgPerWeek - requestedRateKgPerWeek) > 0.01;
  const { protein, fat, carbs } = splitMacros(targetCalories, weightKg, goalMode);

  return {
    bmr,
    maintenance,
    targetCalories,
    protein,
    fat,
    carbs,
    activity,
    goalMode,
    pace,
    rateKgPerWeek,
    requestedRateKgPerWeek,
    paceLimited,
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

  // Both dates are local noon; round (not floor) so the 23h/25h day around a
  // DST switch doesn't shave a day off the streak until the clocks change back.
  const diffInDays = Math.round((referenceDate.getTime() - startDate.getTime()) / DAY_IN_MS);
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

  // Manual Latin months: toLocaleDateString("sr-RS", { month: "long" }) returns
  // Cyrillic ("септембар") in V8/ICU, clashing with the app's Latin script.
  return `${parsedDate.getDate()}. ${SR_MONTHS_LATIN[parsedDate.getMonth()]} ${parsedDate.getFullYear()}.`;
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

function getRoutineSummaryForDay(weekday, weekTrack = state.selectedWeekTrack) {
  const habits = getWeeklyHabits();
  const streakHabits = getStreakHabits();
  const tasks = getTasksForDay(weekday, weekTrack);
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

// Stable id for the current week = the date of this week's Monday. Used so that
// per-weekday completion marks reset once a week instead of persisting on the
// same weekday forever.
function getCurrentWeekId() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((day + 6) % 7));
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
}

// Pure function of the real calendar date: alternates 0/1 every 7 real days,
// forever, with no stored anchor. Uses a plain UTC day-count from a fixed
// epoch Monday (not getISOWeek()-style logic) so it can't drift at
// year/DST boundaries the way locale-based week numbering can.
function getCurrentWeekTrack() {
  const now = new Date();
  const day = now.getDay();
  const mondayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - ((day + 6) % 7));
  const daysSinceEpoch = Math.round((mondayUtc - WEEK_TRACK_EPOCH_MONDAY_UTC) / DAY_IN_MS);
  const weeksSinceEpoch = Math.floor(daysSinceEpoch / 7);
  return ((weeksSinceEpoch % 2) + 2) % 2; // non-negative modulo
}

function normalizeWeekTrack(value) {
  return toNumber(value) === 1 ? 1 : 0;
}

// UI display order for the two tracks: current week always first, so "Ova
// nedelja" never appears after "Sledeća nedelja" just because the physical
// track index happens to be 1 this real week.
function getWeekTrackDisplayOrder() {
  const current = getCurrentWeekTrack();
  return [current, 1 - current];
}

// "Ova nedelja" / "Sledeća nedelja" — never hardcode which physical track this
// means; it's whichever equals getCurrentWeekTrack() right now, and that
// mapping flips every real week (intentional).
function getWeekTrackLabel(weekTrack) {
  return weekTrack === getCurrentWeekTrack() ? "Ova nedelja" : "Sledeća nedelja";
}

// When a new week starts, clear this-week's completion marks so the new week
// doesn't start pre-checked with last week's state. Returns true if it changed
// anything (so the caller can persist). Leaves dated history (training/weight
// logs, measurements), streaks and one-off day tasks untouched.
function ensureCurrentWeek() {
  const weekId = getCurrentWeekId();
  store.meta = store.meta || {};
  if (store.meta.weekId === weekId) {
    return false;
  }
  (store.weeklyPlanEntries || []).forEach((entry) => {
    entry.done = false;
  });
  (store.supplements || []).forEach((supplement) => {
    supplement.completions = {};
  });
  (store.habits || []).forEach((habit) => {
    if (habit.trackingMode !== "streak") {
      habit.completions = {};
    }
  });
  store.trainingCompletionsByWeekday = {};
  store.trainingBurnByWeekday = {};
  store.trainingSectionBurnByWeekday = {};
  store.meta.weekId = weekId;
  return true;
}

function getTrainingCompletionBucket(weekday) {
  const normalizedWeekday = String(weekday || "").trim();
  if (!normalizedWeekday) {
    return {};
  }
  const bucket = store.trainingCompletionsByWeekday?.[normalizedWeekday];
  return bucket && typeof bucket === "object" ? bucket : {};
}

function isTrainingExerciseCompleted(weekday, templateId, exerciseId) {
  if (!weekday || !templateId || !exerciseId) {
    return false;
  }
  return Boolean(getTrainingCompletionBucket(weekday)?.[templateId]?.[exerciseId]);
}

// ---------------------------------------------------------------------------
// Progresija opterećenja — the training side of the closed loop the nutrition
// tab already has. The plan states a rep range ("3-4 serije, 8-12 ponavljanja")
// and the log states what was actually lifted; when the top of the range is
// reached twice at the same weight, the load is ready to go up. Nothing moves
// on its own — this only ever renders a suggestion.
// ---------------------------------------------------------------------------

// "8-12 ponavljanja" / "3x8-12" / "10 ponavljanja" → { min, max }
function parseRepRange(details) {
  const text = String(details || "").toLowerCase();
  const range = text.match(/(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*(?:ponav|rep|x\b)/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (min > 0 && max >= min && max <= 100) {
      return { min, max };
    }
  }
  const single = text.match(/(\d{1,3})\s*ponav/);
  if (single) {
    const value = Number(single[1]);
    if (value > 0 && value <= 100) {
      return { min: value, max: value };
    }
  }
  return null;
}

// The reps field is free text ("4x8", "12, 11, 10", "8"). The best set is what
// decides whether the top of the range was reached, so take the largest number
// that is not the set count in a "4x8" style prefix.
function parseRepsAchieved(repsText) {
  const text = String(repsText || "").toLowerCase().replace(/,/g, " ");
  const cross = text.match(/(\d{1,3})\s*[x×]\s*(\d{1,3})/);
  if (cross) {
    return Number(cross[2]);
  }
  const numbers = (text.match(/\d{1,3}/g) || []).map(Number).filter((n) => n > 0 && n <= 100);
  return numbers.length ? Math.max(...numbers) : 0;
}

// Big compound lifts move in 5 kg steps, everything else in 2.5 kg.
const BIG_LIFT_PATTERN = /(cucanj|celni cucanj|mrtvo|potisak nogama|leg press|hip thrust|zgib sa tegom|veslanje sa sipkom)/;

function progressionStepFor(exerciseName) {
  return BIG_LIFT_PATTERN.test(normalizeLookupValue(exerciseName)) ? 5 : 2.5;
}

function getExerciseProgression(exerciseName, details) {
  const range = parseRepRange(details);
  const key = String(exerciseName || "").trim().toLowerCase();
  if (!range || !key) {
    return null;
  }
  const logs = [...(store.trainingProgressLogs || [])]
    .filter((log) => String(log.exerciseName || "").trim().toLowerCase() === key && toNumber(log.weightKg) > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  if (!logs.length) {
    return { kind: "none", range };
  }
  const last = logs[logs.length - 1];
  const previous = logs[logs.length - 2];
  const lastWeight = roundValue(toNumber(last.weightKg), 1);
  const lastReps = parseRepsAchieved(last.reps);
  const atTop = lastReps >= range.max;
  const previousAtTop =
    previous && roundValue(toNumber(previous.weightKg), 1) === lastWeight && parseRepsAchieved(previous.reps) >= range.max;

  if (atTop && previousAtTop) {
    const step = progressionStepFor(exerciseName);
    return { kind: "increase", range, lastWeight, lastReps, step, nextWeight: roundValue(lastWeight + step, 1) };
  }
  if (atTop) {
    return { kind: "almost", range, lastWeight, lastReps };
  }
  return { kind: "hold", range, lastWeight, lastReps };
}

function renderExerciseProgression(exerciseName, details) {
  const progression = getExerciseProgression(exerciseName, details);
  if (!progression || progression.kind === "none") {
    return "";
  }
  if (progression.kind === "increase") {
    return `<div class="training-progression is-up">Dva puta ${progression.range.max} ponavljanja na ${progression.lastWeight} kg — probaj <strong>${progression.nextWeight} kg</strong>.</div>`;
  }
  if (progression.kind === "almost") {
    return `<div class="training-progression">Vrh opsega na ${progression.lastWeight} kg. Ponovi to još jednom pa diži kilažu.</div>`;
  }
  return `<div class="training-progression">Poslednje: ${progression.lastWeight} kg × ${progression.lastReps}. Cilj je ${progression.range.max} ponavljanja pre nego što dodaš kilažu.</div>`;
}

// Rest timer. A whole-tab re-render every second would be absurd for a clock,
// so the tick writes straight into the button and render() just repaints once.
const REST_TIMER_SECONDS = 90;
let restTimer = null;
let restTimerInterval = null;

function formatRestClock(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function paintRestTimers() {
  const remaining = restTimer ? Math.ceil((restTimer.endsAt - Date.now()) / 1000) : 0;
  document.querySelectorAll("[data-rest-key]").forEach((button) => {
    const isActive = Boolean(restTimer) && button.dataset.restKey === restTimer.key && remaining > 0;
    button.classList.toggle("is-running", isActive);
    const label = button.querySelector(".training-rest-label");
    if (label) {
      label.textContent = isActive ? formatRestClock(remaining) : "Odmor";
    }
    button.setAttribute("aria-label", isActive ? `Odmor, još ${formatRestClock(remaining)}` : "Pokreni odmor");
  });
}

function stopRestTimer() {
  restTimer = null;
  if (restTimerInterval) {
    window.clearInterval(restTimerInterval);
    restTimerInterval = null;
  }
  paintRestTimers();
}

function startRestTimer(key) {
  restTimer = { key, endsAt: Date.now() + REST_TIMER_SECONDS * 1000 };
  if (!restTimerInterval) {
    restTimerInterval = window.setInterval(() => {
      if (!restTimer) {
        stopRestTimer();
        return;
      }
      if (restTimer.endsAt - Date.now() <= 0) {
        stopRestTimer();
        announce("Odmor je gotov.");
        return;
      }
      paintRestTimers();
    }, 500);
  }
  paintRestTimers();
}

function getTrainingTemplateCompletionCount(template, weekday = state.selectedWeekday) {
  const exercises = Array.isArray(template?.exercises) ? template.exercises : [];
  const completedCount = exercises.filter((exercise) => isTrainingExerciseCompleted(weekday, template?.id, exercise.id)).length;
  return {
    completedCount,
    totalCount: exercises.length,
  };
}

// The training is "done" when every exercise in it is checked — the same rule
// meals use, so there is no second source of truth to drift out of sync.
function setTrainingTemplateCompletion(weekday, template, done) {
  const exercises = Array.isArray(template?.exercises) ? template.exercises : [];
  if (!weekday || !template?.id || !exercises.length) {
    return;
  }
  const weekdayBucket = { ...(store.trainingCompletionsByWeekday?.[weekday] || {}) };
  if (done) {
    weekdayBucket[template.id] = Object.fromEntries(exercises.map((exercise) => [exercise.id, true]));
  } else {
    delete weekdayBucket[template.id];
  }
  store.trainingCompletionsByWeekday = store.trainingCompletionsByWeekday || {};
  if (Object.keys(weekdayBucket).length) {
    store.trainingCompletionsByWeekday[weekday] = weekdayBucket;
  } else {
    delete store.trainingCompletionsByWeekday[weekday];
  }
  persist();
}

function toggleTrainingExerciseCompletion(weekday, templateId, exerciseId) {
  if (!weekday || !templateId || !exerciseId) {
    return;
  }

  const weekdayBucket = {
    ...(store.trainingCompletionsByWeekday?.[weekday] || {}),
  };
  const templateBucket = {
    ...(weekdayBucket[templateId] || {}),
  };

  if (templateBucket[exerciseId]) {
    delete templateBucket[exerciseId];
  } else {
    templateBucket[exerciseId] = true;
  }

  if (Object.keys(templateBucket).length) {
    weekdayBucket[templateId] = templateBucket;
  } else {
    delete weekdayBucket[templateId];
  }

  if (Object.keys(weekdayBucket).length) {
    store.trainingCompletionsByWeekday[weekday] = weekdayBucket;
  } else {
    delete store.trainingCompletionsByWeekday[weekday];
  }
}

// Kalorije treninga. Na danima sa planom se kuca po sekcijama (trening, stomak,
// kardio) i ukupno je njihov zbir; „Potrošnja sa sata“ ostaje ispod i važi samo
// kad nijedna sekcija nije upisana (tako uvoz sa sata i dalje radi za dane kad
// ne kucaš ništa). Na danima bez plana nema šta da se deli na sekcije, pa se
// prikazuje samo polje sa sata — kao i pre.
function renderTrainingBurnSection(templates) {
  const weekday = state.selectedWeekday;
  const hasTraining = templates.length > 0;
  const sections = getTrainingSectionBurns(weekday);
  const sectionTotal = getTrainingSectionBurnTotal(weekday);
  const watchBurn = getWatchBurnForDay(weekday);
  const resolved = getTrainingBurnForDay(weekday);
  const watchField = `
          <div class="field">
            <label for="training-burn-kcal">Potrošnja sa sata</label>
            <input
              id="training-burn-kcal"
              name="burnKcal"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              placeholder="npr. 540"
              value="${watchBurn ? roundValue(watchBurn, 0) : ""}"
            />
          </div>`;
  return `
      <details class="form-collapse training-burn-collapse" ${resolved > 0 ? "open" : ""}>
        <summary>
          <span class="form-collapse-title">Kalorije treninga</span>
          ${resolved > 0 ? `<span class="pill strong">${roundValue(resolved, 0)} kcal</span>` : ""}
          <span class="form-collapse-icon" aria-hidden="true">+</span>
        </summary>
        <p class="footer-note training-burn-intro">${
          hasTraining
            ? "Upiši kalorije po delovima treninga — ukupno je njihov zbir i to ulazi u neto unos na „Danas“."
            : "Nema plana za ovaj dan, pa nema šta da se deli na sekcije. Upiši ukupnu potrošnju (Apple Watch i sl.) da Danas prikaže neto unos."
        }</p>
        <form id="training-burn-form" class="form-grid split training-burn-form">
          ${
            hasTraining
              ? `
          <div class="form-grid-3">
            ${sections
              .map(
                (section) => `
              <div class="field">
                <label for="training-burn-${section.id}">${escapeHtml(section.label)}</label>
                <input
                  id="training-burn-${section.id}"
                  name="section-${section.id}"
                  type="number"
                  min="0"
                  max="5000"
                  step="1"
                  inputmode="numeric"
                  placeholder="kcal"
                  value="${section.kcal || ""}"
                />
              </div>`
              )
              .join("")}
          </div>
          <p class="footer-note field--full training-burn-total">${
            sectionTotal > 0
              ? `Ukupno sa treninga: <strong>${sectionTotal} kcal</strong> — ${sections
                  .filter((section) => section.kcal > 0)
                  .map((section) => `${escapeHtml(section.label.toLowerCase())} ${section.kcal}`)
                  .join(" + ")}. Ovo ulazi u neto unos na „Danas“.`
              : `Dok su sva tri prazna, u neto unos ide broj sa sata ispod.`
          }</p>`
              : ""
          }
          ${watchField}
          <div class="training-burn-actions">
            <button class="solid-button secondary-button training-burn-submit" type="submit">Sačuvaj kcal</button>
          </div>
        </form>
      </details>`;
}

function getWeeklyTrainingPlan(weekTrack = state.selectedWeekTrack) {
  return WEEKDAYS.map((weekday) => ({
    weekday,
    templates: getTrainingForDay(weekday, weekTrack),
    trainingBurn: weekTrack === getCurrentWeekTrack() ? getTrainingBurnForDay(weekday) : 0,
    progressCount: store.trainingProgressLogs.filter((log) => log.weekday === weekday).length,
    completedExerciseCount: getTrainingForDay(weekday, weekTrack).reduce(
      (count, template) => count + getTrainingTemplateCompletionCount(template, weekday).completedCount,
      0
    ),
    totalExerciseCount: getTrainingForDay(weekday, weekTrack).reduce(
      (count, template) => count + getTrainingTemplateCompletionCount(template, weekday).totalCount,
      0
    ),
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
        imageUrl: state.favoriteDraft.imageUrl,
        servings: state.favoriteDraft.servings,
        prepTimeMinutes: state.favoriteDraft.prepTimeMinutes,
        instructions: state.favoriteDraft.instructions,
        items: [...(state.favoriteDraft.items || [])],
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
    imageUrl: preservedDraft?.imageUrl || "",
    servings: preservedDraft?.servings || "1",
    prepTimeMinutes: preservedDraft?.prepTimeMinutes || "",
    instructions: preservedDraft?.instructions || "",
    items: preservedDraft?.items || [],
    foodId: "",
    grams: "",
  };
}

function buildFavoriteDraftItems(items = []) {
  return (items || []).map((item) => ({
    id: item.id || uid("favorite-item"),
    foodId: item.foodId || "",
    foodName: item.foodName || "",
    displayName: item.displayName || item.foodName || "",
    grams: item.grams ? String(roundValue(item.grams, 0)) : "",
  }));
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
    imageUrl: normalizedFavorite.imageUrl || "",
    servings: String(normalizedFavorite.servings || 1),
    prepTimeMinutes: normalizedFavorite.prepTimeMinutes ? String(normalizedFavorite.prepTimeMinutes) : "",
    instructions: normalizedFavorite.instructions || "",
    items: buildFavoriteDraftItems(normalizedFavorite.items),
    foodId: item.foodId || "",
    grams: item.grams ? String(roundValue(item.grams, 0)) : "",
    // Stored items are always real grams — editing starts in "g" rather
    // than guessing which spoon size the original amount came from.
    amountUnit: "g",
  };
}

function setFavoriteDraftFromRecipe(favorite) {
  const normalizedFavorite = normalizeFavoriteMealRecord(favorite);
  state.favoriteDraft = {
    favoriteName: normalizedFavorite.name || "",
    mealLabel: normalizedFavorite.mealLabel || "",
    description: normalizedFavorite.description || "",
    imageUrl: normalizedFavorite.imageUrl || "",
    servings: String(normalizedFavorite.servings || 1),
    prepTimeMinutes: normalizedFavorite.prepTimeMinutes ? String(normalizedFavorite.prepTimeMinutes) : "",
    instructions: normalizedFavorite.instructions || "",
    items: buildFavoriteDraftItems(normalizedFavorite.items),
    foodId: "",
    grams: "",
  };
  state.editingFavoriteItem = { favoriteId: favorite.id, itemId: "", itemIndex: -1 };
}

// Sažetak recepta u izradi. Odvojen u svoju funkciju jer se pri kucanju
// količine osvežava sam, bez render()-a: cela aplikacija se renderuje kroz
// innerHTML, pa bi pun render na svaki karakter izbacio kursor iz polja.
function renderRecipeDraftSummaryInner(preview) {
  const meta = [
    preview.mealLabel || "Tip obroka nije izabran",
    `${preview.servings} ${srPlural(preview.servings, "porcija", "porcije", "porcija")}`,
    preview.prepTimeMinutes ? `${preview.prepTimeMinutes} min pripreme` : "",
  ].filter(Boolean);
  return `
    <div class="recipe-draft-summary">
      <div class="recipe-draft-summary-main">
        <span class="recipe-draft-summary-label">Po porciji</span>
        <strong class="recipe-draft-summary-value">${roundValue(preview.perServingTotals.kcal, 0)}<span>kcal</span></strong>
      </div>
      <dl class="recipe-draft-summary-macros">
        <div><dt>P</dt><dd>${roundValue(preview.perServingTotals.protein, 1)} g</dd></div>
        <div><dt>UH</dt><dd>${roundValue(preview.perServingTotals.carbs, 1)} g</dd></div>
        <div><dt>M</dt><dd>${roundValue(preview.perServingTotals.fat, 1)} g</dd></div>
      </dl>
      <div class="recipe-draft-summary-note">${escapeHtml(meta.join(" · "))} · ukupno ${roundValue(preview.totals.kcal, 0)} kcal</div>
    </div>`;
}

// Količina se menja u polju koje ostaje na ekranu, pa se osvežavaju samo
// brojke: sažetak u celosti (u njemu nema polja) i kcal po stavci tekstualno.
function syncRecipeDraftPreview() {
  const summary = document.querySelector("#recipe-draft-summary");
  if (!summary) {
    return;
  }
  const preview = getFavoriteDraftPreview();
  summary.innerHTML = renderRecipeDraftSummaryInner(preview);
  preview.items.forEach((item) => {
    const cell = document.querySelector(`[data-recipe-draft-item-kcal="${item.id}"]`);
    if (cell) {
      cell.textContent = `${roundValue(item.totals.kcal, 0)} kcal`;
    }
  });
}

function getFavoriteDraftPreview() {
  const favoriteName = String(state.favoriteDraft.favoriteName || "").trim();
  const mealLabel = String(state.favoriteDraft.mealLabel || "").trim();
  const hasDraftDescription = state.favoriteDraft.description !== "";
  const hasDraftImage = state.favoriteDraft.imageUrl !== "";
  const hasDraftInstructions = state.favoriteDraft.instructions !== "";
  const hasDraftServings = state.favoriteDraft.servings !== "";
  const hasDraftPrepTime = state.favoriteDraft.prepTimeMinutes !== "";
  const description = String(state.favoriteDraft.description || "").trim();
  const imageUrl = String(state.favoriteDraft.imageUrl || "").trim();
  const instructions = String(state.favoriteDraft.instructions || "").trim();
  const servings = Math.max(1, roundValue(toNumber(state.favoriteDraft.servings || 1), 0)) || 1;
  const prepTimeMinutes = toNumber(state.favoriteDraft.prepTimeMinutes);
  const food = getFoodById(state.favoriteDraft.foodId);
  const grams = toNumber(state.favoriteDraft.grams);
  const existingFavorite =
    (state.editingFavoriteItem.favoriteId ? store.favoriteMeals.find((entry) => entry.id === state.editingFavoriteItem.favoriteId) : null) ||
    getFavoriteMealByName(favoriteName);

  let items = (state.favoriteDraft.items || []).map((item) => {
    const matchedFood = getFoodById(item.foodId);
    const normalizedGrams = toNumber(item.grams);
    return {
      ...item,
      foodName: matchedFood?.name || item.foodName || item.displayName || "",
      displayName: item.displayName || item.foodName || matchedFood?.name || "",
      grams: normalizedGrams,
      totals: matchedFood ? calculateEntry(matchedFood, normalizedGrams) : { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      isPending: false,
      isMatched: Boolean(matchedFood),
    };
  });

  if (state.editingFavoriteItem.itemId) {
    items = items.filter((item) => item.id !== state.editingFavoriteItem.itemId);
  }

  if (food && grams) {
    items = [
      ...items,
      {
        id: "pending",
        foodId: food.id,
        foodName: food.name,
        displayName: food.name,
        grams,
        totals: calculateEntry(food, grams),
        isPending: true,
        isMatched: true,
      },
    ];
  }

  const totals = getDayTotals(items.map((item) => ({ totals: item.totals })));
  const effectiveServings = hasDraftServings ? servings : existingFavorite?.servings || 1;

  return {
    favoriteName,
    mealLabel: mealLabel || existingFavorite?.mealLabel || "",
    description: hasDraftDescription ? description : existingFavorite?.description || "",
    imageUrl: hasDraftImage ? imageUrl : existingFavorite?.imageUrl || "",
    instructions: hasDraftInstructions ? instructions : existingFavorite?.instructions || "",
    servings: effectiveServings,
    prepTimeMinutes: hasDraftPrepTime ? (prepTimeMinutes || null) : existingFavorite?.prepTimeMinutes || null,
    items,
    totals,
    perServingTotals: divideTotals(totals, effectiveServings),
  };
}

function buildFavoriteItemsPayload(includePendingDraft = false) {
  const recipeItems = (state.favoriteDraft.items || [])
    .map((item) => {
      const normalizedFoodId = String(item.foodId || "").trim();
      const normalizedGrams = toNumber(item.grams);
      const food = getFoodById(normalizedFoodId);
      if (!food || !normalizedGrams) {
        return null;
      }

      return {
        id: item.id || uid("favorite-item"),
        foodId: food.id,
        foodName: food.name,
        displayName: item.displayName || item.foodName || food.name,
        grams: normalizedGrams,
      };
    })
    .filter(Boolean);

  if (!includePendingDraft) {
    return recipeItems;
  }

  const pendingFood = getFoodById(state.favoriteDraft.foodId);
  const pendingGrams = toNumber(state.favoriteDraft.grams);
  if (!pendingFood || !pendingGrams) {
    return recipeItems;
  }

  if (state.editingFavoriteItem.itemId) {
    return recipeItems.map((item) =>
      item.id === state.editingFavoriteItem.itemId
        ? {
            ...item,
            foodId: pendingFood.id,
            foodName: pendingFood.name,
            displayName: pendingFood.name,
            grams: pendingGrams,
          }
        : item
    );
  }

  return [
    ...recipeItems,
    {
      id: uid("favorite-item"),
      foodId: pendingFood.id,
      foodName: pendingFood.name,
      displayName: pendingFood.name,
      grams: pendingGrams,
    },
  ];
}

function getRecipeDraftItemSuggestedFood(item = {}) {
  const currentFoodId = String(item.foodId || "").trim();
  const candidateName = String(item.displayName || item.foodName || "").trim();
  if (!candidateName) {
    return null;
  }

  const suggestedFood = findBestFoodMatchByName(candidateName);
  if (!suggestedFood || suggestedFood.id === currentFoodId) {
    return null;
  }

  return suggestedFood;
}

function saveFavoriteMealMetadata(payload = {}) {
  const normalizedFavoriteName = String(payload.favoriteName || "").trim();
  const normalizedMealLabel = normalizeMealLabel(String(payload.mealLabel || "").trim());
  const normalizedDescription = String(payload.description || "").trim();
  const normalizedImageUrl = String(payload.imageUrl || "").trim();
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
    imageUrl: normalizedImageUrl,
    instructions: normalizedInstructions,
    servings: normalizedServings,
    prepTimeMinutes: normalizedPrepTimeMinutes > 0 ? roundValue(normalizedPrepTimeMinutes, 0) : null,
    updatedAt: new Date().toISOString(),
  };

  const existingFavorite = state.editingFavoriteItem.favoriteId
    ? store.favoriteMeals.find((entry) => entry.id === state.editingFavoriteItem.favoriteId)
    : getFavoriteMealByName(normalizedFavoriteName);

  if (existingFavorite) {
    const imageChanged = existingFavorite.imageUrl !== normalizedImageUrl;
    Object.assign(existingFavorite, recipeDetails);
    if (!Array.isArray(existingFavorite.items)) {
      existingFavorite.items = [];
    }
    if (imageChanged) {
      // Keep the new base64 in localStorage until reconcilePhotos has written
      // it to IndexedDB (the stored id would otherwise strip it prematurely).
      photoIdsInIdb.delete(getRecipeImageKey(existingFavorite.id));
      reconcilePhotos();
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
  if (isInlineImageData(nextFavorite.imageUrl)) {
    reconcilePhotos();
  }
  return nextFavorite;
}

function saveFavoriteMealDraft(payload = {}) {
  const favorite = saveFavoriteMealMetadata(payload);
  const items = Array.isArray(payload.items) ? payload.items : [];

  if (!favorite || !items.length) {
    return false;
  }

  favorite.items = items.map((item) => ({
    id: item.id || uid("favorite-item"),
    foodId: item.foodId,
    foodName: item.foodName,
    displayName: item.displayName || item.foodName,
    grams: item.grams,
  }));
  favorite.updatedAt = new Date().toISOString();
  return true;
}

function resetPlanDraft() {
  state.editingEntryId = "";
  state.planDraft = {
    mealLabel: "",
    foodId: "",
    grams: "",
    amountUnit: "g",
  };
}

function setPlanDraftFromEntry(entry) {
  state.editingEntryId = entry.id;
  state.editingMealLabel = entry.mealLabel || "";
  expandMealForWeekday(entry.weekday || state.selectedWeekday, entry.mealLabel);
  state.planDraft = {
    mealLabel: entry.mealLabel || "",
    foodId: entry.foodId || "",
    grams: entry.grams ? String(roundValue(entry.grams, 0)) : "",
    // Stored entries are always real grams — edits start in "g" rather than
    // guessing which spoon size the original amount might round-trip to.
    amountUnit: "g",
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
  const baseEntries = getPlanEntriesForDay(state.selectedWeekday, state.selectedWeekTrack).filter((entry) => entry.id !== state.editingEntryId);
  const totals = getDayTotals(baseEntries);
  const draftTotals = getDraftTotals();
  return {
    kcal: totals.kcal + draftTotals.kcal,
    protein: totals.protein + draftTotals.protein,
    carbs: totals.carbs + draftTotals.carbs,
    fat: totals.fat + draftTotals.fat,
  };
}

function getMealEntriesForWeekday(weekday, mealLabel, weekTrack = state.selectedWeekTrack) {
  const normalizedMealLabel = normalizeMealLabel(mealLabel);
  return store.weeklyPlanEntries.filter(
    (entry) =>
      entry.weekday === weekday &&
      normalizeMealLabel(entry.mealLabel) === normalizedMealLabel &&
      normalizeWeekTrack(entry.weekTrack) === weekTrack
  );
}

// Meal prep ("kuvaj unapred"): from the meal in the selected day, work out which
// days the batch covers and how much to cook in total. "next" mode = the current
// day plus the following (prepDays - 1) weekdays (wrapping the week); "pick" mode
// = the explicitly chosen weekdays. Returns target days (to copy into) and the
// per-food cook totals across every day the meal will exist (source included).
function getMealPrepPlan(mealLabel) {
  const sourceDay = state.selectedWeekday;
  const sourceWeekTrack = state.selectedWeekTrack;
  const sourceEntries = getMealEntriesForWeekday(sourceDay, mealLabel, sourceWeekTrack);
  const sourceIdx = WEEK_TRACK_CYCLE.findIndex((slot) => slot.weekday === sourceDay && slot.weekTrack === sourceWeekTrack);

  let targetDays; // array of {weekday, weekTrack}
  if (state.prepMode === "pick") {
    targetDays = (state.prepPickDays || []).filter(
      (pick) => !(pick.weekday === sourceDay && pick.weekTrack === sourceWeekTrack) && WEEKDAYS.includes(pick.weekday)
    );
  } else {
    const extraDays = Math.max(1, roundValue(toNumber(state.prepDays) || 2, 0)) - 1;
    targetDays = [];
    for (let i = 1; i <= extraDays; i += 1) {
      targetDays.push(WEEK_TRACK_CYCLE[(sourceIdx + i) % WEEK_TRACK_CYCLE.length]);
    }
  }

  const totalDays = targetDays.length + 1;
  const cookMap = new Map();
  sourceEntries.forEach((entry) => {
    const food = getFoodById(entry.foodId) || store.foods.find((item) => item.name === entry.foodName);
    const key = entry.foodId || entry.foodName;
    const existing = cookMap.get(key);
    const addGrams = toNumber(entry.grams) * totalDays;
    if (existing) {
      existing.totalGrams += addGrams;
    } else {
      cookMap.set(key, {
        name: entry.foodName,
        unit: food ? getFoodServingUnit(food) : "grams",
        totalGrams: addGrams,
      });
    }
  });

  return { sourceDay, sourceWeekTrack, sourceEntries, targetDays, totalDays, cookItems: [...cookMap.values()] };
}

// Two meal slots are "the same prepped meal" when they share a meal label and an
// identical set of foods + grams. Powers the "Spremljeno za N dana" badge — fully
// derived from the plan, so it self-corrects the moment one day is edited.
function getMealEntrySignature(entries) {
  return (entries || [])
    .filter((entry) => toNumber(entry.grams) > 0)
    .map((entry) => `${entry.foodId || entry.foodName}:${roundValue(toNumber(entry.grams), 1)}`)
    .sort()
    .join("|");
}

function getMealPrepBadgeCount(mealLabel, mealEntries) {
  const signature = getMealEntrySignature(mealEntries);
  if (!signature) {
    return 0;
  }
  const normalizedLabel = normalizeMealLabel(mealLabel);
  return WEEKDAYS.reduce((count, day) => {
    const dayEntries = getMealEntriesForWeekday(day, normalizedLabel);
    return dayEntries.length && getMealEntrySignature(dayEntries) === signature ? count + 1 : count;
  }, 0);
}

function applyFavoriteMealToDay(favorite, options = {}) {
  if (!favorite?.items?.length) {
    return false;
  }

  const weekday = options.weekday || state.selectedWeekday;
  const weekTrack = options.weekTrack ?? state.selectedWeekTrack;
  const targetMealLabel = normalizeMealLabel(options.mealLabel || favorite.mealLabel || favorite.name);
  const mode = options.mode || "append";
  const servings = getRecipeServingCount(favorite);
  const existingEntries = getMealEntriesForWeekday(weekday, targetMealLabel, weekTrack);

  if (isMealCompletedForWeekday(weekday, targetMealLabel, weekTrack)) {
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
      (entry) =>
        !(entry.weekday === weekday && normalizeWeekTrack(entry.weekTrack) === weekTrack && normalizeMealLabel(entry.mealLabel) === targetMealLabel)
    );
  }

  favorite.items.forEach((item) => {
    store.weeklyPlanEntries.push({
      id: uid("plan"),
      weekday,
      weekTrack,
      mealLabel: targetMealLabel,
      foodId: item.foodId,
      foodName: item.foodName,
      grams: Math.max(0.1, roundValue(toNumber(item.grams) / servings, 1)),
      done: false,
    });
  });

  expandMealForWeekday(weekday, targetMealLabel);
  return true;
}

function getRecipeApplyMealOptions(favorite) {
  const recipeMealLabel = normalizeMealLabel(favorite?.mealLabel || favorite?.name || "");
  return mergeUniqueStrings([...defaultMeals, ...(recipeMealLabel ? [recipeMealLabel] : [])]);
}

function openRecipeApplyDialog(favorite) {
  if (!favorite) {
    return;
  }

  const mealOptions = getRecipeApplyMealOptions(favorite);
  const suggestedMeal = normalizeMealLabel(favorite.mealLabel || favorite.name || "");
  state.recipeApplyDialog = {
    favoriteId: favorite.id,
    weekday: state.selectedWeekday,
    weekTrack: state.selectedWeekTrack,
    mealLabel: mealOptions.includes(suggestedMeal) ? suggestedMeal : mealOptions[0] || defaultMeals[0],
  };
}

function closeRecipeApplyDialog() {
  state.recipeApplyDialog = {
    favoriteId: "",
    weekday: "",
    weekTrack: "",
    mealLabel: "",
  };
}

function renderRecipeApplyDialog() {
  const favoriteId = String(state.recipeApplyDialog.favoriteId || "").trim();
  if (!favoriteId) {
    return "";
  }

  const favorite = store.favoriteMeals.find((entry) => entry.id === favoriteId);
  if (!favorite) {
    return "";
  }
  const favoriteDetailed = getFavoriteMealsDetailed().find((entry) => entry.id === favoriteId) || favorite;

  const mealOptions = getRecipeApplyMealOptions(favorite);
  const selectedWeekday = state.recipeApplyDialog.weekday || state.selectedWeekday;
  const selectedWeekTrack = normalizeWeekTrack(
    state.recipeApplyDialog.weekTrack === "" || state.recipeApplyDialog.weekTrack == null
      ? state.selectedWeekTrack
      : state.recipeApplyDialog.weekTrack
  );
  const selectedMealLabel = state.recipeApplyDialog.mealLabel || mealOptions[0] || defaultMeals[0];

  return `
    <div class="app-dialog-shell">
      <button class="app-dialog-backdrop" type="button" data-action="close-recipe-apply-dialog" aria-label="Zatvori dijalog"></button>
      <section class="app-dialog recipe-apply-dialog" role="dialog" aria-modal="true" aria-labelledby="recipe-apply-title">
        <div class="app-dialog-head">
          <div class="stack" style="gap:4px;">
            <div class="hero-picker-label">Dodaj recept</div>
            <h3 id="recipe-apply-title">${escapeHtml(favorite.name)}</h3>
            <p>Izaberi dan i obrok u koji želiš da dodaš ovu ${favorite.servings > 1 ? "porciju recepta" : "stavku"}.</p>
          </div>
          <button class="ghost-button menu-close" type="button" data-action="close-recipe-apply-dialog" aria-label="Zatvori dijalog">
            ${renderMenuToggleIcon(true)}
          </button>
        </div>
        <form id="recipe-apply-form" class="stack" style="gap:16px;">
          <input type="hidden" name="favoriteId" value="${favorite.id}" />
          <div class="form-grid recipe-apply-grid">
            <label>
              <span>Dan</span>
              <select name="weekday">
                ${WEEKDAYS.map((weekday) => `<option value="${weekday}" ${weekday === selectedWeekday ? "selected" : ""}>${weekdayLabel(weekday)}</option>`).join("")}
              </select>
            </label>
            <label>
              <span>Nedelja</span>
              <select name="weekTrack">
                ${getWeekTrackDisplayOrder().map((track) => `<option value="${track}" ${track === selectedWeekTrack ? "selected" : ""}>${getWeekTrackLabel(track)}</option>`).join("")}
              </select>
            </label>
            <label>
              <span>Obrok</span>
              <select name="mealLabel">
                ${mealOptions.map((mealLabel) => `<option value="${escapeHtml(mealLabel)}" ${mealLabel === selectedMealLabel ? "selected" : ""}>${escapeHtml(mealLabel)}</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="pill-row">
            <span class="pill">${favorite.items.length} ${srPlural(favorite.items.length, "sastojak", "sastojka", "sastojaka")}</span>
            <span class="pill">${favorite.servings || 1} ${favorite.servings === 1 ? "porcija" : favorite.servings < 5 ? "porcije" : "porcija"}</span>
            <span class="pill note">Po porciji ${roundValue((favoriteDetailed.perServingTotals || favoriteDetailed.totals || {}).kcal || 0, 0)} kcal</span>
          </div>
          <div class="entry-actions recipe-apply-actions">
            <button class="ghost-button" type="button" data-action="close-recipe-apply-dialog">Odustani</button>
            <button class="solid-button secondary-button button-with-icon" type="submit">
              ${renderButtonContent("Dodaj u plan", "apply")}
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

// --- Barcode scanning + shared food database ------------------------------

function nutNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

let barcodeReaderPromise = null;
let activeScanControls = null;

function getBarcodeReader() {
  if (!barcodeReaderPromise) {
    barcodeReaderPromise = import("https://esm.sh/@zxing/browser@0.1.5")
      .then((mod) => {
        // Use raw ZXing enum values so we only need this one (reliable) import.
        // DecodeHintType: POSSIBLE_FORMATS = 2, TRY_HARDER = 3.
        // BarcodeFormat: CODE_39 = 2, CODE_128 = 4, EAN_8 = 6, EAN_13 = 7, UPC_A = 14, UPC_E = 15.
        const hints = new Map();
        hints.set(2, [7, 6, 14, 15, 4, 2]);
        hints.set(3, true);
        return new mod.BrowserMultiFormatReader(hints);
      })
      .catch((error) => {
        barcodeReaderPromise = null;
        throw error;
      });
  }
  return barcodeReaderPromise;
}

// The video element's srcObject is set directly by ZXing, so this is the
// only way to reach the live track for torch/focus control without going
// through a full render() (which would tear down and reattach the stream).
function getScannerVideoTrack() {
  const video = document.querySelector("#barcode-video");
  const stream = video && video.srcObject;
  return stream instanceof MediaStream ? stream.getVideoTracks()[0] || null : null;
}

// Torch is Chrome/Android-only (no Safari support at all), so the button
// stays hidden by default and only reveals itself once we've confirmed the
// live track actually supports it — pure DOM toggle, no render().
function syncScannerTorchButton() {
  const track = getScannerVideoTrack();
  const capabilities = track && typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
  state.scannerTorchSupported = Boolean(capabilities.torch);
  state.scannerTorchOn = false;
  const torchBtn = document.querySelector("#scanner-torch-btn");
  if (torchBtn) {
    torchBtn.hidden = !state.scannerTorchSupported;
    torchBtn.classList.remove("is-active");
  }
}

async function startBarcodeScan() {
  const video = document.querySelector("#barcode-video");
  if (!video) {
    return;
  }
  try {
    const reader = await getBarcodeReader();
    const onResult = (result) => {
      if (!result) {
        return;
      }
      const text = typeof result.getText === "function" ? result.getText() : result.text || "";
      stopBarcodeScan();
      handleScannedBarcode(text);
    };
    // Ask for a sharp, high-res feed with continuous autofocus where the
    // browser supports it — low-res/default streams are the main reason
    // barcodes take forever to lock in, especially on multi-lens phones
    // that default to an ultra-wide with poor close-focus.
    const videoConstraints = {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      advanced: [{ focusMode: "continuous" }],
    };
    // Prefer the rear camera on phones; fall back to the default device.
    if (typeof reader.decodeFromConstraints === "function") {
      activeScanControls = await reader.decodeFromConstraints({ video: videoConstraints }, video, onResult);
    } else {
      activeScanControls = await reader.decodeFromVideoDevice(undefined, video, onResult);
    }
    syncScannerTorchButton();
  } catch (error) {
    console.warn("Barcode scan failed", error);
    const name = (error && error.name) || "";
    let msg = "Kamera nije dostupna. Unesi vrednosti ručno.";
    if (name === "NotAllowedError" || name === "SecurityError") {
      msg = "Pristup kameri je odbijen. Dozvoli kameru za ovaj sajt pa probaj ponovo.";
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      msg = "Nije pronađena kamera. Unesi vrednosti ručno.";
    } else if (name === "NotReadableError") {
      msg = "Kamera je zauzeta drugom aplikacijom. Zatvori je pa probaj ponovo.";
    } else if (!barcodeReaderPromise) {
      msg = "Ne mogu da učitam skener (proveri internet). Unesi vrednosti ručno.";
    }
    state.scannerStatus = msg;
    render();
  }
}

// Warm up the scanner library so the first tap can open the camera within
// the user gesture (iOS drops getUserMedia if an await sits before it).
function preloadBarcodeReader() {
  getBarcodeReader().catch(() => {});
}

// Deferred warm-up: a beat after a screen with a scan button appears (Namirnice,
// the meal composer), off the render path and skipped on data-saver connections.
let barcodePreloadTimer = 0;
function schedulePreloadBarcodeReader() {
  if (barcodeReaderPromise || barcodePreloadTimer) {
    return;
  }
  if (navigator.connection && navigator.connection.saveData) {
    return;
  }
  barcodePreloadTimer = window.setTimeout(() => {
    barcodePreloadTimer = 0;
    preloadBarcodeReader();
  }, 1500);
}

function stopBarcodeScan() {
  try {
    if (activeScanControls) {
      activeScanControls.stop();
    }
  } catch (error) {
    /* ignore */
  }
  activeScanControls = null;
}

// Tap-to-focus: nudges the camera's focus point where the user tapped
// (Chrome/Android; a silent no-op elsewhere) and always shows a focus-ring
// pulse so tapping still reads as "doing something" on every browser —
// the pause-and-reaim itself often fixes a hunting autofocus regardless.
function focusScannerAt(viewportEl, clientX, clientY) {
  const rect = viewportEl.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;

  const ring = document.createElement("div");
  ring.className = "scanner-focus-ring";
  ring.style.left = `${localX}px`;
  ring.style.top = `${localY}px`;
  viewportEl.appendChild(ring);
  ring.addEventListener("animationend", () => ring.remove());

  const track = getScannerVideoTrack();
  const capabilities = track && typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
  if (!capabilities.pointsOfInterest) {
    return;
  }
  track
    .applyConstraints({ advanced: [{ pointsOfInterest: [{ x: localX / rect.width, y: localY / rect.height }] }] })
    .catch(() => {
      /* best-effort only */
    });
}

// Open Food Facts product → the app's per-100 g shape (null when it has no name).
function mapOpenFoodFactsProduct(product) {
  if (!product) {
    return null;
  }
  const nutriments = product.nutriments || {};
  let kcal = nutriments["energy-kcal_100g"];
  if (kcal == null && nutriments["energy_100g"] != null) {
    kcal = Number(nutriments["energy_100g"]) / 4.184;
  }
  // Search-a-licious returns `brands` as an array; the product API as a string.
  const brands = Array.isArray(product.brands) ? product.brands.filter(Boolean).join(", ") : String(product.brands || "");
  const productName = product.product_name_sr || product.product_name;
  const cleanName = typeof productName === "string" ? productName.trim() : "";
  // Don't print the brand twice ("Nutella Nutella") when the name already starts with it.
  const brandPrefix = brands && cleanName && !normalizeLookupValue(cleanName).startsWith(normalizeLookupValue(brands.split(",")[0])) ? brands : "";
  const name = [brandPrefix, cleanName].filter(Boolean).join(" ").trim();
  if (!name) {
    return null;
  }
  return {
    code: String(product.code || product._id || "").trim(),
    name,
    kcal: nutNumber(kcal),
    protein: nutNumber(nutriments.proteins_100g),
    carbs: nutNumber(nutriments.carbohydrates_100g),
    fat: nutNumber(nutriments.fat_100g),
  };
}

async function fetchOpenFoodFacts(barcode) {
  try {
    const response = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=code,product_name,product_name_sr,brands,nutriments`
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    if (data.status !== 1 || !data.product) {
      return null;
    }
    return mapOpenFoodFactsProduct(data.product);
  } catch (error) {
    console.warn("Open Food Facts lookup failed", error);
    return null;
  }
}


function sharedFoodRef(barcode) {
  return doc(firebaseDb, "sharedFoods", String(barcode));
}

async function lookupSharedFood(barcode) {
  if (!state.authUser || !barcode) {
    return null;
  }
  try {
    const snapshot = await getDoc(sharedFoodRef(barcode));
    if (!snapshot.exists()) {
      return null;
    }
    const data = snapshot.data();
    return {
      name: data.name || "",
      kcal: nutNumber(data.kcal),
      protein: nutNumber(data.protein),
      carbs: nutNumber(data.carbs),
      fat: nutNumber(data.fat),
    };
  } catch (error) {
    console.warn("Shared food lookup failed", error);
    return null;
  }
}

async function saveSharedFood(barcode, food) {
  if (!state.authUser || !barcode) {
    return;
  }
  try {
    await setDoc(
      sharedFoodRef(barcode),
      {
        barcode: String(barcode),
        name: food.name || "",
        kcal: nutNumber(food.kcal),
        protein: nutNumber(food.protein),
        carbs: nutNumber(food.carbs),
        fat: nutNumber(food.fat),
        updatedAt: serverTimestamp(),
        updatedBy: state.authUser?.uid || null,
      },
      { merge: true }
    );
  } catch (error) {
    console.warn("Shared food save failed", error);
  }
}

async function handleScannedBarcode(barcode) {
  const code = String(barcode || "").trim();
  state.scannerOpen = false;
  if (!code) {
    render();
    return;
  }
  showFeedbackToast({ title: "Skeniran kod", detail: code, tone: "info" });

  let product = await lookupSharedFood(code);
  if (!product) {
    product = await fetchOpenFoodFacts(code);
  }

  const hasData = product && (product.name || product.kcal != null);

  if (state.scannerReturnTo === "composer" && state.editingMealLabel) {
    // Already in the user's database? Select it in the composer and skip the editor.
    const known =
      (store.foods || []).find((food) => String(food.barcode || "") === code) ||
      (product && product.name ? findFoodByExactName(product.name) : null);
    if (known) {
      state.scannerReturnTo = "";
      state.planDraft.foodId = known.id;
      state.planDraft.amountUnit = "g";
      state.planDraft.grams = String(getFoodServingBaseValue(known));
      render();
      showFeedbackToast({ title: "Izabrano iz tvoje baze", detail: known.name, tone: "success" });
      window.requestAnimationFrame(() => {
        const amount = document.querySelector("#amount-input") || document.querySelector("#grams");
        if (amount instanceof HTMLInputElement && amount.type !== "hidden") {
          amount.focus();
          amount.select();
        }
      });
      return;
    }
  }

  state.scannedFood = {
    name: (product && product.name) || "",
    kcal: (product && product.kcal) ?? null,
    protein: (product && product.protein) ?? null,
    carbs: (product && product.carbs) ?? null,
    fat: (product && product.fat) ?? null,
  };
  state.scannedBarcode = code;
  state.editingFoodId = "";
  state.foodEditorOpen = true;

  if (hasData) {
    showFeedbackToast({ title: "Proizvod pronađen", detail: product.name || code, tone: "success" });
  } else {
    showFeedbackToast({
      title: "Nije u bazi",
      detail: "Unesi vrednosti ručno — sačuvaće se za sve.",
      tone: "warning",
    });
  }
  render();
  window.requestAnimationFrame(() => {
    document.querySelector(state.scannedFood?.name ? "#food-kcal" : "#food-name")?.focus();
  });
}

function renderBarcodeScanner() {
  if (!state.scannerOpen) {
    return "";
  }
  return `
    <div class="app-dialog-shell scanner-shell">
      <button class="app-dialog-backdrop" type="button" data-action="close-scanner" aria-label="Zatvori skener"></button>
      <section class="app-dialog scanner-dialog" role="dialog" aria-modal="true" aria-label="Skeniranje barkoda">
        <div class="app-dialog-head">
          <div class="stack" style="gap:4px;">
            <div class="hero-picker-label">Skener</div>
            <h3>Skeniraj barkod</h3>
            <p>Drži telefon mirno, ~10-15 cm od barkoda. Ne fokusira se? Dodirni barkod na slici.</p>
          </div>
          <button class="ghost-button menu-close" type="button" data-action="close-scanner" aria-label="Zatvori skener">
            ${renderMenuToggleIcon(true)}
          </button>
        </div>
        <div class="scanner-viewport" data-action="focus-scanner">
          <video id="barcode-video" playsinline muted autoplay></video>
          <div class="scanner-reticle" aria-hidden="true"></div>
          <button id="scanner-torch-btn" class="scanner-torch-btn" type="button" data-action="toggle-scanner-torch" aria-label="Uključi/isključi blic" hidden>
            ${renderActionIcon("flash")}
          </button>
        </div>
        <div class="footer-note scanner-status">${state.scannerStatus || "Tražim kameru…"}</div>
        <div class="entry-actions" style="justify-content:flex-start;">
          <button class="solid-button secondary-button button-with-icon" type="button" data-action="scan-manual">${renderButtonContent("Unesi ručno", "add")}</button>
          <button class="ghost-button button-with-icon" type="button" data-action="close-scanner">${renderButtonContent("Odustani", "close")}</button>
        </div>
      </section>
    </div>
  `;
}

function renderFoodEditorDialog() {
  if (!state.foodEditorOpen) {
    return "";
  }

  const editingFood = state.editingFoodId ? getFoodById(state.editingFoodId) : null;
  // For a fresh scan there is no editingFood, but state.scannedFood pre-fills the inputs.
  const prefill = editingFood || state.scannedFood || null;
  const isScannedDraft = !editingFood && Boolean(state.scannedBarcode);
  const editingFoodBasisLabel = getFoodNutritionBasisLabel(editingFood);
  const foodEditorServingUnit = getFoodServingUnit(editingFood);
  const foodEditorHelpText =
    foodEditorServingUnit === "piece"
      ? "Unosiš vrednosti za 1 komad, pa posle u planu i receptima možeš da koristiš broj komada."
      : "Unosiš vrednosti na 100 g i posle ih koristiš bilo kojom gramažom.";

  return `
    <div class="app-dialog-shell">
      <button class="app-dialog-backdrop" type="button" data-action="close-food-editor-dialog" aria-label="Zatvori dijalog"></button>
      <section class="app-dialog food-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="food-editor-title">
        <div class="app-dialog-head">
          <div class="stack" style="gap:4px;">
            <div class="hero-picker-label">${editingFood ? "Namirnica" : "Baza namirnica"}</div>
            <h3 id="food-editor-title">${editingFood ? escapeHtml(editingFood.name) : "Nova namirnica"}</h3>
            <p>${editingFood ? `Promeni vrednosti za ${editingFoodBasisLabel.toLowerCase()} i sačuvaj izmenu.` : "Izaberi da li namirnicu vodiš na 100 g ili na 1 komad, pa unesi makroe i kalorije."}</p>
          </div>
          <button class="ghost-button menu-close" type="button" data-action="close-food-editor-dialog" aria-label="Zatvori dijalog">
            ${renderMenuToggleIcon(true)}
          </button>
        </div>
        <form id="food-form" class="food-form-v2">
          ${
            isScannedDraft
              ? `<p class="food-form-scan-note">Vrednosti su povučene sa barkoda <strong>${escapeHtml(state.scannedBarcode)}</strong> — proveri ih i sačuvaj.</p>`
              : ""
          }
          <section class="food-form-section">
            <div class="food-form-step">
              <span class="food-form-step-num">1</span>
              <span class="food-form-step-title">Osnovne informacije</span>
              <span class="food-form-step-count">1/2</span>
            </div>
            <div class="field">
              <label for="food-name">Naziv</label>
              <input id="food-name" name="name" placeholder="npr. Grčki jogurt" value="${prefill?.name ? escapeHtml(prefill.name) : ""}" required />
            </div>
            <div class="food-form-grid">
              <div class="field">
                <label for="food-category">Kategorija</label>
                <input id="food-category" name="category" value="${escapeHtml(editingFood?.category || "")}" placeholder="Automatski po makroima" readonly aria-describedby="food-category-hint" />
                <div id="food-category-hint" class="footer-note">Određuje se automatski po dominantnom makrou (Proteini / UH / Masti / Ostalo).</div>
              </div>
              ${renderChoiceField("Baza nutritivnih vrednosti", "servingUnit", foodEditorServingUnit, [
                { id: "grams", label: "Na 100 g" },
                { id: "piece", label: "Na 1 komad" },
              ])}
            </div>
          </section>
          <section class="food-form-section">
            <div class="food-form-step">
              <span class="food-form-step-num">2</span>
              <span class="food-form-step-title">Nutritivne vrednosti</span>
              <span class="food-form-step-count">2/2</span>
            </div>
            <div class="food-form-grid">
              <div class="field">
                <label for="food-kcal">Kalorije</label>
                <input id="food-kcal" name="kcal" type="number" inputmode="decimal" step="0.1" min="0" value="${prefill && prefill.kcal != null ? roundValue(prefill.kcal, 1) : ""}" required />
              </div>
              <div class="field">
                <label for="food-protein">Proteini</label>
                <input id="food-protein" name="protein" type="number" inputmode="decimal" step="0.1" min="0" value="${prefill && prefill.protein != null ? roundValue(prefill.protein, 1) : ""}" required />
              </div>
              <div class="field">
                <label for="food-carbs">Ugljeni hidrati</label>
                <input id="food-carbs" name="carbs" type="number" inputmode="decimal" step="0.1" min="0" value="${prefill && prefill.carbs != null ? roundValue(prefill.carbs, 1) : ""}" required />
              </div>
              <div class="field">
                <label for="food-fat">Masti</label>
                <input id="food-fat" name="fat" type="number" inputmode="decimal" step="0.1" min="0" value="${prefill && prefill.fat != null ? roundValue(prefill.fat, 1) : ""}" required />
              </div>
            </div>
          </section>
          <div class="food-form-actions">
            <button class="solid-button button-with-icon" type="submit">${renderButtonContent(editingFood ? "Sačuvaj izmenu" : "Sačuvaj namirnicu", "save")}</button>
            <button class="ghost-button button-with-icon" type="button" data-action="close-food-editor-dialog">${renderButtonContent("Odustani", "close")}</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function isMealCompletedForWeekday(weekday, mealLabel, weekTrack = state.selectedWeekTrack) {
  const mealEntries = getMealEntriesForWeekday(weekday, mealLabel, weekTrack);
  return mealEntries.length > 0 && mealEntries.every((entry) => entry.done);
}

// Meals are collapsed by default; we track which ones the user has expanded
// (per weekday). Absence from the set = collapsed.
function isMealCollapsedForWeekday(weekday, mealLabel) {
  const expandedMeals = store.ui?.plan?.expandedMealsByWeekday?.[weekday];
  const normalizedMealLabel = normalizeMealLabel(mealLabel);
  const isExpanded = Array.isArray(expandedMeals)
    ? expandedMeals.includes(normalizedMealLabel)
    : Boolean(expandedMeals?.[normalizedMealLabel]);
  return !isExpanded;
}

function readExpandedMeals(weekday) {
  const current = store.ui.plan.expandedMealsByWeekday?.[weekday];
  return Array.isArray(current)
    ? [...current]
    : Object.keys(current || {}).filter((label) => current[label]);
}

function toggleMealCollapsedState(weekday, mealLabel) {
  const normalizedMealLabel = normalizeMealLabel(mealLabel);
  const expandedMeals = readExpandedMeals(weekday);
  if (expandedMeals.includes(normalizedMealLabel)) {
    store.ui.plan.expandedMealsByWeekday[weekday] = expandedMeals.filter((label) => label !== normalizedMealLabel);
    return;
  }
  store.ui.plan.expandedMealsByWeekday[weekday] = [...expandedMeals, normalizedMealLabel];
}

// Force a meal open (used when editing/adding items so the change is visible).
function expandMealForWeekday(weekday, mealLabel) {
  if (!weekday || !mealLabel) {
    return;
  }
  store.ui = store.ui || {};
  store.ui.plan = store.ui.plan || {};
  store.ui.plan.expandedMealsByWeekday = store.ui.plan.expandedMealsByWeekday || {};
  const normalizedMealLabel = normalizeMealLabel(mealLabel);
  const expandedMeals = readExpandedMeals(weekday);
  if (!expandedMeals.includes(normalizedMealLabel)) {
    store.ui.plan.expandedMealsByWeekday[weekday] = [...expandedMeals, normalizedMealLabel];
  }
}

function isRecipeExpanded(recipeId) {
  return Array.isArray(store.ui?.recipes?.expandedRecipeIds) && store.ui.recipes.expandedRecipeIds.includes(recipeId);
}

function toggleRecipeExpanded(recipeId) {
  const expandedIds = Array.isArray(store.ui.recipes?.expandedRecipeIds) ? [...store.ui.recipes.expandedRecipeIds] : [];
  if (expandedIds.includes(recipeId)) {
    store.ui.recipes.expandedRecipeIds = expandedIds.filter((id) => id !== recipeId);
    return;
  }
  store.ui.recipes.expandedRecipeIds = [...expandedIds, recipeId];
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
  // Scale by the food's own basis (100 g, or 1 piece) — a hard-coded 100 turned
  // a 6 g-protein egg into "633 kom" for a 40 g protein target.
  const amount = (targetValue / baseMacro) * getFoodServingBaseValue(food);
  if (getFoodServingUnit(food) === "piece") {
    return Math.max(1, Math.min(6, Math.round(amount)));
  }
  return roundValue(clamp(amount, min, max), 0);
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
    pushSuggestion(carbFood, calculateGramsForTarget(carbFood, "carbs", Math.max(18, remaining.carbs * 0.25), 80, 40, 180), "Za više energije");
  }

  return suggestions.slice(0, 3);
}

function renderProgress(value, goal, kind = "neutral") {
  const ratio = goal ? value / goal : 0;
  const width = Math.max(0, Math.min(ratio * 100, 100));
  let progressState = "neutral";
  if (goal) {
    if (kind === "limit") {
      // Calories / carbs / fat: staying within budget is good, over is a warning.
      if (ratio > 1.1) progressState = "over";
      else if (ratio > 1.0) progressState = "near";
      else progressState = "ok";
    } else if (kind === "target") {
      // Protein: hitting (or nearly hitting) the goal is good; below that is just
      // "still building" — neutral, never an amber/red warning.
      progressState = ratio >= 0.9 ? "ok" : "low";
    } else {
      progressState = ratio > 1.0 ? "over" : "ok";
    }
  }
  return `<div class="progress" data-state="${progressState}"><span style="width:${width}%"></span></div>`;
}

function formatPlanDelta(delta, unit) {
  if (Math.abs(delta) < 0.05) {
    return `Tačno po planu`;
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
              </header>
              <div class="macro-value">${roundValue(metric.value, 0)}<span class="macro-goal">/ ${roundValue(metric.goal, 0)}</span><span class="macro-unit">${metric.unit}</span></div>
              ${renderProgress(metric.value, metric.goal, metric.kind)}
              ${metric.note ? `<div class="footer-note">${escapeHtml(metric.note)}</div>` : ""}
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

// Plan tools (copy a day, wipe a day) are a weekly editing job, not a daily
// one. They opened by default on desktop, which put a three-select form between
// today's meals and everything below it. Closed until asked for, on every width.
function getInitialPlanQuickExpanded() {
  return false;
}

function getInitialPlanSummaryExpanded() {
  if (typeof window === "undefined") {
    return true;
  }
  return window.innerWidth >= 720;
}

function getInitialPlanSupplementsExpanded() {
  if (typeof window === "undefined") {
    return true;
  }
  return window.innerWidth >= 720;
}

function renderHero(entries, totals) {
  return `
    <section class="hero hero--plan">
      <div class="hero-top" data-role="hero-top">
        <span class="hero-tag">Plan</span>
        <div class="hero-title-wrap">
          <h1 class="hero-title">${state.selectedWeekday === getTodayWeekday() && state.selectedWeekTrack === getCurrentWeekTrack() ? "Danas" : weekdayLabel(state.selectedWeekday)}</h1>
          ${
            state.selectedWeekday === getTodayWeekday() && state.selectedWeekTrack === getCurrentWeekTrack()
              ? `<span class="hero-date">${weekdayLabel(getTodayWeekday()).toLowerCase()}, ${formatDateValueLabel(getTodayDateValue()).replace(/ \d{4}\.$/, "")}</span>`
              : ""
          }
        </div>
        ${renderWeekTrackToggle()}
      </div>
      <div class="hero-day-picker">
        <div class="chips hero-day-chips" role="group" aria-label="Izaberi dan">
        ${WEEKDAYS.map(
          (weekday) => `
            <button class="chip ${weekday === state.selectedWeekday ? "is-active" : ""} ${weekday === getTodayWeekday() && state.selectedWeekTrack === getCurrentWeekTrack() ? "is-today" : ""}" data-action="select-weekday" data-weekday="${weekday}" aria-pressed="${weekday === state.selectedWeekday}">
              ${weekdayLabel(weekday).slice(0, 3)}
            </button>
          `
        ).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderWorkspaceHeader() {
  const activeTab = ALL_TABS.find((tab) => tab.id === state.activeTab) || TABS[0];
  const tabMeta = TAB_META[state.activeTab] || TAB_META.plan;
  const navGroup = getNavGroupForTab(state.activeTab);
  const headerTitle = navGroup.navTabs && state.activeTab !== "nutrition" ? navGroup.label : activeTab.label;

  return `
    <section class="workspace-header section">
      <div class="workspace-header-top">
        <div class="workspace-header-copy">
          <span class="workspace-header-eyebrow">${tabMeta.eyebrow}</span>
          <div class="workspace-header-title-row">
            <span class="workspace-header-icon" aria-hidden="true">${renderTabIcon(activeTab.id)}</span>
            <div>
              <h1>${headerTitle}</h1>
              <p>${tabMeta.description}</p>
            </div>
          </div>
        </div>
        <button class="ghost-button workspace-header-menu" type="button" data-action="toggle-nav-menu" aria-expanded="${state.navMenuOpen}" aria-controls="app-menu" aria-label="Otvori meni">
          ${renderMenuToggleIcon(state.navMenuOpen)}
        </button>
      </div>
    </section>
  `;
}

function renderLoadingShell() {
  return `
    <main class="shell app-main loading-shell" aria-busy="true" aria-label="Učitavanje">
      <div class="skeleton skeleton-hero"></div>
      <div class="skeleton-card">
        <div class="skeleton skeleton-line skeleton-line--title"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line skeleton-line--short"></div>
      </div>
      <div class="skeleton-card">
        <div class="skeleton skeleton-line skeleton-line--title"></div>
        <div class="skeleton skeleton-line"></div>
      </div>
      <p class="loading-shell-note">Povezujem aplikaciju…</p>
    </main>
  `;
}

// First-run onboarding only for a genuinely fresh account — never for users
// who already set a goal or logged any meals.
function shouldShowOnboarding() {
  if (store.onboarded) {
    return false;
  }
  if (toNumber(store.goals.calories) > 0) {
    return false;
  }
  return (store.weeklyPlanEntries || []).length === 0;
}

function renderOnboardingPreview() {
  const ob = state.onboarding || {};
  const rec = getGoalRecommendation(
    {
      sex: ob.sex,
      age: ob.age,
      heightCm: ob.heightCm,
      weightKg: ob.weightKg,
      activityLevel: ob.activityLevel,
    },
    { targetMode: ob.targetMode, paceLevel: ob.paceLevel }
  );
  if (!rec) {
    return `<div class="onboarding-preview-empty">Popuni pol, godine, visinu i težinu pa odmah računamo tvoj dnevni cilj.</div>`;
  }
  return `
    <div class="onboarding-preview-label">Tvoj dnevni cilj</div>
    <div class="onboarding-preview-kcal"><strong>${rec.targetCalories}</strong> kcal</div>
    ${rec.rateKgPerWeek ? `<div class="footer-note">${rec.rateKgPerWeek > 0 ? "+" : ""}${rec.rateKgPerWeek} kg/nedeljno${rec.paceLimited ? " · ograničeno bezbednim minimumom kalorija" : ""}</div>` : ""}
    <div class="onboarding-preview-macros">
      <span>P <strong>${rec.protein}</strong> g</span>
      <span>UH <strong>${rec.carbs}</strong> g</span>
      <span>M <strong>${rec.fat}</strong> g</span>
    </div>`;
}

function syncOnboardingPreview() {
  const el = document.querySelector("#onboarding-preview");
  if (el) {
    el.innerHTML = renderOnboardingPreview();
  }
}

function renderOnboarding() {
  const ob = state.onboarding || {};
  return `
    <main class="shell onboarding-shell" aria-label="Početno podešavanje">
      <div class="onboarding-card">
        <div class="onboarding-head">
          <span class="onboarding-logo" aria-hidden="true">${renderTabIcon("plan")}</span>
          <h1>Dobrodošli u Fit Tracker</h1>
          <p>Par brzih podataka i odmah dobijaš dnevni kalorijski cilj i makroe. Sve kasnije možeš da promeniš u Ciljevima.</p>
        </div>
        <form id="onboarding-form" class="onboarding-form" autocomplete="off">
          <div class="field">
            <label>Pol</label>
            <div class="chips onboarding-chips">
              <button type="button" class="chip ${ob.sex === "male" ? "is-active" : ""}" data-action="set-onboarding-sex" data-sex="male">Muško</button>
              <button type="button" class="chip ${ob.sex === "female" ? "is-active" : ""}" data-action="set-onboarding-sex" data-sex="female">Žensko</button>
            </div>
          </div>
          <div class="onboarding-grid">
            <div class="field">
              <label for="ob-age">Godine</label>
              <input id="ob-age" type="number" inputmode="numeric" min="0" value="${ob.age || ""}" placeholder="30" />
            </div>
            ${renderUnitField("ob-height", "Visina", "cm", `<input id="ob-height" type="number" inputmode="numeric" min="0" value="${ob.heightCm || ""}" placeholder="180" />`)}
            ${renderUnitField("ob-weight", "Težina", "kg", `<input id="ob-weight" type="number" inputmode="decimal" min="0" step="0.1" value="${ob.weightKg || ""}" placeholder="84" />`)}
          </div>
          <div class="field">
            <label>Nivo aktivnosti</label>
            <div class="choice-chips">
              ${ACTIVITY_LEVELS.map(
                (level) => `<button type="button" class="choice-chip ${level.id === ob.activityLevel ? "is-active" : ""}" data-action="set-onboarding-activity" data-activity="${level.id}">
                  <span class="choice-chip-label">${ACTIVITY_SHORT_LABELS[level.id] || level.label}</span>
                  <span class="choice-chip-hint">${ACTIVITY_HINTS[level.id] || ""}</span>
                </button>`
              ).join("")}
            </div>
          </div>
          <div class="field">
            <label>Cilj</label>
            <div class="chips onboarding-chips">
              ${GOAL_MODES.map((mode) => `<button type="button" class="chip ${mode.id === ob.targetMode ? "is-active" : ""}" data-action="set-onboarding-mode" data-mode="${mode.id}">${mode.label}</button>`).join("")}
            </div>
          </div>
          ${
            ob.targetMode !== "maintain"
              ? `<div class="field">
            <label>Tempo</label>
            <div class="chips onboarding-chips">
              ${PACE_LEVELS.map((level) => `<button type="button" class="chip ${level.id === (ob.paceLevel || "umereno") ? "is-active" : ""}" data-action="set-onboarding-pace" data-pace="${level.id}">${level.label}</button>`).join("")}
            </div>
          </div>`
              : ""
          }
          <div class="onboarding-preview" id="onboarding-preview">${renderOnboardingPreview()}</div>
          <button class="solid-button button-with-icon onboarding-cta" type="button" data-action="finish-onboarding">${renderButtonContent("Sačuvaj i počni", "apply")}</button>
          <button class="ghost-button onboarding-skip" type="button" data-action="skip-onboarding">Preskoči zasad</button>
        </form>
      </div>
    </main>
  `;
}

function scrollPageTop(behavior = "smooth") {
  window.scrollTo({ top: 0, behavior });
  lastHeaderScrollY = 0;
  state.isPlanHeroCompact = false;
  document.body.classList.remove("app-header-hidden", "plan-compact");
}

function isOverlayOpen() {
  return Boolean(
    state.navMenuOpen ||
      state.foodEditorOpen ||
      state.scannerOpen ||
      (state.recipeApplyDialog && state.recipeApplyDialog.favoriteId)
  );
}

function syncBodyScrollLock() {
  const body = document.body;
  // Sidebar-specific CSS still keys off `menu-open`.
  body.classList.toggle("menu-open", Boolean(state.navMenuOpen));

  const shouldLock = isOverlayOpen();
  const isLocked = body.classList.contains("scroll-locked");

  if (shouldLock && !isLocked) {
    lockedScrollY = window.scrollY;
    body.classList.add("scroll-locked");
    body.style.position = "fixed";
    body.style.top = `-${lockedScrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    return;
  }

  if (!shouldLock && isLocked) {
    const topValue = body.style.top;
    body.classList.remove("scroll-locked");
    body.style.position = "";
    body.style.top = "";
    body.style.left = "";
    body.style.right = "";
    body.style.width = "";
    window.scrollTo(0, topValue ? Math.abs(parseInt(topValue, 10)) || lockedScrollY || 0 : lockedScrollY || 0);
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

function getLocalDateInputValue(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return localDate.toISOString().slice(0, 10);
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

// A single persistent visually-hidden live region so screen readers reliably
// announce feedback (a freshly-inserted node carrying aria-live can be missed).
let a11yLiveRegion = null;
function announce(message) {
  if (!message) {
    return;
  }
  if (!a11yLiveRegion) {
    a11yLiveRegion = document.createElement("div");
    a11yLiveRegion.setAttribute("role", "status");
    a11yLiveRegion.setAttribute("aria-live", "polite");
    a11yLiveRegion.style.cssText =
      "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;";
    document.body.appendChild(a11yLiveRegion);
  }
  a11yLiveRegion.textContent = "";
  window.requestAnimationFrame(() => {
    if (a11yLiveRegion) {
      a11yLiveRegion.textContent = message;
    }
  });
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
  toast.innerHTML = `
    <div class="feedback-toast-title">${escapeHtml(title)}</div>
    ${detail ? `<div class="feedback-toast-detail">${escapeHtml(detail)}</div>` : ""}
  `;
  document.body.appendChild(toast);
  announce([title, detail].filter(Boolean).join(". "));

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
    edit: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    delete:
      '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
    save: '<path fill="currentColor" d="M5 4h11l3 3v13H5V4Zm2 2v4h8V6H7Zm0 12h10v-6H7v6Z"/>',
    copy: '<path fill="currentColor" d="M8 7V4h11v13h-3v3H5V7h3Zm2 0h6v8h1V6H10v1Zm-3 2v9h7V9H7Z"/>',
    open: '<path fill="currentColor" d="M4 7h7l2 2h7v10H4V7Zm2 2v8h12v-6h-6.2l-2-2H6Z"/>',
    undo: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    refresh: '<path fill="currentColor" d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h7V4l-2.3 2.3Z"/>',
    signout: '<path fill="currentColor" d="M10 4H5v16h5v-2H7V6h3V4Zm1.5 4.5 1.4-1.4L18.8 13l-5.9 5.9-1.4-1.4L14.97 14H9v-2h5.97L11.5 8.5Z"/>',
    apply: '<path fill="currentColor" d="M9 16.2 4.8 12l1.4-1.4L9 13.4l8.8-8.8L19.2 6 9 16.2Z"/>',
    share: '<path fill="currentColor" d="M18 16.08a2.9 2.9 0 0 0-2.27 1.1l-6.1-3.55a2.9 2.9 0 0 0 0-1.26l6.04-3.52A2.92 2.92 0 1 0 14.8 6.9l-6.04 3.52a2.92 2.92 0 1 0 0 5.16l6.1 3.56a2.92 2.92 0 1 0 3.14-3.06Z"/>',
    close: '<path fill="currentColor" d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z"/>',
    minus: '<path fill="currentColor" d="M5 11h14v2H5z"/>',
    flash: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M13 2 3.5 14h6.2l-1.4 8L20.5 9h-6.2Z"/>',
    spinner: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="34 16"/>',
  };
  return `<span class="button-icon ${kind === "spinner" ? "is-spinning" : ""}" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" focusable="false">${icons[kind] || icons.add}</svg></span>`;
}

function getSyncStatusTone(status = state.syncStatus) {
  const value = `${status || ""}`.toLowerCase();
  if (!value) return "info";
  if (value.includes("uspeo") || value.includes("preveliki")) return "error";
  if (
    value.includes("nije dostupan") ||
    value.includes("radiš lokalno") ||
    value.includes("radis lokalno") ||
    value.includes("drugog uređaja") ||
    value.includes("drugog uredjaja") ||
    value.includes("neispravni") ||
    value.includes("čeka sync") ||
    value.includes("ceka sync")
  ) {
    return "warning";
  }
  if (value.includes("prijavi se") || value.includes("čuvam") || value.includes("cuvam") || value.includes("učitavam") || value.includes("ucitavam")) return "info";
  if (value.includes("uključen") || value.includes("ukljucen") || value.includes("završen") || value.includes("zavrsen")) return "success";
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
          <strong>${escapeHtml(title)}</strong>
          ${detail ? `<div class="footer-note">${escapeHtml(detail)}</div>` : ""}
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

// Crafted disclosure chevron — rotates 180° when open. Replaces the ▴/▾ glyphs.
// Serbian counts take three forms, not two: 1 vežba, 2-4 vežbe, 5+ vežbi —
// with the teens (11-14) falling back to the last form. Getting this wrong is
// the loudest sign a Serbian interface was translated rather than written.
function srPlural(count, one, few, many) {
  const n = Math.abs(Math.round(Number(count) || 0));
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) {
    return many;
  }
  const last = n % 10;
  if (last === 1) {
    return one;
  }
  if (last >= 2 && last <= 4) {
    return few;
  }
  return many;
}

// A collapsed section that only shows its title forces a tap to find out
// whether there is anything inside. One muted line in the summary answers that
// without opening it.
function renderCollapseHint(text) {
  return text ? `<span class="form-collapse-hint">${escapeHtml(String(text))}</span>` : "";
}

// ---------------------------------------------------------------------------
// Ciljevi — a question with three answers is a choice, not a text field. The
// onboarding already asks these four as chips; the Ciljevi form asked the same
// four as dropdowns. Chips write into a hidden input so the existing form
// submit is untouched, and they never re-render: the form holds other unsaved
// edits that a render would throw away.
// ---------------------------------------------------------------------------
// 4 kcal po gramu proteina i ugljenih hidrata, 9 po gramu masti.
function renderGoalMacroCheck(goals = {}) {
  const protein = toNumber(goals.protein);
  const carbs = toNumber(goals.carbs);
  const fat = toNumber(goals.fat);
  const calories = toNumber(goals.calories);
  if (!protein && !carbs && !fat) {
    return "";
  }
  const fromMacros = Math.round(protein * 4 + carbs * 4 + fat * 9);
  if (!calories) {
    return `Makroi daju <strong>${fromMacros} kcal</strong>.`;
  }
  const diff = fromMacros - calories;
  if (Math.abs(diff) <= 30) {
    return `Makroi daju <strong>${fromMacros} kcal</strong> — poklapa se sa ciljem.`;
  }
  return `<span class="macro-check-warn">Makroi daju <strong>${fromMacros} kcal</strong>, a cilj je ${calories} kcal (${diff > 0 ? "+" : ""}${diff}).</span>`;
}

function renderChoiceField(label, name, currentValue, options) {
  const current = String(currentValue || "");
  return `
    <div class="field field--full choice-field">
      <span class="choice-field-label" id="choice-${name}-label">${escapeHtml(label)}</span>
      <input type="hidden" name="${name}" value="${escapeHtml(current)}" data-choice-input="${name}" />
      <div class="choice-chips" role="radiogroup" aria-labelledby="choice-${name}-label">
        ${options
          .map((option) => {
            const active = String(option.id) === current;
            return `<button type="button" class="choice-chip ${active ? "is-active" : ""}" role="radio" aria-checked="${active}" data-action="pick-goal-option" data-choice-name="${name}" data-choice-value="${escapeHtml(String(option.id))}">
              <span class="choice-chip-label">${escapeHtml(option.label)}</span>
              ${option.hint ? `<span class="choice-chip-hint">${escapeHtml(option.hint)}</span>` : ""}
            </button>`;
          })
          .join("")}
      </div>
    </div>`;
}

// People routinely pick the wrong activity level, so each option says what it
// means in training terms rather than leaving the multiplier implicit.
const ACTIVITY_SHORT_LABELS = {
  sedentary: "Sedeći",
  light: "Lagano",
  moderate: "Umereno",
  active: "Aktivno",
  "very-active": "Vrlo aktivno",
};
const ACTIVITY_HINTS = {
  sedentary: "malo kretanja",
  light: "1-3 treninga",
  moderate: "3-5 treninga",
  active: "6-7 treninga",
  "very-active": "fizički posao",
};

function paceHintFor(paceId, targetMode) {
  const level = PACE_LEVELS.find((entry) => entry.id === paceId);
  if (!level || targetMode === "maintain") {
    return "";
  }
  const rate = targetMode === "gain" ? level.gainKgPerWeek : level.loseKgPerWeek;
  return `${String(rate).replace(".", ",")} kg/ned`;
}

// A number field that carries its unit inside it instead of in the label.
function renderUnitField(id, label, unit, inputHtml, full = false) {
  return `
    <div class="field ${full ? "field--full" : ""}">
      <label for="${id}">${escapeHtml(label)}</label>
      <div class="input-unit">
        ${inputHtml}
        ${unit ? `<span class="input-unit-suffix" aria-hidden="true">${escapeHtml(unit)}</span>` : ""}
      </div>
    </div>`;
}

function renderInfoIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.2"/></svg>';
}

function renderRestIcon() {
  return '<svg class="training-rest-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9 2h6"/></svg>';
}

function renderChevronIcon(isOpen) {
  return `<svg class="chevron-icon ${isOpen ? "is-open" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;
}

// Horizontal chevron for the sidebar collapse control.
function renderSideChevronIcon(pointsLeft) {
  const path = pointsLeft ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6";
  return `<svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}

// Crafted favorite star — outline when off, filled when active. Replaces ★/☆.
function renderStarIcon(isActive) {
  return `<svg class="star-icon" viewBox="0 0 24 24" fill="${isActive ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.4l2.55 5.17 5.7.83-4.13 4.02.98 5.68L12 16.6l-5.1 2.68.98-5.68L3.75 9.4l5.7-.83z"/></svg>`;
}

// Small up/down trend arrow — replaces ↑/↓ text glyphs in delta readouts.
function renderTrendArrowIcon(down) {
  return `<svg class="trend-arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${down ? "M12 5v14M6 13l6 6 6-6" : "M12 19V5M6 11l6-6 6 6"}"/></svg>`;
}

// Small search glass — same mark as the Namirnice search box, reused inline in field icons.
function renderSearchIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></svg>`;
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
      <section class="auth-box">
        <div class="auth-brand">
          <span class="auth-logo" aria-hidden="true">${renderTabIcon("plan")}</span>
          <h1>Fit Tracker</h1>
          <p>${state.authMode === "register" ? "Napravi nalog da plan, obroci i trening budu na svim uređajima." : "Prijavi se da nastaviš."}</p>
        </div>
        <form id="auth-form" class="auth-form">
          <div class="field">
            <label for="auth-email">Email</label>
            <input id="auth-email" name="email" type="email" placeholder="ime@email.com" autocomplete="email" required />
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
          ${state.authError ? `<div class="auth-feedback auth-feedback--error" role="alert">${state.authError}</div>` : ""}
          <button class="solid-button auth-submit" type="submit" ${state.authPending ? "disabled" : ""}>${submitLabel}</button>
          ${state.authMode === "login" ? `<button class="auth-switch-button auth-forgot" type="button" data-action="reset-password">Zaboravljena lozinka?</button>` : ""}
        </form>
        <div class="auth-toggle-row">
          <span class="footer-note">${state.authMode === "register" ? "Već imaš nalog?" : "Prvi put ovde?"}</span>
          <button class="auth-switch-button" type="button" data-action="set-auth-mode" data-mode="${state.authMode === "register" ? "login" : "register"}">
            ${state.authMode === "register" ? "Prijavi se" : "Napravi nalog"}
          </button>
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
    const y = window.scrollY || 0;
    const body = document.body;

    // The Plan hero's title row (tag + h1 + refresh) collapses once scrolled
    // away; unlike the workspace header below, its week/day pickers stay put
    // and usable the whole time.
    const isPlanCompact = state.activeTab === "plan" && y >= 28;
    if (isPlanCompact !== state.isPlanHeroCompact) {
      state.isPlanHeroCompact = isPlanCompact;
      body.classList.toggle("plan-compact", isPlanCompact);
    }

    // The (non-interactive) workspace header shows ONLY at the very top of
    // the page. Once scrolled away it stays hidden — it does not reappear on
    // scroll-up, only when you return to the top.
    if (y < 72) {
      body.classList.remove("app-header-hidden");
    } else {
      body.classList.add("app-header-hidden");
    }
    lastHeaderScrollY = y;
  });
}

// Live food search: filter the already-rendered rows in the DOM instead of
// re-rendering the whole app on every keystroke (which made typing stutter
// and dropped focus). Each row carries its searchable text in data-search.
// Same inline ranking for the recipe library (name, meal, description, ingredients).
function filterRecipeCardsInline(query) {
  const list = document.querySelector(".recipes-library-stack");
  if (!list) {
    return;
  }
  const normalizedQuery = normalizeLookupValue(query || "");
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const cards = [...list.querySelectorAll(".recipe-library-card")];
  cards.forEach((card, index) => {
    if (!card.dataset.index) {
      card.dataset.index = String(index);
    }
  });
  const ranked = [];
  cards.forEach((card) => {
    const haystack = card.dataset.search || "";
    const name = card.dataset.name || haystack;
    const score = tokens.length ? scoreNameForQuery(name, haystack, normalizedQuery, tokens) : 0;
    card.style.display = score === null ? "none" : "";
    if (score !== null) {
      ranked.push({ card, score, index: Number(card.dataset.index) });
    }
  });
  ranked.sort((a, b) => a.score - b.score || a.index - b.index);
  const hidden = cards.filter((card) => card.style.display === "none").sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
  [...ranked.map((entry) => entry.card), ...hidden].forEach((card) => list.appendChild(card));
  const empty = document.querySelector(".recipe-list-empty");
  if (empty) {
    empty.hidden = !(tokens.length > 0 && cards.length > 0 && ranked.length === 0);
  }
}

function filterFoodsListInline(query) {
  const list = document.querySelector(".foods-list");
  if (!list) {
    return;
  }
  const normalizedQuery = normalizeLookupValue(query || "");
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const rows = [...list.querySelectorAll(".food-row")];
  // Remember the rendered (alphabetical) order once so clearing the query
  // restores it after rows have been re-ranked.
  rows.forEach((row, index) => {
    if (!row.dataset.index) {
      row.dataset.index = String(index);
    }
  });
  const ranked = [];
  const hiddenRows = [];
  let visible = 0;
  rows.forEach((row) => {
    const haystack = row.dataset.search || "";
    const name = row.dataset.name || haystack;
    // Scored once per row, not twice: this runs over the whole list on every
    // keystroke, and the list grows with the user's own foods.
    const score = scoreNameForQuery(name, haystack, normalizedQuery, tokens);
    const match = !tokens.length || score !== null;
    row.style.display = match ? "" : "none";
    if (!match) {
      hiddenRows.push(row);
      return;
    }
    visible += 1;
    ranked.push({ row, score: score ?? 4, index: Number(row.dataset.index) });
  });
  ranked.sort((a, b) => a.score - b.score || a.index - b.index);
  hiddenRows.sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
  const empty = list.querySelector(".foods-list-empty");
  // The heading is rendered by render(), which this inline filter deliberately
  // bypasses — so it kept saying "87 namirnica u bazi" while four rows showed.
  const head = document.querySelector(".foods-head-count");
  if (head) {
    head.textContent = tokens.length
      ? `${visible} od ${rows.length} ${srPlural(rows.length, "namirnice", "namirnice", "namirnica")}`
      : `${rows.length} ${srPlural(rows.length, "namirnica", "namirnice", "namirnica")} u bazi`;
  }
  // Reorder through a fragment so the list is touched once instead of once per
  // row — appendChild per row forced a layout pass each time.
  const fragment = document.createDocumentFragment();
  [...ranked.map((entry) => entry.row), ...hiddenRows].forEach((row) => fragment.appendChild(row));
  list.appendChild(fragment);
  if (empty) {
    list.appendChild(empty);
    empty.hidden = !(tokens.length > 0 && rows.length > 0 && visible === 0);
  }
}

function renderMacroCards(totals, options = {}) {
  const metrics = [
    { label: "Kalorije", value: roundValue(totals.kcal, 0), goal: roundValue(store.goals.calories, 0), unit: "kcal", kind: "limit" },
    { label: "Proteini", value: roundValue(totals.protein, 1), goal: store.goals.protein, unit: "g", kind: "target" },
    { label: "Ugljeni hidrati", value: roundValue(totals.carbs, 1), goal: store.goals.carbs, unit: "g", kind: "limit" },
    { label: "Masti", value: roundValue(totals.fat, 1), goal: store.goals.fat, unit: "g", kind: "limit" },
  ];

  // The plan summary already shows calories as the big headline, so the
  // calorie card is redundant noise there.
  const visible = options.excludeCalories ? metrics.filter((metric) => metric.label !== "Kalorije") : metrics;
  return renderMetricsGrid(visible);
}

// Track which foods get logged so the composer can offer one-tap re-adds of the
// ones you actually use. Keyed by foodId; remembers count, last amount and when.
function recordFoodUsage(foodId, grams) {
  if (!foodId) {
    return;
  }
  store.foodUsage = store.foodUsage && typeof store.foodUsage === "object" ? store.foodUsage : {};
  const prev = store.foodUsage[foodId] || {};
  store.foodUsage[foodId] = {
    count: (toNumber(prev.count) || 0) + 1,
    lastGrams: toNumber(grams) || toNumber(prev.lastGrams) || null,
    lastAt: Date.now(),
  };
}

// Single path for "actually push a new plan entry" — used by the composer's
// submit, the instant-add amount presets, quick-add chips and companion
// suggestions, so all four ways of adding a food behave identically (same
// persistence, same usage tracking, same toast) instead of drifting apart.
function commitPlanDraftEntry(food, grams, mealLabelOverride) {
  const mealLabel = normalizeMealLabel(mealLabelOverride || state.planDraft.mealLabel || defaultMeals[0]);
  if (!food || !grams || !mealLabel || isMealCompletedForWeekday(state.selectedWeekday, mealLabel)) {
    return false;
  }
  const newEntryId = uid("plan");
  store.weeklyPlanEntries.push({
    id: newEntryId,
    weekday: state.selectedWeekday,
    weekTrack: state.selectedWeekTrack,
    mealLabel,
    foodId: food.id,
    foodName: food.name,
    grams,
    done: false,
  });
  state.lastAddedEntryId = newEntryId;
  recordFoodUsage(food.id, grams);
  expandMealForWeekday(state.selectedWeekday, mealLabel);
  persist();
  // No banner here: the new row lights up in the meal (`.meal-entry.is-new`)
  // and removing it is one tap on its trash icon. The undo banner stays for
  // deletes, where it actually protects something.
  return true;
}

// Most recently used foods that still exist, newest first.
function getQuickAddFoods(limit = 8) {
  const usage = store.foodUsage || {};
  return Object.keys(usage)
    .map((foodId) => ({ food: getFoodById(foodId), usage: usage[foodId] || {} }))
    .filter((entry) => entry.food)
    .sort((a, b) => (toNumber(b.usage.lastAt) || 0) - (toNumber(a.usage.lastAt) || 0))
    .slice(0, limit);
}

function quickAddGramsFor(food, usage) {
  return toNumber(usage && usage.lastGrams) || roundValue(food.servingBaseGrams || 100, 0);
}

// ---------------------------------------------------------------------------
// Brzi unos — type a whole meal as one sentence instead of adding foods one by
// one. "200g piletine, 150 pirinca i 2 jajeta u rucak" becomes three rows the
// user confirms. Everything here reuses machinery that already exists: the
// portion parser from the recipe importer, the ranked food search from the
// composer, and commitPlanDraftEntry for the write.
// ---------------------------------------------------------------------------

// A word after a number counts as a unit only if convertImportedPortionToGrams
// knows how to weigh it. Exact matches for the short ones (so "gr" never eats
// "grašak"), prefix families for the inflected ones (kašika / kašike / kašikom).
const QUICK_ENTRY_UNIT_EXACT = [
  "g", "gr", "gram", "grama", "grami",
  "kg", "kila", "kilogram", "kilograma",
  "ml", "dl", "l",
  "kom", "komad", "komada",
];
const QUICK_ENTRY_UNIT_PREFIXES = [
  "litr", "kasic", "kasik", "meric", "solj", "cas", "krisk",
  "parce", "parca", "parcet", "pakov", "kesic", "konzerv", "glavic", "cen", "list",
];

function isQuickEntryUnitWord(word) {
  const normalized = normalizeLookupValue(word);
  if (!normalized) {
    return false;
  }
  return (
    QUICK_ENTRY_UNIT_EXACT.includes(normalized) ||
    QUICK_ENTRY_UNIT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

// A meal named anywhere in the text retargets every row ("... u rucak").
const QUICK_ENTRY_MEAL_HINTS = [
  { test: /\bdorucak|dorucku|doruckom\b/, meal: "1. Doručak" },
  { test: /\bprv[au]\s+uzin|prvoj\s+uzin/, meal: "2. Prva užina" },
  { test: /\bdrug[au]\s+uzin|drugoj\s+uzin/, meal: "4. Druga užina" },
  { test: /\brucak|rucku|puckom\b|\brucko/, meal: "3. Ručak" },
  { test: /\bvecer/, meal: "5. Večera" },
  { test: /\buzin/, meal: "2. Prva užina" },
];

function detectQuickEntryMeal(text) {
  const normalized = normalizeLookupValue(text);
  const hit = QUICK_ENTRY_MEAL_HINTS.find((entry) => entry.test.test(normalized));
  return hit ? hit.meal : "";
}

// Strips a trailing "u rucak" / "za veceru" so it does not leak into the last
// food name. Only the tail is trimmed — "u" inside a name is left alone.
function stripQuickEntryMealPhrase(chunk) {
  return String(chunk || "").replace(/\s+(?:u|za|na)\s+[^,;]{2,24}$/i, (match) =>
    detectQuickEntryMeal(match) ? "" : match
  );
}

function parseQuickEntryChunk(raw) {
  const cleaned = stripQuickEntryMealPhrase(String(raw || "").trim()).trim();
  if (!cleaned) {
    return null;
  }
  // Leading amount: "200 g piletine", "2 jaja", "1,5 kasike ulja".
  let match = cleaned.match(/^(\d+(?:[.,]\d+)?)\s*([^\s\d]+)?\s*(.*)$/);
  let amount = 0;
  let unit = "";
  let query = cleaned;
  if (match && match[1]) {
    amount = parseDecimal(match[1]);
    const maybeUnit = (match[2] || "").replace(/\.$/, "");
    if (maybeUnit && isQuickEntryUnitWord(maybeUnit) && String(match[3] || "").trim()) {
      unit = maybeUnit;
      query = match[3] || "";
    } else {
      query = [maybeUnit, match[3]].filter(Boolean).join(" ");
    }
  } else {
    // Trailing amount: "piletina 200g".
    match = cleaned.match(/^(.*?)\s+(\d+(?:[.,]\d+)?)\s*([^\s\d]*)$/);
    if (match) {
      const maybeUnit = (match[3] || "").replace(/\.$/, "");
      if (!maybeUnit || isQuickEntryUnitWord(maybeUnit)) {
        query = match[1] || "";
        amount = parseDecimal(match[2]);
        unit = maybeUnit;
      }
    }
  }
  query = query.replace(/^(?:od|sa)\s+/i, "").trim();
  if (!query) {
    return null;
  }
  return { raw: cleaned, query, amount, unit };
}

function parseQuickEntryText(text) {
  // A decimal comma ("1,5 kašike") must not be read as an item separator, so
  // normalise it to a dot before splitting.
  const source = String(text || "").replace(/(\d),(\d)/g, "$1.$2");
  const mealLabel = detectQuickEntryMeal(source);
  const chunks = source
    .split(/[\n,;]+|\s+\bi\b\s+/i)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return { mealLabel, items: chunks.map(parseQuickEntryChunk).filter(Boolean) };
}

// Serbian inflects the noun ("piletine", "jajeta"), and the ranked search is
// prefix/substring based, so a genitive ending can miss. Retry with the last
// word progressively shortened before giving up.
function rankQuickEntryMatches(query, limit = 5) {
  const direct = rankFoodsForQuery(query, getSelectableFoods(), limit);
  if (direct.length) {
    return direct;
  }
  const words = normalizeLookupValue(query).split(" ").filter(Boolean);
  if (!words.length) {
    return [];
  }
  const last = words[words.length - 1];
  for (let trim = 1; trim <= 3; trim += 1) {
    if (last.length - trim < 3) {
      break;
    }
    const stem = last.slice(0, last.length - trim);
    const found = rankFoodsForQuery([...words.slice(0, -1), stem].join(" "), getSelectableFoods(), limit);
    if (found.length) {
      // A stem matches both "pirinač" and "pirinčani griz". The word closest in
      // length to what the user actually typed is the likelier one.
      return [...found].sort((a, b) => {
        const distance = (entry) => {
          const word = normalizeLookupValue(entry.food.name)
            .split(" ")
            .filter((part) => part.startsWith(stem))
            .sort((x, y) => Math.abs(x.length - last.length) - Math.abs(y.length - last.length))[0];
          return word ? Math.abs(word.length - last.length) : 99;
        };
        return distance(a) - distance(b) || a.score - b.score;
      });
    }
  }
  return [];
}

// A bare number reads as a count ("2 jajeta"), a number with a weight unit
// reads as weight ("200 g piletine"). Pick the candidate whose own unit matches
// that reading, so eggs land on the per-piece entry instead of on 2 grams of
// the per-100 g one.
const QUICK_ENTRY_COUNT_CEILING = 20;

function quickEntryPrefersPieces(item) {
  const unit = normalizeLookupValue(item.unit);
  if (unit.startsWith("kom")) {
    return true;
  }
  if (unit) {
    return false;
  }
  return item.amount > 0 && item.amount <= QUICK_ENTRY_COUNT_CEILING;
}

function pickQuickEntryMatch(matches, item) {
  if (!matches.length) {
    return null;
  }
  const wantsPieces = quickEntryPrefersPieces(item);
  const preferred = matches.find((entry) => (getFoodServingUnit(entry.food) === "piece") === wantsPieces);
  return (preferred || matches[0]).food;
}

// Amount → the number stored on the entry, which is always in the food's own
// unit (grams for gram-foods, pieces for per-piece foods) — see calculateEntry.
function quickEntryAmountFor(food, item) {
  const perPiece = getFoodServingUnit(food) === "piece";
  const normalizedUnit = normalizeLookupValue(item.unit);
  if (!item.amount) {
    return perPiece ? 1 : getFoodServingBaseValue(food);
  }
  if (perPiece) {
    // "2 jaja", "2 kom" → pieces. A gram amount on a per-piece food is
    // converted back into pieces so the maths stays honest.
    if (!normalizedUnit || normalizedUnit.startsWith("kom")) {
      return roundValue(item.amount, 1);
    }
    const grams = convertImportedPortionToGrams(item.amount, item.unit, item.query);
    const perPieceGrams = Math.max(1, toNumber(food.servingBaseGrams) || 0) || 1;
    return roundValue(grams / perPieceGrams, 1) || 1;
  }
  if (!normalizedUnit || normalizedUnit.startsWith("kom")) {
    // A bare number on a gram-food means grams ("150 pirinca").
    return roundValue(item.amount, 0);
  }
  return roundValue(convertImportedPortionToGrams(item.amount, item.unit, item.query), 0) || 0;
}

// Rows are derived from the text on every render; per-row edits live in
// state.quickEntryOverrides keyed by position, so retyping resets cleanly.
function getQuickEntryRows() {
  const parsed = parseQuickEntryText(state.quickEntryText);
  const fallbackMeal = parsed.mealLabel || getNextOpenMealLabel() || defaultMeals[0];
  return parsed.items.map((item, index) => {
    const override = state.quickEntryOverrides[index] || {};
    if (override.removed) {
      return { index, removed: true, item };
    }
    const matches = rankQuickEntryMatches(item.query);
    const picked = override.foodId ? getFoodById(override.foodId) : pickQuickEntryMatch(matches, item);
    const food = picked || null;
    const amount = override.amount != null ? toNumber(override.amount) : food ? quickEntryAmountFor(food, item) : 0;
    // A small bare number on a per-100 g food means the user counted pieces but
    // no per-piece entry exists — "2 jajeta" would silently log 2 grams.
    const countOnWeightFood =
      Boolean(food) &&
      override.amount == null &&
      quickEntryPrefersPieces(item) &&
      getFoodServingUnit(food) !== "piece";
    return {
      index,
      item,
      food,
      matches,
      amount,
      countOnWeightFood,
      mealLabel: normalizeMealLabel(override.mealLabel || fallbackMeal),
      totals: food && amount ? calculateEntry(food, amount) : { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    };
  });
}

function renderQuickEntryDialog() {
  if (!state.quickEntryOpen) {
    return "";
  }
  const rows = getQuickEntryRows();
  const live = rows.filter((row) => !row.removed && row.food && row.amount > 0);
  const unmatched = rows.filter((row) => !row.removed && !row.food);
  const totals = live.reduce(
    (acc, row) => ({
      kcal: acc.kcal + row.totals.kcal,
      protein: acc.protein + row.totals.protein,
      carbs: acc.carbs + row.totals.carbs,
      fat: acc.fat + row.totals.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
  const mealOptions = [...new Set([...defaultMeals, ...store.weeklyPlanEntries.map((e) => normalizeMealLabel(e.mealLabel))])];

  return `
    <div class="app-dialog-shell">
      <button class="app-dialog-backdrop" type="button" data-action="close-quick-entry" aria-label="Zatvori brzi unos"></button>
      <section class="app-dialog quick-entry-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-entry-title">
        <div class="app-dialog-head">
          <div class="stack" style="gap:4px;">
            <div class="hero-picker-label">Brzi unos</div>
            <h3 id="quick-entry-title">Upiši ceo obrok</h3>
            <p>Napiši šta si jeo/la običnim rečima. Aplikacija prepozna namirnice iz tvoje baze, a ti samo potvrdiš.</p>
          </div>
          <button class="ghost-button menu-close" type="button" data-action="close-quick-entry" aria-label="Zatvori brzi unos">
            ${renderMenuToggleIcon(true)}
          </button>
        </div>

        <div class="field">
          <label for="quick-entry-input">Šta si jeo/la</label>
          <textarea id="quick-entry-input" rows="3" placeholder="npr. 200 g piletine, 150 pirinča i 2 jajeta u ručak" autocomplete="off" spellcheck="false">${escapeHtml(state.quickEntryText)}</textarea>
          <p class="footer-note">Razdvoj zarezom ili sa „i“. Broj bez jedinice znači grame, a „u ručak“ na kraju bira obrok.</p>
        </div>

        ${
          rows.length
            ? `
          <div class="quick-entry-rows">
            ${rows
              .map((row) =>
                row.removed
                  ? ""
                  : `
                <div class="quick-entry-row ${row.food ? "" : "is-unmatched"}">
                  <div class="quick-entry-row-main">
                    <div class="quick-entry-row-head">
                      <span class="quick-entry-raw">${escapeHtml(row.item.raw)}</span>
                      <button class="ghost-button icon-only-action quick-entry-remove" type="button" data-action="remove-quick-entry-row" data-index="${row.index}" aria-label="Izbaci „${escapeHtml(row.item.raw)}“">${renderActionIcon("close")}</button>
                    </div>
                    ${
                      row.food
                        ? `
                      <div class="quick-entry-row-controls">
                        <label class="field quick-entry-field">
                          <span>Namirnica</span>
                          <select data-action="set-quick-entry-food" data-index="${row.index}">
                            ${row.matches
                              .map(
                                (m) =>
                                  `<option value="${escapeHtml(m.food.id)}" ${m.food.id === row.food.id ? "selected" : ""}>${escapeHtml(m.food.name)}</option>`
                              )
                              .join("")}
                            ${row.matches.some((m) => m.food.id === row.food.id) ? "" : `<option value="${escapeHtml(row.food.id)}" selected>${escapeHtml(row.food.name)}</option>`}
                          </select>
                        </label>
                        <label class="field quick-entry-field quick-entry-field--amount">
                          <span>${getFoodServingUnit(row.food) === "piece" ? "Komada" : "Grama"}</span>
                          <input type="number" inputmode="decimal" min="0" step="${getFoodServingUnit(row.food) === "piece" ? "0.5" : "1"}" value="${row.amount}" data-action="set-quick-entry-amount" data-index="${row.index}" />
                        </label>
                        <label class="field quick-entry-field">
                          <span>Obrok</span>
                          <select data-action="set-quick-entry-meal" data-index="${row.index}">
                            ${mealOptions
                              .map((label) => `<option value="${escapeHtml(label)}" ${label === row.mealLabel ? "selected" : ""}>${escapeHtml(getMealDisplayParts(label).title || label)}</option>`)
                              .join("")}
                          </select>
                        </label>
                      </div>
                      <div class="quick-entry-row-totals">${roundValue(row.totals.kcal, 0)} kcal · P ${roundValue(row.totals.protein, 0)} · UH ${roundValue(row.totals.carbs, 0)} · M ${roundValue(row.totals.fat, 0)} g</div>
                      ${row.countOnWeightFood ? `<div class="quick-entry-warn">„${escapeHtml(String(row.item.amount))}“ je shvaćeno kao ${roundValue(row.amount, 0)} g, jer se ova namirnica vodi na ${escapeHtml(getFoodNutritionBasisLabel(row.food))}. Ispravi količinu ako si mislio/la na komade.</div>` : ""}
                    `
                        : `<div class="quick-entry-miss">Nema „${escapeHtml(row.item.query)}“ u tvojoj bazi. Dodaj je u Namirnice pa probaj ponovo.</div>`
                    }
                  </div>
                </div>
              `
              )
              .join("")}
          </div>
          <div class="quick-entry-summary">
            <strong>${roundValue(totals.kcal, 0)} kcal</strong>
            <span>P ${roundValue(totals.protein, 0)} g · UH ${roundValue(totals.carbs, 0)} g · M ${roundValue(totals.fat, 0)} g</span>
          </div>
        `
            : `<div class="empty">Počni da kucaš — prepoznate namirnice se pojavljuju ovde.</div>`
        }

        <div class="app-dialog-actions">
          <button class="solid-button button-with-icon" type="button" data-action="commit-quick-entry" ${live.length ? "" : "disabled"}>${renderButtonContent(live.length ? `Dodaj ${live.length} ${srPlural(live.length, "stavku", "stavke", "stavki")}` : "Dodaj u plan", "add")}</button>
          <button class="ghost-button" type="button" data-action="close-quick-entry">Otkaži</button>
        </div>
        ${unmatched.length ? `<p class="footer-note">${unmatched.length} ${srPlural(unmatched.length, "stavka nije prepoznata", "stavke nisu prepoznate", "stavki nije prepoznato")} i ${srPlural(unmatched.length, "biće preskočena", "biće preskočene", "biće preskočeno")}.</p>` : ""}
      </section>
    </div>
  `;
}

function renderPlanEntryComposer(meals, companionSuggestions, draftFood) {
  const activeMealLabel = normalizeMealLabel(state.planDraft.mealLabel || state.editingMealLabel || defaultMeals[0]);
  const planFoodSearchValue = draftFood?.name || "";

  const isEditing = Boolean(state.editingEntryId);
  const draftGrams = toNumber(state.planDraft.grams);

  // One field to start: the search. Amount + add only show up once a food is
  // picked (`.has-food`, kept in sync by handleInput), so an empty composer
  // is a single line instead of a two-step form.
  return `
    <form id="plan-entry-form" class="meal-composer ${draftFood ? "has-food" : ""} ${isEditing ? "is-editing-entry" : ""}">
      <input id="mealLabel" name="mealLabel" type="hidden" value="${escapeHtml(activeMealLabel)}" />
      ${isEditing ? `<div class="meal-composer-head"><span class="meal-composer-eyebrow">Izmena stavke</span></div>` : ""}
      <div class="field meal-composer-field">
        <div class="food-search-control has-scan">
          <span class="food-search-control-icon" aria-hidden="true">${renderSearchIcon()}</span>
          <button class="food-search-scan" type="button" data-action="open-scanner" data-scan-return="composer" aria-label="Skeniraj barkod proizvoda" title="Skeniraj barkod">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8"/><path d="M11 8v8"/><path d="M15 8v8"/><path d="M18 8v8"/></svg>
          </button>
          <input id="food-search-input" name="foodSearch" placeholder="Koju namirnicu dodaješ?" value="${escapeHtml(planFoodSearchValue)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" role="combobox" aria-autocomplete="list" aria-controls="food-suggest" aria-expanded="false" aria-label="Pretraga namirnica" required />
        </div>
        <input id="foodId" name="foodId" type="hidden" value="${state.planDraft.foodId}" />
        <div class="food-suggest" id="food-suggest" role="listbox" aria-label="Predlozi namirnica" hidden></div>
        <div class="food-match" id="food-match">${renderFoodMatchInner(draftFood)}</div>
      </div>
      <div class="meal-composer-when-food">
        <div class="field meal-composer-field" id="amount-field">${renderAmountFieldInner(draftFood)}</div>
        <div class="meal-composer-preview" id="entry-preview">${renderEntryPreviewInner(draftFood, draftGrams)}</div>
        <button class="solid-button button-with-icon meal-composer-submit" type="submit">${renderButtonContent(isEditing ? "Sačuvaj izmene" : "Dodaj", isEditing ? "save" : "add")}</button>
      </div>
      <div class="meal-composer-actions">
        ${
          isEditing
            ? `<button class="ghost-button meal-composer-delete" type="button" data-action="delete-entry" data-entry-id="${escapeHtml(state.editingEntryId)}">${renderButtonContent("Obriši stavku", "delete")}</button>
               <button class="ghost-button" type="button" data-action="cancel-edit-entry">Odustani</button>`
            : `<button class="ghost-button" type="button" data-action="finish-edit-meal" data-meal-label="${escapeHtml(state.editingMealLabel)}">Zatvori</button>`
        }
      </div>
      <div class="meal-composer-suggestions" id="companion-suggestions">${renderCompanionSuggestionsInner(companionSuggestions)}</div>
    </form>
  `;
}

// Shared preview body for the plan composer — used both on first render and by
// syncEntryPreview as you pick a food / type the amount.
function renderEntryPreviewInner(food, grams) {
  if (!food || !grams) {
    return "";
  }
  const totals = calculateEntry(food, grams);
  return `
    <div class="meal-composer-preview-line">
      <strong>${roundValue(totals.kcal, 0)} kcal</strong>
      <span>P ${totals.protein} · UH ${totals.carbs} · M ${totals.fat} g</span>
    </div>`;
}

// Confirmation chip shown under the food search field once typing resolves to
// a real match — used both on first render and patched live by handleInput so
// picking a food never leaves it ambiguous whether the search "took".
function renderFoodMatchInner(food) {
  if (!food) {
    return "";
  }
  return `
    <div class="food-match-chip">
      <span class="food-match-chip-name">${escapeHtml(food.name)}</span>
      <span class="food-match-chip-meta">${getFoodNutritionBasisLabel(food)} · ${roundValue(food.kcal, 0)} kcal</span>
      <button type="button" class="food-match-chip-clear" data-action="clear-plan-food-search" aria-label="Ukloni izabranu namirnicu">${renderActionIcon("close")}</button>
    </div>`;
}

function gramsPresetChipsMarkup(base, unitLabel) {
  const presets = [...new Set([Math.round(base / 2), base, base * 2])].filter((value) => value > 0);
  return presets
    .map(
      (value) =>
        `<button type="button" class="amount-preset-chip" data-action="set-plan-draft-grams" data-grams="${value}">${value} ${unitLabel}</button>`
    )
    .join("");
}

// One-tap amount presets scaled off the food's own serving basis (half / base /
// double), so common amounts don't need typing. Same live-patch pattern as the
// match chip above. Switches to spoon-count presets (1/2/3) when the draft's
// unit toggle is set to kašičica/kašika instead of grams.
function renderAmountPresetChipsInner(food) {
  if (!food) {
    return "";
  }
  const base = Math.max(1, roundValue(getFoodServingBaseValue(food), 0));
  if (getFoodServingUnit(food) === "piece") {
    return gramsPresetChipsMarkup(base, "kom");
  }
  const unit = state.planDraft.amountUnit || "g";
  if (unit === "g") {
    return gramsPresetChipsMarkup(base, "g");
  }
  return [1, 2, 3]
    .map((count) => {
      const grams = convertAmountUnitToGrams(count, unit);
      return `<button type="button" class="amount-preset-chip" data-action="set-plan-draft-grams" data-grams="${grams}">${count} ${pluralizeSpoonUnit(unit, count)}</button>`;
    })
    .join("");
}

// Everything for step 2 (label, unit toggle, stepper, presets) regenerates
// together whenever the food or unit changes — piece-based foods don't get
// a unit toggle at all, and grams vs. kašičica/kašika need different input
// wiring (a hidden real-grams field once the visible one isn't grams),
// so patching individual pieces would drift out of sync.
function renderAmountFieldInner(food) {
  const isPiece = getFoodServingUnit(food) === "piece";
  const grams = toNumber(state.planDraft.grams);
  const unit = isPiece ? "g" : state.planDraft.amountUnit || "g";
  const visibleInputId = isPiece ? "grams" : "amount-input";
  const labelText = isPiece
    ? "Broj komada"
    : unit === "tsp"
      ? "Broj kašičica"
      : unit === "tbsp"
        ? "Broj kašika"
        : "Količina u gramima";

  const unitSelectMarkup = isPiece
    ? `<span class="amount-unit-static">kom</span>`
    : `<select id="amount-unit-select" class="amount-unit-select" aria-label="Jedinica">${["g", "tsp", "tbsp"]
        .map((u) => `<option value="${u}" ${u === unit ? "selected" : ""}>${amountUnitLabel(u)}</option>`)
        .join("")}</select>`;

  const amountInputMarkup = isPiece
    ? `<input id="grams" name="grams" type="number" inputmode="decimal" min="1" step="1" placeholder="${getFoodQuantityPlaceholder(food)}" value="${state.planDraft.grams}" required />`
    : `
      <input id="amount-input" type="number" inputmode="decimal" min="0" step="${unit === "g" ? "1" : "0.5"}" placeholder="${unit === "g" ? getFoodQuantityPlaceholder(food) : "1"}" value="${grams ? convertGramsToAmountUnit(grams, unit) : ""}" required />
      <input id="grams" name="grams" type="hidden" value="${state.planDraft.grams}" />
    `;

  return `
    <label class="amount-label" for="${visibleInputId}">${labelText}</label>
    <div class="amount-stepper">
      <button type="button" class="amount-stepper-btn" data-action="nudge-plan-draft-grams" data-direction="-1" aria-label="Smanji količinu">${renderActionIcon("minus")}</button>
      ${amountInputMarkup}
      ${unitSelectMarkup}
      <button type="button" class="amount-stepper-btn" data-action="nudge-plan-draft-grams" data-direction="1" aria-label="Povećaj količinu">${renderActionIcon("add")}</button>
    </div>
    <div class="amount-presets" id="amount-presets">${renderAmountPresetChipsInner(food)}</div>
  `;
}

// Same g/kašičica/kašika toggle as the plan composer's amount field, for
// the recipe ingredient picker — no stepper or presets here since building
// a recipe is a slower, more deliberate flow than daily meal logging.
function renderFavoriteAmountFieldInner(food) {
  const isPiece = getFoodServingUnit(food) === "piece";
  const grams = toNumber(state.favoriteDraft.grams);
  const unit = isPiece ? "g" : state.favoriteDraft.amountUnit || "g";
  const visibleInputId = isPiece ? "favorite-grams" : "favorite-amount-input";
  const labelText = isPiece
    ? "Broj komada"
    : unit === "tsp"
      ? "Broj kašičica"
      : unit === "tbsp"
        ? "Broj kašika"
        : "Količina u gramima";

  const unitToggleMarkup = isPiece
    ? ""
    : `
      <div class="amount-unit-toggle">
        ${["g", "tsp", "tbsp"]
          .map(
            (u) =>
              `<button type="button" class="amount-unit-chip ${u === unit ? "is-active" : ""}" data-action="set-favorite-amount-unit" data-unit="${u}">${amountUnitLabel(u)}</button>`
          )
          .join("")}
      </div>
    `;

  const inputMarkup = isPiece
    ? `<input id="favorite-grams" name="grams" type="number" inputmode="decimal" min="1" step="1" placeholder="${getFoodQuantityPlaceholder(food)}" value="${state.favoriteDraft.grams}" required />`
    : `
      <input id="favorite-amount-input" type="number" inputmode="decimal" min="0" step="${unit === "g" ? "1" : "0.5"}" placeholder="${unit === "g" ? getFoodQuantityPlaceholder(food) : "1"}" value="${grams ? convertGramsToAmountUnit(grams, unit) : ""}" required />
      <input id="favorite-grams" name="grams" type="hidden" value="${state.favoriteDraft.grams}" />
    `;

  return `
    <label for="${visibleInputId}">${labelText}</label>
    ${unitToggleMarkup}
    ${inputMarkup}
  `;
}

// Companion suggestions depend on the food + amount currently in the draft,
// which handleInput patches live (no full render, to keep focus/caret intact
// while typing) — so this gets recomputed and re-patched from those same
// handlers instead of only at the last full render, or it'd show stale
// suggestions for whatever food was selected a few keystrokes ago.
function renderCompanionSuggestionsInner(suggestions) {
  if (!suggestions.length) {
    return "";
  }
  return `
    <div class="meal-composer-suggestions-label">Ide uz ovo</div>
    ${suggestions
      .map(
        (suggestion) => `
          <div class="suggestion-row">
            <div class="suggestion-row-copy">
              <strong>${escapeHtml(suggestion.food.name)}</strong>
              <span class="footer-note">${formatFoodAmount(suggestion.food, suggestion.grams)} · ${roundValue(suggestion.totals.kcal, 0)} kcal</span>
            </div>
            <button class="ghost-button button-with-icon suggestion-row-add" type="button" data-action="add-companion-suggestion" data-food-id="${suggestion.food.id}" data-grams="${roundValue(suggestion.grams, 0)}">
              ${renderButtonContent("Dodaj", "add")}
            </button>
          </div>
        `
      )
      .join("")}
  `;
}

function syncCompanionSuggestions() {
  const container = document.querySelector("#companion-suggestions");
  if (container) {
    container.innerHTML = renderCompanionSuggestionsInner(generateCompanionSuggestions());
  }
}

function truncateText(value, maxLength = 140) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function renderPlanSupplementsSection() {
  const supplements = getSupplementsForDay(state.selectedWeekday);
  const doneCount = supplements.filter((supplement) => isSupplementDoneForDay(supplement, state.selectedWeekday)).length;
  const editingSupplement = state.editingSupplementId
    ? store.supplements.find((supplement) => supplement.id === state.editingSupplementId)
    : null;
  const allSupplements = getSupplements();

  return `
    <section class="section plan-supplements-section ${state.planSupplementsExpanded ? "is-expanded" : "is-collapsed"}">
      <button
        class="section-disclosure"
        type="button"
        data-action="toggle-plan-supplements"
        aria-expanded="${state.planSupplementsExpanded}"
      >
        <div class="section-disclosure-copy">
          <h2>Vitamini i suplementi</h2>
          <p>${doneCount}/${supplements.length || 0} označeno za ${weekdayAccusative(state.selectedWeekday)}.</p>
        </div>
        <div class="section-disclosure-meta">
          <span class="pill note">${supplements.length} ${srPlural(supplements.length, "stavka", "stavke", "stavki")}</span>
          <span class="section-disclosure-icon" aria-hidden="true">${renderChevronIcon(state.planSupplementsExpanded)}</span>
        </div>
      </button>
      <div class="plan-section-body ${state.planSupplementsExpanded ? "is-expanded" : "is-collapsed"}">
      <div class="stats-grid stats-grid--glance plan-supplement-summary">
        <article class="stat-card">
          <strong>Za danas</strong>
          <div class="macro-value">${supplements.length}</div>
          <div class="footer-note">Planiranih stavki</div>
        </article>
        <article class="stat-card">
          <strong>Označeno</strong>
          <div class="macro-value">${doneCount}/${supplements.length || 0}</div>
          <div class="footer-note">Čekirano za ${weekdayAccusative(state.selectedWeekday)}</div>
        </article>
      </div>
      <div class="stack plan-supplement-stack" style="margin-top:14px;">
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
                            aria-label="${escapeHtml(supplement.name)}"
                            ${isSupplementDoneForDay(supplement, state.selectedWeekday) ? "checked" : ""}
                          />
                          <span class="routine-check-ui" aria-hidden="true"></span>
                        </label>
                        <div class="routine-content">
                          <strong>${escapeHtml(supplement.name)}</strong>
                          ${supplement.note ? `<div class="footer-note">${escapeHtml(supplement.note)}</div>` : ""}
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
            : `<div class="empty">Još nema suplemenata za danas — dodaj prvi ispod.</div>`
        }
      </div>
      <details class="form-collapse plan-supplement-manage" ${editingSupplement ? "open" : ""}>
        <summary>
          <span class="form-collapse-title">${editingSupplement ? "Izmena suplementa" : "Dodaj ili uredi suplemente"}</span>
          <span class="form-collapse-icon" aria-hidden="true">+</span>
        </summary>
        <form id="supplement-form" class="form-grid split goals-form-layout">
          <div class="field">
            <label for="supplement-name">${editingSupplement ? "Izmena suplementa" : "Novi suplement"}</label>
            <input id="supplement-name" name="name" placeholder="npr. Vitamin D3" value="${escapeHtml(editingSupplement?.name || "")}" required />
          </div>
          ${renderChoiceField(
            "Kada se uzima",
            "timing",
            editingSupplement?.timing || "breakfast",
            SUPPLEMENT_TIMINGS.map((timing) => ({ id: timing.id, label: timing.label }))
          )}
          <div class="field supplement-weekdays-field">
            <label>Za koje dane</label>
            <div class="chips weekday-choice-grid">
              ${WEEKDAYS.map((weekday) => {
                const checked = editingSupplement ? (editingSupplement.weekdays || []).includes(weekday) : true;
                return `
                  <label class="chip weekday-choice ${checked ? "is-active" : ""}">
                    <input type="checkbox" name="supplementWeekday" value="${weekday}" ${checked ? "checked" : ""} />
                    <span>${weekdayLabel(weekday).slice(0, 3)}</span>
                  </label>
                `;
              }).join("")}
            </div>
          </div>
          <div class="field">
            <label for="supplement-note">Napomena</label>
            <input id="supplement-note" name="note" placeholder="npr. posle obroka, uz magnezijum" value="${escapeHtml(editingSupplement?.note || "")}" />
          </div>
          <div class="meta-row">
            <button class="solid-button secondary-button" type="submit">${editingSupplement ? "Sačuvaj izmenu" : "Dodaj suplement"}</button>
            ${editingSupplement ? '<button class="ghost-button" type="button" data-action="cancel-edit-supplement">Odustani</button>' : ""}
          </div>
        </form>
        <div class="stack plan-supplement-manage-stack" style="margin-top:14px;">
          ${
            allSupplements.length
              ? allSupplements
                  .map(
                    (supplement) => `
                      <article class="food-card routine-card supplement-card">
                        <div class="routine-row">
                          <div class="routine-content">
                            <strong>${escapeHtml(supplement.name)}</strong>
                            ${supplement.note ? `<div class="footer-note">${escapeHtml(supplement.note)}</div>` : ""}
                            <div class="pill-row">
                              <span class="pill strong">${getSupplementTimingLabel(supplement.timing)}</span>
                              <span class="pill">${(supplement.weekdays || WEEKDAYS).length === WEEKDAYS.length ? "Svaki dan" : (supplement.weekdays || []).map((weekday) => weekdayLabel(weekday).slice(0, 3)).join(", ")}</span>
                            </div>
                          </div>
                          <div class="entry-actions" style="justify-content:flex-start; margin-top:0;">
                            <button class="ghost-button button-with-icon icon-only-action" type="button" data-action="edit-supplement" data-supplement-id="${supplement.id}" aria-label="Izmeni suplement" title="Izmeni">${renderButtonContent("Izmeni", "edit")}</button>
                            <button class="danger-button button-with-icon icon-only-action" type="button" data-action="delete-supplement" data-supplement-id="${supplement.id}" aria-label="Obriši suplement" title="Obriši">${renderButtonContent("Obriši", "delete")}</button>
                          </div>
                        </div>
                      </article>
                    `
                  )
                  .join("")
              : `<div class="empty">Dodaj prvi vitamin ili suplement.</div>`
          }
        </div>
      </details>
      </div>
    </section>
  `;
}

function getTodayWaterMl() {
  const today = getTodayDateValue();
  return Math.max(0, Math.round(toNumber((store.waterByDate || {})[today]) || 0));
}

// ---- Kafa -----------------------------------------------------------------
// Tap dodaje jednu šoljicu; kalorije su „kcal po šoljici“ iz Ciljeva (vidi
// COFFEE_KCAL_DEFAULT zašto jedan broj, a ne namirnica iz baze). Makroi se ne
// vode: crna kafa ih praktično nema, a ko doda šećer ili mleko ionako upisuje
// svoju procenu kalorija, iz koje se raspodela na P/UH/M ne može izvesti.
function getCoffeeCupKcal() {
  return Math.max(0, Math.round(toNumber(store.goals?.coffeeKcal)));
}

function getCoffeeCupsForDate(date) {
  return Math.max(0, Math.round(toNumber((store.coffeeByDate || {})[date]) || 0));
}

function getTodayCoffeeCups() {
  return getCoffeeCupsForDate(getTodayDateValue());
}

function getCoffeeTotalsForDate(date) {
  return { kcal: getCoffeeCupsForDate(date) * getCoffeeCupKcal(), protein: 0, carbs: 0, fat: 0 };
}

// Kafa je vezana za kalendarski datum, a jelovnik je nedeljni šablon — zato se
// upisuje u dan na ekranu samo kad je taj dan stvarno danas. Isto pravilo već
// prati potrošnja sa treninga (getTrainingBurnForDay u renderPlanTab).
function isSelectedDayToday() {
  return state.selectedWeekTrack === getCurrentWeekTrack() && state.selectedWeekday === getTodayWeekday();
}

function getSelectedDayCoffeeTotals() {
  return isSelectedDayToday() ? getCoffeeTotalsForDate(getTodayDateValue()) : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
}

// 1 šoljica, 2-4 šoljice, 5+ šoljica (i 11-14 idu na „šoljica“).
function coffeeCupsLabel(cups) {
  const count = Math.abs(Math.round(toNumber(cups)));
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo < 11 || lastTwo > 14) {
    if (last === 1) {
      return "šoljica";
    }
    if (last >= 2 && last <= 4) {
      return "šoljice";
    }
  }
  return "šoljica";
}

function renderPlanCoffeeRow() {
  // Samo na današnjem danu. Kafa se beleži po datumu i ulazi u zbir samo danas
  // (getSelectedDayCoffeeTotals), pa bi na utorku pisalo „1 šoljica · 10 kcal“
  // pored prstena koji tih 10 kcal ne broji — kontradikcija na istom ekranu.
  if (!isSelectedDayToday()) {
    return "";
  }
  const cups = getTodayCoffeeCups();
  const cupKcal = getCoffeeCupKcal();
  // Bez kcal po šoljici red je samo brojač — tada ni ne piše kalorije, umesto
  // da svuda kači „· 0 kcal“.
  const value = cups
    ? `${cups} ${coffeeCupsLabel(cups)}${cupKcal ? ` · ${cups * cupKcal} kcal` : ""}`
    : "0 šoljica";
  return `
      <div class="plan-glance-row">
        <span class="plan-glance-icon" aria-hidden="true">☕</span>
        <div class="plan-glance-copy">
          <div class="plan-glance-line"><span class="plan-glance-label">Kafa</span><span class="plan-glance-value">${escapeHtml(value)}</span></div>
          ${cupKcal ? `<div class="plan-glance-sub">${cupKcal} kcal po šoljici</div>` : ""}
        </div>
        ${
          cups > 0
            ? `<button class="plan-glance-btn plan-glance-btn--quiet" type="button" data-action="add-coffee" data-cups="-1" aria-label="Skini jednu šoljicu kafe">−</button>`
            : ""
        }
        <button class="plan-glance-btn" type="button" data-action="add-coffee" data-cups="1" aria-label="Dodaj šoljicu kafe${cupKcal ? `, ${cupKcal} kcal` : ""}">+1</button>
      </div>`;
}

// Water, coffee and steps live in the daily overview as rows (they used to be
// cards of their own, two screens below the glance they belong to).
function renderPlanGlanceRows() {
  const water = getTodayWaterMl();
  const waterTarget = Math.max(0, Math.round(toNumber(store.goals?.waterMl) || 2500));
  const waterPct = waterTarget ? Math.min(100, Math.round((water / waterTarget) * 100)) : 0;
  const waterDone = waterTarget > 0 && water >= waterTarget;
  const toL = (ml) => (ml % 1000 === 0 ? String(ml / 1000) : (ml / 1000).toFixed(1));
  const steps = getTodaySteps();
  const stepsGoal = Math.max(0, Math.round(toNumber(store.goals?.stepsGoal) || 10000));
  const stepsPct = stepsGoal ? Math.min(100, Math.round((steps / stepsGoal) * 100)) : 0;
  const stepsDone = stepsGoal > 0 && steps >= stepsGoal;
  const fmt = (n) => Math.round(n).toLocaleString("sr-RS");
  return `
    <div class="plan-glance-rows">
      <div class="plan-glance-row ${waterDone ? "is-done" : ""}">
        <span class="plan-glance-icon" aria-hidden="true">💧</span>
        <div class="plan-glance-copy">
          <div class="plan-glance-line"><span class="plan-glance-label">Voda</span><span class="plan-glance-value">${toL(water)} / ${toL(waterTarget)} L</span></div>
          <div class="plan-glance-bar"><span style="width:${waterPct}%"></span></div>
        </div>
        ${water > 0 ? `<button class="plan-glance-btn plan-glance-btn--quiet" type="button" data-action="add-water" data-ml="-250" aria-label="Skini 250 ml vode">−</button>` : ""}
        <button class="plan-glance-btn" type="button" data-action="add-water" data-ml="250" aria-label="Dodaj čašu vode, 250 ml">+250</button>
      </div>
      ${renderPlanCoffeeRow()}
      <div class="plan-glance-row ${stepsDone ? "is-done" : ""}">
        <span class="plan-glance-icon" aria-hidden="true">👟</span>
        <div class="plan-glance-copy">
          <div class="plan-glance-line"><span class="plan-glance-label">Koraci</span><span class="plan-glance-value">${fmt(steps)} / ${fmt(stepsGoal)}</span></div>
          ${
            state.stepsEditOpen
              ? `<div class="plan-glance-edit">
                  <input class="steps-input" id="steps-input" type="number" inputmode="numeric" min="0" step="100" placeholder="npr. 8432 sa sata" value="${steps || ""}" aria-label="Koraci danas" />
                  <button class="solid-button" type="button" data-action="set-steps">Sačuvaj</button>
                </div>`
              : `<div class="plan-glance-bar"><span style="width:${stepsPct}%"></span></div>`
          }
        </div>
        <button class="plan-glance-btn ${state.stepsEditOpen ? "is-active" : ""}" type="button" data-action="toggle-steps-edit" aria-label="${state.stepsEditOpen ? "Zatvori unos koraka" : "Unesi korake"}">${state.stepsEditOpen ? "Zatvori" : "Unesi"}</button>
      </div>
    </div>`;
}

function getTodaySteps() {
  const today = getTodayDateValue();
  return Math.max(0, Math.round(toNumber((store.stepsByDate || {})[today]) || 0));
}

// Rough distance from step count (avg stride ~0.76 m) — informational only.
function estimateStepsKm(steps) {
  return (Math.max(0, toNumber(steps)) * 0.762) / 1000;
}

// Manual steps for the day — read off your watch/phone and type it in (or use
// the quick chips). Tracked on its own; NOT folded into calories, because the
// "Apple Watch potrošnja" you enter already includes walking (would double-count).

// Dnevna aktivnost sa Apple Watch-a (za danas). Move kcal je već upisan u
// po-dan potrošnju pri uvozu, pa ovde samo prikazujemo pregled. Uvoz ide preko
// prečice (deep link #import-activity) ili clipboard-a (FITACT) — kao i trčanje.
// The daily-activity import runs through Apple Shortcuts, so the section is
// noise on every non-Apple device: show it on iPhone/iPad, or anywhere once a
// shortcut has been named or a day's activity has ever been imported.
function isAppleMobileDevice() {
  const ua = String(navigator.userAgent || "");
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
}

function shouldShowActivitySection() {
  if (isAppleMobileDevice()) {
    return true;
  }
  if (getShortcutName("activity")) {
    return true;
  }
  return Object.keys(store.activityByDate || {}).length > 0;
}

function renderPlanActivitySection() {
  if (!shouldShowActivitySection()) {
    return "";
  }
  const date = getTodayDateValue();
  const activity = getActivityForDate(date);
  const hasActivity = Boolean(activity);
  const activityShortcutName = getShortcutName("activity");
  const importBase = `${window.location.origin}${window.location.pathname.replace(/index\.html$/, "")}`;

  const tiles = [];
  if (activity) {
    if (activity.moveKcal != null) tiles.push({ text: `${activity.moveKcal} kcal (Move)`, strong: true });
    if (activity.exerciseMin != null) tiles.push({ text: `${activity.exerciseMin} min vežbanja` });
    if (activity.standHours != null) tiles.push({ text: `${activity.standHours} h stajanja` });
    if (activity.steps != null) tiles.push({ text: `${activity.steps.toLocaleString("sr-RS")} koraka` });
    if (activity.distanceKm != null) tiles.push({ text: `${roundValue(activity.distanceKm, 2)} km` });
  }

  return `
    <details class="section form-collapse form-collapse--view plan-activity-section" ${hasActivity ? "open" : ""}>
      <summary>
        <span class="form-collapse-title">Aktivnost sa sata</span>
        ${hasActivity && activity.moveKcal != null ? `<span class="pill strong">${activity.moveKcal} kcal</span>` : ""}
        <span class="form-collapse-icon form-collapse-icon--chevron" aria-hidden="true">${renderChevronIcon(false)}</span>
      </summary>
      <p class="footer-note plan-activity-intro">${
        hasActivity
          ? "Učitano sa Apple Watch-a — potrošene (Move) kalorije ulaze u dnevni bilans, osim na danima gde si kalorije treninga upisao po sekcijama (tamo važi tvoj zbir)."
          : "Povuci dnevni pregled sa Apple Watch-a: kalorije, vežbanje, stajanje, koraci, distanca."
      }</p>
      <div class="run-import-bar ${hasActivity ? "is-loaded" : ""}">
        <button class="solid-button button-with-icon run-import-button" type="button" data-action="launch-activity-shortcut">
          ${renderButtonContent("Sa sata", "open")}
        </button>
        <button class="ghost-button button-with-icon run-import-button" type="button" data-action="import-activity-clipboard">
          ${renderButtonContent("Iz clipboard-a", "copy")}
        </button>
        <p class="run-import-hint">${
          hasActivity
            ? "Učitano — tapni „Sa sata” da osvežiš."
            : "Tapni „Sa sata” — pokrene tvoju prečicu i vrati te ovde sa današnjom aktivnošću."
        }</p>
      </div>
      ${
        activityShortcutName
          ? `<div class="shortcut-note footer-note">Prečica: „${escapeHtml(activityShortcutName)}” · <button type="button" class="text-link-button" data-action="rename-activity-shortcut">promeni</button></div>`
          : ""
      }
      ${renderHelpNote(
        `<strong>Prečica te otvori i sačuva dnevnu aktivnost (jedan tap):</strong><br>1) <strong>Shortcuts</strong> → nova prečica. Za svaku metriku dodaj <strong>„Find Health Samples”</strong> za <em>danas</em> i saberi: Active Energy (kcal), Exercise (min), Stand (h), Steps, Walking+Running Distance.<br>2) <strong>„Open URLs”</strong> akcija sa ovim linkom (na ⟨…⟩ ubaci svoje vrednosti):<br><code>${escapeHtml(importBase)}#import-activity?move=⟨Active Energy⟩&ex=⟨Exercise⟩&stand=⟨Stand⟩&steps=⟨Steps⟩&dist=⟨Distance⟩</code><br>3) Pokreneš prečicu → app se otvori, današnja aktivnost sačuvana, Move kcal ušao u bilans.<br><br><strong>Rezerva (clipboard):</strong> „Copy to Clipboard” sa <code>FITACT;move=⟨kcal⟩;ex=⟨min⟩;stand=⟨h⟩;steps=⟨n⟩;dist=⟨km⟩</code>, pa tapni „Iz clipboard-a”.<br><br><em>Napomena:</em> koraci i distanca su info; samo Move kcal ulazi u bilans (uključuje i hodanje, pa nema duplog brojanja). Ako za taj dan u Treningu upišeš kalorije po sekcijama, važi taj zbir, a Move se ignoriše — da se isti trening ne broji dva puta.`,
        "Kako da povučem dnevnu aktivnost?",
        true
      )}
      ${
        hasActivity
          ? `<div class="pill-row plan-activity-metrics">
              ${tiles.map((tile) => `<span class="pill${tile.strong ? " strong" : ""}">${escapeHtml(tile.text)}</span>`).join("")}
            </div>
            ${
              activity.workouts && activity.workouts.length
                ? `<div class="pill-row plan-activity-workouts">${activity.workouts
                    .map(
                      (workout) =>
                        `<span class="pill strong">${escapeHtml(workout.name)}${workout.durationSec ? ` · ${formatRunDuration(workout.durationSec)}` : ""}${workout.kcal ? ` · ${workout.kcal} kcal` : ""}</span>`
                    )
                    .join("")}</div>`
                : ""
            }`
          : `<div class="empty">Još nema podataka za danas. Tapni „Sa sata” da pokreneš prečicu, ili „Iz clipboard-a” ako si već kopirao/la podatke.</div>`
      }
    </details>
  `;
}

// In-app reminders (no backend / push needed — works on static hosting).
// Surfaced as a dismissible banner at the top of the Plan tab on open.
function getTodayReminders() {
  const reminders = [];
  // Deliberately no "meals eaten" reminder here: the meal list with its
  // checkboxes sits right below this banner and the ring already counts them.
  // A reminder should point at something off-screen.
  const calibration = getGoalCalibration();
  if (calibration.status === "suggest") {
    reminders.push({
      text: `Predlog: cilj ${calibration.proposedTarget} kcal`,
      icon: "refresh",
      action: "open-goal-calibration",
      hint: `${calibration.delta > 0 ? "+" : ""}${calibration.delta} kcal`,
    });
  }
  const measurements = store.measurements || [];
  const nagSnoozedUntil = String(store.ui?.plan?.measurementNagSnoozedUntil || "");
  if (!measurements.length) {
    if (!nagSnoozedUntil || nagSnoozedUntil < getTodayDateValue()) {
      reminders.push({ text: "Dodaj prvo merenje", icon: "add", action: "toggle-quick-weight", hint: "Unesi težinu" });
    }
  } else {
    const latest = measurements.reduce((a, b) => (new Date(b.date) > new Date(a.date) ? b : a));
    // Compare local calendar days (both at noon), not raw ms: `new Date("YYYY-MM-DD")`
    // is UTC midnight, which lagged the count by up to 2h and delayed the reminder.
    const latestDay = getDateValueAsLocalDate(normalizeDateValue(latest.date));
    const todayDay = getDateValueAsLocalDate(getTodayDateValue());
    const days = latestDay && todayDay ? Math.round((todayDay.getTime() - latestDay.getTime()) / DAY_IN_MS) : 0;
    if (days >= 7) {
      reminders.push({ text: `Merenje: poslednje pre ${days} dana`, icon: "add", action: "toggle-quick-weight", hint: "Unesi težinu" });
    }
  }
  return reminders;
}

function renderTodayRemindersBanner() {
  if (store.ui?.plan?.remindersDismissedDate === getTodayDateValue()) {
    return "";
  }
  const reminders = getTodayReminders();
  if (!reminders.length) {
    return "";
  }
  return `
    <section class="section today-reminders" aria-label="Podsetnici za danas">
      <div class="today-reminders-row">
        <div class="pill-row today-reminders-pills">
          ${reminders
            .map(
              (reminder) => `<button class="pill strong pill--info reminder-chip" type="button" data-action="${reminder.action}" ${reminder.ml ? `data-ml="${reminder.ml}"` : ""} aria-label="${escapeHtml(reminder.text)} — ${escapeHtml(reminder.hint || "")}">${reminder.icon ? renderActionIcon(reminder.icon) : ""}<span class="reminder-chip-text">${escapeHtml(reminder.text)}</span>${reminder.hint ? `<span class="reminder-chip-hint">${escapeHtml(reminder.hint)}</span>` : ""}</button>`
            )
            .join("")}
        </div>
        <button class="ghost-button button-with-icon icon-only-action today-reminders-close" type="button" data-action="dismiss-reminders" aria-label="Sakrij podsetnike za danas" title="Sakrij za danas">${renderButtonContent("Sakrij", "close")}</button>
      </div>
      ${
        state.quickWeightOpen
          ? `
          <form id="quick-weight-form" class="quick-weight-form">
            <label for="quick-weight" class="quick-weight-label">Težina danas</label>
            <div class="quick-weight-controls">
              <input id="quick-weight" name="weightKg" type="number" inputmode="decimal" step="0.1" min="20" max="400" placeholder="npr. 84,5" required />
              <span class="quick-weight-unit">kg</span>
              <button class="solid-button button-with-icon" type="submit">${renderButtonContent("Sačuvaj", "save")}</button>
              <button class="ghost-button" type="button" data-action="jump-measurement">Više mera</button>
            </div>
          </form>`
          : ""
      }
    </section>`;
}

// Shopping-friendly amount: piece-based foods read as "kom", and anything from
// a kilogram up reads as kg instead of a long gram count.
function formatShoppingAmount(unit, amount) {
  const value = toNumber(amount);
  if (unit === "piece") {
    return `${roundValue(value, Number.isInteger(value) ? 0 : 1)} kom`;
  }
  if (value >= 1000) {
    return `${roundValue(value / 1000, value % 1000 === 0 ? 0 : 1)} kg`;
  }
  return `${roundValue(value, 0)} g`;
}

// Weekly shopping list: aggregate every food across the whole plan, summing the
// per-food amount (grams, or piece count for piece-based foods), grouped by
// category. Pure client-side (no backend).
function getShoppingList(weekTrack = state.selectedWeekTrack) {
  const totals = new Map();
  (store.weeklyPlanEntries || []).forEach((entry) => {
    if (normalizeWeekTrack(entry.weekTrack) !== weekTrack) {
      return;
    }
    const grams = toNumber(entry.grams);
    if (!grams) {
      return;
    }
    const food = getFoodById(entry.foodId) || store.foods.find((item) => item.name === entry.foodName);
    const key = entry.foodId || entry.foodName || (food && food.id);
    if (!key) {
      return;
    }
    const existing = totals.get(key);
    if (existing) {
      existing.grams += grams;
    } else {
      totals.set(key, {
        id: String(key),
        name: (food && food.name) || entry.foodName || "Nepoznata namirnica",
        grams,
        unit: food ? getFoodServingUnit(food) : "grams",
        category: (food && String(food.category || "").trim()) || "Ostalo",
      });
    }
  });
  return [...totals.values()].sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name, "sr") : a.category.localeCompare(b.category, "sr")
  );
}

// Plain-text shopping list for copy/share — grouped by category, friendly units,
// and excludes anything the user marked as "imam već".
function buildShoppingListText() {
  const staples = store.shoppingStaples || {};
  const items = getShoppingList().filter((item) => !staples[item.id]);
  if (!items.length) {
    return "Lista za kupovinu je prazna.";
  }
  const groups = {};
  items.forEach((item) => {
    (groups[item.category] = groups[item.category] || []).push(item);
  });
  const body = Object.keys(groups)
    .map((category) => {
      const lines = groups[category]
        .map((item) => `- ${item.name}: ${formatShoppingAmount(item.unit, item.grams)}`)
        .join("\n");
      return `${category.toUpperCase()}\n${lines}`;
    })
    .join("\n\n");
  return `Lista za kupovinu:\n\n${body}`;
}

function renderPlanShoppingSection() {
  const allItems = getShoppingList();
  const staples = store.shoppingStaples || {};
  const checked = store.shoppingChecked || {};
  const activeItems = allItems.filter((item) => !staples[item.id]);
  const stapleItems = allItems.filter((item) => staples[item.id]);
  const checkedCount = activeItems.filter((item) => checked[item.id]).length;

  const groups = {};
  activeItems.forEach((item) => {
    (groups[item.category] = groups[item.category] || []).push(item);
  });
  const listHtml = Object.keys(groups)
    .map(
      (category) => `
        <div class="shopping-group">
          <div class="shopping-group-title">${escapeHtml(category)}</div>
          ${groups[category]
            .map((item) => {
              const isChecked = Boolean(checked[item.id]);
              return `
                <div class="shopping-row ${isChecked ? "is-checked" : ""}">
                  <label class="shopping-item">
                    <input type="checkbox" data-action="toggle-shopping-item" data-food-id="${escapeHtml(item.id)}" ${isChecked ? "checked" : ""} aria-label="${escapeHtml(item.name)}" />
                    <span class="shopping-item-name">${escapeHtml(item.name)}</span>
                    <strong>${formatShoppingAmount(item.unit, item.grams)}</strong>
                  </label>
                  <button class="shopping-tag-button" type="button" data-action="mark-shopping-staple" data-food-id="${escapeHtml(item.id)}" aria-label="Označi da već imaš: ${escapeHtml(item.name)}">imam već</button>
                </div>`;
            })
            .join("")}
        </div>`
    )
    .join("");

  const stapleHtml = stapleItems.length
    ? `
      <div class="shopping-staples">
        <div class="shopping-group-title">Imam već (${stapleItems.length})</div>
        ${stapleItems
          .map(
            (item) => `
              <div class="shopping-row is-staple">
                <span class="shopping-item-name">${escapeHtml(item.name)}</span>
                <button class="shopping-tag-button" type="button" data-action="unmark-shopping-staple" data-food-id="${escapeHtml(item.id)}" aria-label="Vrati na listu: ${escapeHtml(item.name)}">vrati</button>
              </div>`
          )
          .join("")}
      </div>`
    : "";

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return `
    <section class="section plan-shopping-section ${state.shoppingExpanded ? "is-expanded" : "is-collapsed"}">
      <button class="section-disclosure" type="button" data-action="toggle-plan-shopping" aria-expanded="${state.shoppingExpanded}">
        <div class="section-disclosure-copy">
          <h2>Lista za kupovinu</h2>
          <p>${activeItems.length ? `${activeItems.length} ${srPlural(activeItems.length, "namirnica", "namirnice", "namirnica")} iz plana za ${getWeekTrackLabel(state.selectedWeekTrack).toLowerCase()}.` : "Dodaj namirnice u plan pa će se ovde sabrati."}</p>
        </div>
        <div class="section-disclosure-meta">
          <span class="pill note">${getWeekTrackLabel(state.selectedWeekTrack).toLowerCase()}</span>
          <span class="section-disclosure-icon" aria-hidden="true">${renderChevronIcon(state.shoppingExpanded)}</span>
        </div>
      </button>
      <div class="plan-section-body ${state.shoppingExpanded ? "is-expanded" : "is-collapsed"}">
        ${
          allItems.length
            ? `
              <div class="meta-row meta-row--compact shopping-actions">
                ${canShare ? `<button class="ghost-button button-with-icon" type="button" data-action="share-shopping-list">${renderButtonContent("Pošalji", "open")}</button>` : ""}
                <button class="ghost-button button-with-icon" type="button" data-action="copy-shopping-list">${renderButtonContent("Kopiraj listu", "save")}</button>
                ${checkedCount ? `<button class="ghost-button button-with-icon" type="button" data-action="clear-shopping-checks">${renderButtonContent("Poništi čekirano", "refresh")}</button>` : ""}
              </div>
              ${
                activeItems.length
                  ? `<div class="stack">${listHtml}</div>`
                  : `<div class="empty empty-passive">Sve namirnice su označene kao „imam već".</div>`
              }
              ${stapleHtml}
            `
            : `<div class="empty">Još nema namirnica u planu — dodaj obroke pa se lista sama sastavi.</div>`
        }
      </div>
    </section>`;
}

// First-run orientation for a brand-new user: shown only while the whole weekly
// plan is empty, so it disappears on its own as soon as they add anything. Steps
// adapt to what's already done and reuse existing actions (no new JS handler).
// Shared 14-slot (weekday, weekTrack) picker chip grid — one row per track,
// each row labeled "Ova nedelja"/"Sledeća nedelja". Used by meal-prep's "pick
// exact days" mode and by the bulk "delete multiple days" panel so both
// features look and behave identically.
function renderWeekTrackDayPicker({ action, selectedPairs = [], excludePair = null, dataset = {} }) {
  const extraAttrs = Object.entries(dataset)
    .map(([key, value]) => ` data-${escapeHtml(key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))}="${escapeHtml(String(value))}"`)
    .join("");
  return getWeekTrackDisplayOrder()
    .map((track) => {
      const chips = WEEKDAYS.map((weekday) => {
        if (excludePair && excludePair.weekday === weekday && excludePair.weekTrack === track) {
          return `<span class="prep-day-chip is-source">${escapeHtml(weekdayLabel(weekday))}</span>`;
        }
        const isOn = selectedPairs.some((pair) => pair.weekday === weekday && pair.weekTrack === track);
        return `<button type="button" class="prep-day-chip ${isOn ? "is-on" : ""}" data-action="${action}" data-weekday="${escapeHtml(weekday)}" data-week-track="${track}"${extraAttrs} aria-pressed="${isOn}">${escapeHtml(weekdayLabel(weekday))}</button>`;
      }).join("");
      return `
        <div class="week-track-day-picker-row">
          <span class="hero-picker-label">${getWeekTrackLabel(track)}</span>
          <div class="prep-day-picker">${chips}</div>
        </div>`;
    })
    .join("");
}

// "Uto" if same track as the reference day, "Uto (druga nedelja)" if it
// crosses into the other track — disambiguates the 14-slot prep day list.
function formatWeekTrackDayLabel(day, referenceWeekTrack) {
  const base = weekdayLabel(day.weekday);
  return day.weekTrack === referenceWeekTrack ? base : `${base} (druga nedelja)`;
}

// Inline "kuvaj unapred" panel under a meal: pick how many days (or exact days)
// and see the total to cook in one batch before confirming.
function renderMealPrepPanel(mealLabel) {
  const plan = getMealPrepPlan(mealLabel);
  const mealTitle = getMealDisplayParts(mealLabel).title || mealLabel;
  const currentDays = Math.max(1, roundValue(toNumber(state.prepDays) || 2, 0));

  const countChips = [2, 3, 4, 5]
    .map((n) => {
      const active = state.prepMode === "next" && currentDays === n;
      return `<button type="button" class="prep-chip ${active ? "is-active" : ""}" data-action="set-meal-prep-days" data-days="${n}" data-meal-label="${escapeHtml(mealLabel)}">${n} dana</button>`;
    })
    .join("");

  const pickActive = state.prepMode === "pick";
  const pickChips = pickActive
    ? renderWeekTrackDayPicker({
        action: "toggle-meal-prep-day",
        selectedPairs: state.prepPickDays || [],
        excludePair: { weekday: plan.sourceDay, weekTrack: plan.sourceWeekTrack },
        dataset: { mealLabel },
      })
    : "";

  const daysList = [{ weekday: plan.sourceDay, weekTrack: plan.sourceWeekTrack }, ...plan.targetDays]
    .map((day) => formatWeekTrackDayLabel(day, plan.sourceWeekTrack))
    .join(", ");
  const cookHtml = plan.cookItems.length
    ? plan.cookItems
        .map(
          (item) =>
            `<li><span>${escapeHtml(item.name)}</span><strong>${formatShoppingAmount(item.unit, item.totalGrams)}</strong></li>`
        )
        .join("")
    : `<li class="prep-cook-empty">Ovaj obrok je prazan — dodaj namirnice.</li>`;

  const canConfirm = plan.sourceEntries.length > 0 && plan.targetDays.length > 0;

  return `
    <div class="meal-prep-panel">
      <div class="meal-prep-head">
        <strong>Kuvaj „${escapeHtml(mealTitle)}" unapred</strong>
        <button class="prep-close" type="button" data-action="close-meal-prep" aria-label="Zatvori">✕</button>
      </div>
      <div class="prep-chips">
        ${countChips}
        <button type="button" class="prep-chip ${pickActive ? "is-active" : ""}" data-action="set-meal-prep-mode" data-mode="pick" data-meal-label="${escapeHtml(mealLabel)}">Izaberi dane</button>
      </div>
      ${pickChips}
      <div class="prep-summary">
        <div class="footer-note">Skuvaj za <strong>${plan.totalDays} dana</strong>${
          plan.targetDays.length ? ` (${escapeHtml(daysList)})` : " — izaberi bar jedan dan"
        }:</div>
        <ul class="prep-cook-list">${cookHtml}</ul>
      </div>
      <div class="entry-actions prep-actions">
        <button class="solid-button secondary-button button-with-icon" data-action="confirm-meal-prep" data-meal-label="${escapeHtml(mealLabel)}" ${
          canConfirm ? "" : "disabled"
        }>${renderButtonContent("Pripremi", "apply")}</button>
        <button class="ghost-button" type="button" data-action="close-meal-prep">Odustani</button>
      </div>
    </div>`;
}

function renderPlanWelcomeGuide(calorieGoal) {
  const name = String(store.profile?.name || "").trim();
  const hasGoal = calorieGoal > 0;
  return `
    <section class="section plan-welcome-guide">
      <div class="plan-welcome-head">
        <h2>Dobrodošli${name ? `, ${escapeHtml(name)}` : ""} 👋</h2>
        <p>Tvoj plan je još prazan. Evo kako da ga pokreneš za par tapova — ovaj vodič nestaje čim dodaš prvi obrok.</p>
      </div>
      <ol class="plan-welcome-steps">
        <li class="plan-welcome-step ${hasGoal ? "is-done" : ""}">
          <span class="plan-welcome-step-num" aria-hidden="true">${
            hasGoal
              ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`
              : "1"
          }</span>
          <div class="plan-welcome-step-body">
            <strong>Postavi dnevni cilj</strong>
            <span>${
              hasGoal
                ? `Cilj ti je ${calorieGoal} kcal — promeni ga u Ciljevima kad god hoćeš.`
                : "Kalorije i makroe koje pratimo svaki dan."
            }</span>
            ${
              hasGoal
                ? ""
                : `<div class="plan-welcome-actions"><button class="solid-button secondary-button button-with-icon" type="button" data-action="switch-tab" data-tab="goals">${renderButtonContent("Postavi cilj", "open")}</button></div>`
            }
          </div>
        </li>
        <li class="plan-welcome-step">
          <span class="plan-welcome-step-num" aria-hidden="true">2</span>
          <div class="plan-welcome-step-body">
            <strong>Sastavi prvi dan</strong>
            <span>Dodaj obroke za ${weekdayAccusative(state.selectedWeekday)} ispod — makroi se računaju sami.</span>
          </div>
        </li>
        <li class="plan-welcome-step">
          <span class="plan-welcome-step-num" aria-hidden="true">3</span>
          <div class="plan-welcome-step-body">
            <strong>Istraži bazu i recepte</strong>
            <span>Gotova baza namirnica i tvoji recepti — sve ubacuješ u plan jednim tapom.</span>
            <div class="plan-welcome-actions">
              <button class="ghost-button button-with-icon" type="button" data-action="switch-tab" data-tab="foods">${renderButtonContent("Namirnice", "open")}</button>
              <button class="ghost-button button-with-icon" type="button" data-action="switch-tab" data-tab="recipes">${renderButtonContent("Recepti", "open")}</button>
            </div>
          </div>
        </li>
      </ol>
    </section>
  `;
}

// Segmented "Ova / Sledeća" week-track control, shared by the Plan hero and the
// Training / Routine sections. (The old `.chips.hero-day-chips` version inside
// a section collapsed to ~40px per chip on phones — flex-basis 0 in a
// shrink-to-fit container — so "Sledeća" overflowed its pill.)
function renderWeekTrackToggle() {
  return `
      <div class="hero-week-toggle" role="group" aria-label="Nedelja">
        ${getWeekTrackDisplayOrder()
          .map(
            (track) => `
              <button class="chip hero-week-chip ${track === state.selectedWeekTrack ? "is-active" : ""}" type="button" data-action="select-week-track" data-week-track="${track}" aria-pressed="${track === state.selectedWeekTrack}" title="${getWeekTrackLabel(track)}">
                ${getWeekTrackLabel(track).replace(" nedelja", "")}
              </button>
            `
          )
          .join("")}
      </div>`;
}

function renderWeekTrackRow() {
  return `
      <div class="week-track-row">
        <span class="hero-day-label">Nedelja</span>
        ${renderWeekTrackToggle()}
      </div>`;
}

// The collapsed daily-overview row on phones. The remaining-calories glance is
// the reason people open the app mid-day; hiding it behind a tap (a text line
// with eaten totals) buried the one number that matters.
// Eaten vs planned for the selected day. The plan is the whole day's food; what
// you've actually checked off is a subset. The ring draws both: strong arc =
// eaten, faint arc = still planned, so "is my plan inside the budget" and "how
// far into the day am I" are both readable at a glance.
function getDayRingFacts(entries, totals, calorieGoal, extraEaten = null) {
  // Kafa (i sve što se beleži tapom, a ne planira kao obrok) je popijena u
  // trenutku unosa, pa ide direktno na stranu „pojedeno“ — nema čekboks da ga
  // čeka. U `totals` je već uračunata (renderPlanTab), ovde ulazi u „eaten“.
  const eaten = addTotals(getDayTotals(entries.filter((entry) => entry.done)), extraEaten || {});
  const plannedKcal = roundValue(totals.kcal, 0);
  const eatenKcal = roundValue(eaten.kcal, 0);
  const allDone = entries.length > 0 && entries.every((entry) => entry.done);
  const clamp = (value) => (calorieGoal > 0 ? Math.min(1, Math.max(0, value / calorieGoal)) : 0);
  return {
    plannedKcal,
    eatenKcal,
    allDone,
    plannedFraction: clamp(plannedKcal),
    eatenFraction: clamp(eatenKcal),
    // "1838 / 2061 kcal u planu" while the day is open, "pojedeno" once every
    // meal is checked; the eaten count sits alongside while it differs.
    metaLabel: `${plannedKcal} / ${calorieGoal} kcal ${allDone ? "pojedeno" : "u planu"}`,
    eatenNote: !allDone && eatenKcal > 0 ? `${eatenKcal} pojedeno` : "",
  };
}

function renderPlanSummaryCompact(totals, calorieGoal, remainingCalories, calorieState, ring) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ring.eatenFraction);
  const plannedOffset = circumference * (1 - ring.plannedFraction);
  // The three macros as slim bars under the headline — same ok/near/over
  // semantics as the expanded macro cards (renderProgress), just quieter.
  const macros = [
    { short: "P", label: "Proteini", value: totals.protein, goal: store.goals.protein, kind: "target" },
    { short: "UH", label: "Ugljeni hidrati", value: totals.carbs, goal: store.goals.carbs, kind: "limit" },
    { short: "M", label: "Masti", value: totals.fat, goal: store.goals.fat, kind: "limit" },
  ];
  return `
    <div class="plan-summary-compact" data-state="${calorieState}">
      <div class="plan-summary-compact-main">
        <svg class="plan-mini-ring" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="cal-ring-track" cx="18" cy="18" r="${radius}"></circle>
          <circle class="cal-ring-planned" cx="18" cy="18" r="${radius}" style="stroke-dasharray:${circumference.toFixed(2)};stroke-dashoffset:${plannedOffset.toFixed(2)};"></circle>
          <circle class="cal-ring-fill" cx="18" cy="18" r="${radius}" style="stroke-dasharray:${circumference.toFixed(2)};stroke-dashoffset:${offset.toFixed(2)};"></circle>
        </svg>
        <div class="plan-summary-compact-copy">
          <strong class="plan-summary-compact-value">${Math.abs(remainingCalories)}<span>kcal ${remainingCalories >= 0 ? "preostalo" : "preko cilja"}</span></strong>
          <span class="plan-summary-compact-meta">${ring.metaLabel}${ring.eatenNote ? ` · <span class="plan-summary-compact-eaten">${ring.eatenNote}</span>` : ""}</span>
        </div>
      </div>
      <div class="plan-summary-compact-macros" aria-label="Makroi danas">
        ${macros
          .map(
            (macro) => `
          <div class="plan-summary-compact-macro">
            <span class="plan-summary-compact-macro-label"><span class="plan-summary-compact-macro-short">${macro.short}</span><span class="plan-summary-compact-macro-long">${macro.label}</span></span>
            <span class="plan-summary-compact-macro-value">${roundValue(macro.value, 0)}<span>${macro.goal ? ` / ${roundValue(macro.goal, 0)}` : ""} g</span></span>
            ${renderProgress(toNumber(macro.value), toNumber(macro.goal), macro.kind)}
          </div>`
          )
          .join("")}
      </div>
    </div>`;
}

function renderPlanTab(entries) {
  const groupedEntries = groupEntriesByMeal(entries);
  // Kafa se beleži po datumu, ne kao stavka nedeljnog šablona, pa se sabira
  // preko plana — i to samo na danu kome pripada (getSelectedDayCoffeeTotals).
  const coffeeTotals = getSelectedDayCoffeeTotals();
  const totals = addTotals(getDayTotals(entries), coffeeTotals);
  // Burn is logged per weekday for the current week only (it isn't a template),
  // so the other track has nothing to show — don't mirror this week's numbers.
  const trainingBurn = state.selectedWeekTrack === getCurrentWeekTrack() ? getTrainingBurnForDay(state.selectedWeekday) : 0;
  const netCalories = roundValue(totals.kcal - trainingBurn, 0);
  const calorieGoal = roundValue(store.goals.calories, 0);
  const remainingCalories = roundValue(calorieGoal - totals.kcal, 0);
  const calorieRatio = calorieGoal ? totals.kcal / calorieGoal : 0;
  const calorieState = !calorieGoal ? "neutral" : calorieRatio > 1.1 ? "over" : calorieRatio > 1.0 ? "near" : "ok";
  const ringCircumference = 326.7; // 2π·52
  const ringFacts = getDayRingFacts(entries, totals, calorieGoal, coffeeTotals);
  const ringOffset = roundValue(ringCircumference * (1 - ringFacts.eatenFraction), 1);
  const ringPlannedOffset = roundValue(ringCircumference * (1 - ringFacts.plannedFraction), 1);
  const caloriePct = calorieGoal ? Math.round(calorieRatio * 100) : 0;
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
  const companionSuggestions = generateCompanionSuggestions();
  const draftFood = getDraftFood();

  return `
    ${(store.weeklyPlanEntries || []).length === 0 ? renderPlanWelcomeGuide(calorieGoal) : ""}

    <section class="section plan-summary-section ${state.planSummaryExpanded ? "is-expanded" : "is-collapsed"}">
      <button
        class="section-disclosure"
        type="button"
        data-action="toggle-plan-summary"
        aria-expanded="${state.planSummaryExpanded}"
      >
        <div class="section-disclosure-copy">
          <h2>Dnevni pregled</h2>
          ${
            !state.planSummaryExpanded && calorieGoal
              ? renderPlanSummaryCompact(totals, calorieGoal, remainingCalories, calorieState, ringFacts)
              : `<p>${roundValue(totals.kcal, 0)} kcal · P ${roundValue(totals.protein, 0)} · UH ${roundValue(totals.carbs, 0)} · M ${roundValue(totals.fat, 0)} g</p>`
          }
        </div>
        <div class="section-disclosure-meta">
          <span class="section-disclosure-icon" aria-hidden="true">${renderChevronIcon(state.planSummaryExpanded)}</span>
        </div>
      </button>
      <div class="plan-section-body ${state.planSummaryExpanded ? "is-expanded" : "is-collapsed"}">
      ${
        calorieGoal
          ? `
      <div class="cal-ring" data-state="${calorieState}">
        <div class="cal-ring-dial">
          <svg class="cal-ring-svg" viewBox="0 0 120 120" aria-hidden="true">
            <circle class="cal-ring-track" cx="60" cy="60" r="52"></circle>
            <circle class="cal-ring-planned" cx="60" cy="60" r="52" style="stroke-dasharray:${ringCircumference};stroke-dashoffset:${ringPlannedOffset};"></circle>
            <circle class="cal-ring-fill" cx="60" cy="60" r="52" style="stroke-dasharray:${ringCircumference};stroke-dashoffset:${ringOffset};"></circle>
          </svg>
          <div class="cal-ring-center">
            <span class="cal-ring-label">${remainingCalories >= 0 ? "preostalo" : "preko cilja"}</span>
            <strong class="cal-ring-value">${Math.abs(remainingCalories)}</strong>
            <span class="cal-ring-unit">kcal</span>
          </div>
        </div>
        <div class="cal-ring-meta">${ringFacts.metaLabel}${ringFacts.eatenNote ? ` · <span class="cal-ring-eaten">${ringFacts.eatenNote}</span>` : ""}</div>
      </div>
      `
          : `
      <div class="plan-summary-headline is-empty">
        <div class="plan-summary-headline-main">
          <span class="plan-summary-headline-label">Danas uneto</span>
          <strong class="plan-summary-headline-value plan-summary-headline-value--prompt">${roundValue(totals.kcal, 0)}<span class="plan-summary-headline-unit">kcal</span></strong>
          <span class="footer-note">Postavi kalorijski cilj da pratiš koliko ti je ostalo.</span>
        </div>
        <button class="solid-button secondary-button button-with-icon" type="button" data-action="switch-tab" data-tab="goals">${renderButtonContent("Postavi cilj", "open")}</button>
      </div>
      `
      }
      ${
        trainingBurn > 0
          ? `
      <div class="plan-net-row">
        <div class="plan-net-item">
          <span class="plan-net-label">Uneto</span>
          <strong>${roundValue(totals.kcal, 0)}</strong>
        </div>
        <span class="plan-net-op" aria-hidden="true">−</span>
        <div class="plan-net-item">
          <span class="plan-net-label">Sagorelo</span>
          <strong>${roundValue(trainingBurn, 0)}</strong>
        </div>
        <span class="plan-net-op" aria-hidden="true">=</span>
        <div class="plan-net-item plan-net-item--total">
          <span class="plan-net-label">Neto</span>
          <strong>${netCalories}</strong>
        </div>
      </div>
      <div class="footer-note plan-net-note">Neto = uneto − sagorelo (kalorije treninga: zbir sekcija, ili broj sa sata kad sekcije nisu upisane)</div>
      `
          : ""
      }
      <div class="plan-summary-layout">
        ${renderMacroCards(totals, { excludeCalories: true })}
        ${renderPlanGlanceRows()}
      </div>
      </div>
    </section>

    ${renderTodayRemindersBanner()}

    <section class="section plan-meals-section">
      <div class="section-header">
        <div>
          <h2>Obroci za ${weekdayAccusative(state.selectedWeekday)}${
            state.selectedWeekTrack === getCurrentWeekTrack() ? "" : ` · ${getWeekTrackLabel(state.selectedWeekTrack).toLowerCase()}`
          }</h2>
          <p>${entries.length ? "" : "Još nema stavki za ovaj dan."}</p>
        </div>
        <button class="ghost-button button-with-icon plan-quick-entry-button" type="button" data-action="open-quick-entry">${renderButtonContent("Brzi unos", "edit")}</button>
      </div>
      ${renderHelpNote("<strong>„Brzi unos“</strong> gore desno primi ceo obrok u jednoj rečenici („200 g piletine, 150 pirinča i 2 jajeta u ručak“) — prepozna namirnice iz tvoje baze, a ti potvrdiš. Ili otvori obrok pa <strong>„Dodaj namirnicu“</strong> jednu po jednu. <strong>Tapni namirnicu</strong> u obroku da joj promeniš količinu ili je obrišeš. Kad pojedeš obrok, <strong>čekiraj ga</strong> — tek tad ulazi u dnevni zbir kalorija i u dnevnik. <strong>Kuvaj unapred</strong> kopira obrok na više dana odjednom (meal-prep), a <strong>Kopiraj dan</strong> prebacuje ceo dan na drugi. Plan je nedeljni šablon — isti je svake nedelje dok ga ne promeniš.")}
      <div class="stack">
        ${
          planMeals.length
            ? planMeals
                .map(([mealLabel, mealEntries]) => {
                  const mealParts = getMealDisplayParts(mealLabel);
                  const isEditingMeal = state.editingMealLabel === mealLabel;
                  const isMealDone = mealEntries.length > 0 && mealEntries.every((entry) => entry.done);
                  // Empty meals have no checkbox/chevron to expand them (those only render
                  // once there are entries), so never collapse an empty meal - otherwise
                  // "Dodaj namirnicu" is stuck hidden with no way to reveal it.
                  const isMealCollapsed = mealEntries.length > 0 && isMealCollapsedForWeekday(state.selectedWeekday, mealLabel);
                  const mealTotals = getDayTotals(mealEntries);
                  const prepBadgeCount = getMealPrepBadgeCount(mealLabel, mealEntries);
                  return `
                    <article class="meal-card ${isEditingMeal ? "is-editing" : ""} ${isMealDone ? "is-done" : ""} ${isMealCollapsed ? "is-collapsed" : ""}">
                      <div class="meal-swipe-reveal" aria-hidden="true">Pojedeno</div>
                      <div class="meal-card-header">
                        <div class="meal-card-topline">
                          ${mealParts.order ? `<span class="meal-order">${mealParts.order}</span>` : ""}
                          <div class="meal-card-heading">
                            <h3 class="meal-title">${escapeHtml(mealParts.title || mealLabel)}</h3>
                            ${
                              prepBadgeCount >= 2
                                ? `<span class="meal-prep-badge" title="Isti obrok je u planu ${prepBadgeCount} dana">🍲 Spremljeno za ${prepBadgeCount} dana</span>`
                                : ""
                            }
                            ${isEditingMeal ? `<div class="footer-note">Uređuješ ovaj obrok</div>` : ""}
                          </div>
                          ${
                            mealEntries.length
                              ? `
                                <label class="meal-toggle ${isMealDone ? "is-done" : ""}" title="${isMealDone ? "Obrok je pojeden — klikni da skineš oznaku" : "Označi obrok kao pojeden"}">
                                  <input class="meal-toggle-checkbox" type="checkbox" data-action="toggle-plan-meal-done" data-meal-label="${escapeHtml(mealLabel)}" ${isMealDone ? "checked" : ""} aria-label="${isMealDone ? "Skini oznaku da je obrok pojeden" : "Označi obrok kao pojeden"}" />
                                  <span class="meal-toggle-ui" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
                                  </span>
                                </label>
                                <button
                                  class="ghost-button meal-collapse-toggle"
                                  type="button"
                                  data-action="toggle-plan-meal-collapse"
                                  data-meal-label="${escapeHtml(mealLabel)}"
                                  aria-expanded="${!isMealCollapsed}"
                                  aria-label="${isMealCollapsed ? "Raširi obrok" : "Skupi obrok"}"
                                >
                                  <svg class="meal-collapse-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
                                </button>
                              `
                              : ""
                          }
                        </div>
                        ${
                          mealEntries.length
                            ? `
                              <div class="meal-card-summary">
                                <div class="meal-card-summary-kcal">
                                  <strong>${roundValue(mealTotals.kcal, 0)} kcal</strong>
                                </div>
                                <div class="meal-card-summary-macros" aria-label="Makroi obroka">
                                  <div class="meal-summary-macro">
                                    <span class="meal-summary-label">Protein</span>
                                    <strong>P ${roundValue(mealTotals.protein, 1)} g</strong>
                                  </div>
                                  <div class="meal-summary-macro">
                                    <span class="meal-summary-label">Ugljeni hidrati</span>
                                    <strong>UH ${roundValue(mealTotals.carbs, 1)} g</strong>
                                  </div>
                                  <div class="meal-summary-macro">
                                    <span class="meal-summary-label">Masti</span>
                                    <strong>M ${roundValue(mealTotals.fat, 1)} g</strong>
                                  </div>
                                </div>
                              </div>
                            `
                            : ""
                        }
                      </div>
                      <div class="meal-card-content ${isMealCollapsed ? "is-hidden" : ""}">
                        ${
                          isMealDone
                            ? `
                              <div class="meal-done-note">
                                Ovaj obrok je označen kao završen. Skini čekiranje ako želiš da ga menjaš.
                              </div>
                            `
                            : ""
                        }
                        ${state.prepMealLabel === mealLabel && !isMealDone ? renderMealPrepPanel(mealLabel) : ""}
                        ${
                          mealEntries.length
                            ? mealEntries
                                .map(
                                  (entry) => `
                                    <div class="meal-entry ${entry.done ? "is-done" : ""} ${entry.id === state.lastAddedEntryId ? "is-new" : ""} ${entry.id === state.editingEntryId ? "is-editing" : ""}">
                                      <div class="meal-entry-row">
                                      ${isMealDone ? `<div class="meal-entry-body">` : `<button class="meal-entry-body" type="button" data-action="edit-entry" data-entry-id="${entry.id}" aria-label="${escapeHtml(entry.foodName)}, ${escapeHtml(formatFoodAmount(entry.food, entry.grams))} — izmeni količinu">`}
                                        <div class="meal-entry-main">
                                          <div class="meal-entry-title-group">
                                            <strong>${escapeHtml(entry.foodName)}</strong>
                                          </div>
                                        </div>
                                        <div class="meal-entry-stats">
                                          <span class="meal-entry-grams">${formatFoodAmount(entry.food, entry.grams)}</span>
                                          <span class="pill note">${roundValue(entry.totals.kcal, 0)} kcal</span>
                                          <span class="meal-entry-macros">P ${roundValue(entry.totals.protein, 1)} · UH ${roundValue(entry.totals.carbs, 1)} · M ${roundValue(entry.totals.fat, 1)} g</span>
                                        </div>
                                      ${isMealDone ? `</div>` : `</button>`}
                                      ${
                                        // Izmena i brisanje direktno u redu: ranije se do brisanja
                                        // stizalo tek kroz kompozitor, dva tapa za nešto što se
                                        // najčešće radi odmah po unosu. Sakriveno kad je obrok
                                        // čekiran, jer se tada ionako ništa ne menja.
                                        isMealDone
                                          ? ""
                                          : `<div class="meal-entry-actions">
                                              <button class="meal-entry-action" type="button" data-action="edit-entry" data-entry-id="${entry.id}" aria-label="Izmeni količinu: ${escapeHtml(entry.foodName)}" title="Izmeni količinu">${renderActionIcon("edit")}</button>
                                              <button class="meal-entry-action meal-entry-action--danger" type="button" data-action="delete-entry" data-entry-id="${entry.id}" aria-label="Obriši iz obroka: ${escapeHtml(entry.foodName)}" title="Obriši iz obroka">${renderActionIcon("delete")}</button>
                                            </div>`
                                      }
                                      </div>
                                    </div>
                                  `
                                )
                                .join("")
                            : (() => {
                                const previous = getPreviousPlanDay(state.selectedWeekday, state.selectedWeekTrack);
                                const previousEntries = getPlanEntriesForDay(previous.weekday, previous.weekTrack).filter((entry) => normalizeMealLabel(entry.mealLabel) === mealLabel);
                                const canCopy = previousEntries.length > 0 && !isMealDone;
                                // The "Dodaj namirnicu" row renders right below and already says
                                // the meal is empty. Repeating it in five stacked cards is what
                                // made a new user's first screen 600px of the same sentence — so
                                // the message stays only when it carries something extra (the
                                // copy-from-yesterday shortcut) or when there is no add row at
                                // all because the meal is already checked off.
                                if (!canCopy) {
                                  return isMealDone ? `<div class="empty meal-empty">Još nema stavki u ovom obroku.</div>` : "";
                                }
                                return `<div class="empty meal-empty">Još nema stavki u ovom obroku.<div class="meal-empty-actions"><button class="ghost-button button-with-icon" type="button" data-action="copy-meal-from-previous-day" data-meal-label="${escapeHtml(mealLabel)}">${renderButtonContent(`Kopiraj od juče (${previousEntries.length})`, "copy")}</button></div></div>`;
                              })()
                        }
                        ${
                          !isMealDone
                            ? isEditingMeal
                              ? renderPlanEntryComposer(meals, companionSuggestions, draftFood)
                              : `<button class="meal-add-row" type="button" data-action="start-add-to-meal" data-meal-label="${escapeHtml(mealLabel)}">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                                  <span>Dodaj namirnicu</span>
                                </button>`
                            : ""
                        }
                        ${
                          !isMealDone && mealEntries.length && !isEditingMeal
                            ? `<div class="meal-secondary-actions">
                                <button class="meal-secondary-action" type="button" data-action="open-meal-prep" data-meal-label="${escapeHtml(mealLabel)}">Pripremi za više dana</button>
                                <button class="meal-secondary-action" type="button" data-action="save-meal-as-favorite" data-meal-label="${escapeHtml(mealLabel)}">Sačuvaj kao recept</button>
                              </div>`
                            : ""
                        }
                      </div>
                    </article>
                  `;
                })
                .join("")
            : `<div class="empty">Dodaj prvi obrok za ${weekdayAccusative(state.selectedWeekday)} i aplikacija će odmah sabirati makroe.</div>`
        }
      </div>
    </section>

    <section class="section plan-quick-section ${state.planQuickExpanded ? "is-expanded" : "is-collapsed"}">
      <button
        class="section-disclosure"
        type="button"
        data-action="toggle-plan-quick"
        aria-expanded="${state.planQuickExpanded}"
      >
        <div class="section-disclosure-copy">
          <h2>Alati za plan</h2>
          <p>Kopiraj dan na drugi dan ili očisti plan.</p>
        </div>
        <div class="section-disclosure-meta">
          <span class="section-disclosure-icon" aria-hidden="true">${renderChevronIcon(state.planQuickExpanded)}</span>
        </div>
      </button>
      <div class="plan-tools ${state.planQuickExpanded ? "is-expanded" : "is-collapsed"}">
        <div class="plan-tool">
          <div class="plan-tool-head">
            <h3>Kopiraj ${weekdayAccusative(state.selectedWeekday)} na drugi dan</h3>
          </div>
          <form id="duplicate-day-form" class="plan-tool-form plan-tool-form--inline">
            <div class="field">
              <label for="duplicate-target-weekday">Dan</label>
              <select id="duplicate-target-weekday" name="targetWeekday" required>
                <option value="">Izaberi dan</option>
                ${WEEKDAYS.map((weekday) => `<option value="${weekday}">${weekdayLabel(weekday)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="duplicate-target-week-track">Nedelja</label>
              <select id="duplicate-target-week-track" name="targetWeekTrack">
                <option value="${state.selectedWeekTrack}">${getWeekTrackLabel(state.selectedWeekTrack)}</option>
                <option value="${state.selectedWeekTrack === 1 ? 0 : 1}">${getWeekTrackLabel(state.selectedWeekTrack === 1 ? 0 : 1)}</option>
              </select>
            </div>
            <div class="field">
              <label for="duplicate-mode">Način</label>
              <select id="duplicate-mode" name="mode">
                <option value="append">Dodaj u plan</option>
                <option value="replace">Prepiši dan</option>
              </select>
            </div>
            <button class="solid-button button-with-icon plan-tool-submit" type="submit">${renderButtonContent("Kopiraj", "copy")}</button>
          </form>
        </div>

        <div class="plan-tool">
          <div class="plan-tool-head">
            <h3>Obriši obroke</h3>
          </div>
          <p class="footer-note plan-tool-note">Briše nečekirane obroke. Posle brisanja stiže dugme za poništavanje.</p>
          <div class="plan-tool-actions">
            <button class="danger-button button-with-icon" type="button" data-action="delete-day-plan" ${entries.length ? "" : "disabled"}>
              ${renderButtonContent(`Obriši ${weekdayLabel(state.selectedWeekday).toLowerCase()}`, "delete")}
            </button>
            <button class="ghost-button button-with-icon" type="button" data-action="toggle-bulk-delete-panel">
              ${renderButtonContent(state.bulkDeletePanelOpen ? "Zatvori izbor" : "Više dana", state.bulkDeletePanelOpen ? "close" : "copy")}
            </button>
          </div>
          ${
            state.bulkDeletePanelOpen
              ? `
                <div class="meal-prep-panel bulk-delete-panel">
                  ${renderWeekTrackDayPicker({ action: "toggle-bulk-delete-day", selectedPairs: state.bulkDeletePickDays || [] })}
                  <div class="entry-actions prep-actions">
                    <button class="danger-button button-with-icon" type="button" data-action="confirm-bulk-delete-days" ${
                      (state.bulkDeletePickDays || []).length ? "" : "disabled"
                    }>
                      ${renderButtonContent(`Obriši izabrane dane (${(state.bulkDeletePickDays || []).length})`, "delete")}
                    </button>
                  </div>
                </div>
              `
              : ""
          }
        </div>
      </div>
    </section>

    ${renderPlanSupplementsSection()}



    ${renderPlanActivitySection()}

    ${renderPlanShoppingSection()}
  `;
}

function renderFoodsTab() {
  // Foods imported from a nutrition-plan document that still need kcal/macro
  // values are hidden from the selectable list below (shouldHidePendingImportedFood)
  // until reviewed — without this link, they're invisible and unreachable
  // except by typing #nutrition in the URL bar.
  const pendingNutritionReviewCount = getFoods().filter(shouldHidePendingImportedFood).length;
  const selectableFoods = getSelectableFoods();
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
      const protein = toNumber(food.protein);
      const carbs = toNumber(food.carbs);
      const fat = toNumber(food.fat);
      const kcal = toNumber(food.kcal);
      const shouldExcludeZeroKcal = state.foodNutritionFilter !== "Sve" && kcal <= 0;
      if (shouldExcludeZeroKcal) {
        return false;
      }
      const matchesNutritionProfile =
        state.foodNutritionFilter === "Sve"
          ? true
          : state.foodNutritionFilter === "Visok protein"
            ? protein >= 20
            : state.foodNutritionFilter === "Malo UH"
              ? carbs <= 10
              : state.foodNutritionFilter === "Malo masti"
                ? fat <= 10
                : state.foodNutritionFilter === "Malo proteina"
                  ? protein <= 8
                  : state.foodNutritionFilter === "Manje kcal"
                    ? kcal <= 120
                    : true;
      // Text search is applied live in the DOM (see filterFoodsListInline)
      // so typing never triggers a full re-render — only the macro/nutrition
      // filters narrow which rows are rendered here.
      return matchesNutritionProfile;
    })
    .sort((left, right) => {
      const leftProtein = toNumber(left.protein);
      const rightProtein = toNumber(right.protein);
      const leftCarbs = toNumber(left.carbs);
      const rightCarbs = toNumber(right.carbs);
      const leftFat = toNumber(left.fat);
      const rightFat = toNumber(right.fat);
      const leftKcal = toNumber(left.kcal);
      const rightKcal = toNumber(right.kcal);

      let diff = 0;
      switch (state.foodNutritionFilter) {
        case "Visok protein":
          diff = rightProtein - leftProtein || leftKcal - rightKcal;
          break;
        case "Malo UH":
          diff = leftCarbs - rightCarbs || rightProtein - leftProtein || leftKcal - rightKcal;
          break;
        case "Malo masti":
          diff = leftFat - rightFat || rightProtein - leftProtein || leftKcal - rightKcal;
          break;
        case "Malo proteina":
          diff = leftProtein - rightProtein || leftKcal - rightKcal;
          break;
        case "Manje kcal":
          diff = leftKcal - rightKcal || rightProtein - leftProtein;
          break;
        default:
          diff = String(left.name || "").localeCompare(String(right.name || ""), "sr");
          break;
      }

      if (diff !== 0) {
        return diff;
      }

      return String(left.name || "").localeCompare(String(right.name || ""), "sr");
    });
  const filterCounts = FOOD_MACRO_FILTERS.reduce((acc, filter) => {
    acc[filter] =
      filter === "Sve"
        ? selectableFoods.length
        : selectableFoods.filter((food) => getFoodMacroGroup(food) === filter).length;
    return acc;
  }, {});
  const macroChips = ["Sve", "Proteini", "UH", "Masti"];
  const nutritionChips = ["Sve", "Visok protein", "Malo UH", "Malo masti", "Manje kcal"];

  return `
    <section class="section foods-section">
      <header class="foods-head">
        <h2>Namirnice</h2>
        <p class="foods-head-count">${foods.length < selectableFoods.length ? `${foods.length} od ${selectableFoods.length} ${srPlural(selectableFoods.length, "namirnice", "namirnice", "namirnica")}` : `${selectableFoods.length} ${srPlural(selectableFoods.length, "namirnica", "namirnice", "namirnica")} u bazi`}</p>
      </header>

      ${renderHelpNote("Ovo je tvoja baza namirnica sa kalorijama i makroima (po 100 g). Pretraži po imenu ili filtriraj (Proteini, UH, Masti…). Tapni namirnicu za detalje i izmenu. <strong>Skeniraj</strong> barkod sa pakovanja da brzo nađeš ili dodaš proizvod, a <strong>Nova namirnica</strong> ručno upiše novu u bazu. Ako nešto nemaš, pretraga ispod liste nudi i namirnice <strong>iz kataloga</strong> i <strong>deljene proizvode</strong> koje su drugi skenirali — „Dodaj“ ih kopira u tvoju bazu. Ovo je samo baza — u obroke se dodaje u <strong>Danas</strong>, iz samog obroka ili preko <strong>Brzog unosa</strong>.")}

      ${
        pendingNutritionReviewCount > 0
          ? `<button class="foods-nutrition-link" type="button" data-action="switch-tab" data-tab="nutrition">
              <span>${pendingNutritionReviewCount} ${srPlural(pendingNutritionReviewCount, "namirnica", "namirnice", "namirnica")} iz uvoza čeka vrednosti pre nego što se pojavi ovde</span>
              ${renderSideChevronIcon(false)}
            </button>`
          : ""
      }

      <div class="foods-search">
        <span class="foods-search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></svg></span>
        <input id="food-search" type="search" value="${escapeHtml(state.foodSearch)}" placeholder="Pretraga namirnica..." aria-label="Pretraga namirnica" autocomplete="off" />
        <button class="foods-search-clear ${state.foodSearch ? "" : "is-hidden"}" type="button" data-action="clear-food-search" aria-label="Obriši pretragu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
        <button class="foods-filter-toggle foods-scan-inline" type="button" data-action="open-scanner" aria-label="Skeniraj barkod" title="Skeniraj barkod">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg>
        </button>
        <button class="foods-filter-toggle ${state.foodFiltersOpen || state.foodNutritionFilter !== "Sve" ? "is-active" : ""}" type="button" data-action="toggle-food-filters" aria-label="Dodatni filteri${state.foodNutritionFilter !== "Sve" ? ` (aktivan: ${state.foodNutritionFilter})` : ""}" aria-pressed="${state.foodFiltersOpen ? "true" : "false"}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 5h18"/><path d="M6 12h12"/><path d="M10 19h4"/></svg>
        </button>
      </div>

      <div class="foods-chips">
        ${
          !state.foodFiltersOpen && state.foodNutritionFilter !== "Sve"
            ? `<button class="foods-chip foods-chip--applied is-active" type="button" data-action="set-food-nutrition-filter" data-filter="Sve" aria-label="Ukloni filter ${state.foodNutritionFilter}">${state.foodNutritionFilter}<span class="foods-chip-x" aria-hidden="true">×</span></button>`
            : ""
        }
        ${macroChips
          .map(
            (filter) => `
            <button class="foods-chip ${filter === state.foodMacroFilter ? "is-active" : ""}" type="button" data-action="set-food-filter" data-filter="${filter}">
              ${filter}<span class="foods-chip-count">${filterCounts[filter] || 0}</span>
            </button>`
          )
          .join("")}
      </div>

      ${
        state.foodFiltersOpen
          ? `<div class="foods-chips foods-chips--sub">
              ${nutritionChips
                .map(
                  (filter) => `<button class="foods-chip foods-chip--sub ${filter === state.foodNutritionFilter ? "is-active" : ""}" type="button" data-action="set-food-nutrition-filter" data-filter="${filter}">${filter}</button>`
                )
                .join("")}
            </div>`
          : ""
      }

      <div class="foods-secondary">
        <button class="foods-scan-btn" type="button" data-action="open-scanner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg>
          Skeniraj
        </button>
        <button class="foods-add-inline solid-button button-with-icon" type="button" data-action="open-food-editor-dialog">
          ${renderButtonContent("Nova namirnica", "add")}
        </button>
      </div>
      <div class="food-list foods-list">
        ${
          foods.length
            ? foods
                .map((food) => {
                  const isFavoriteFood = store.favoriteFoods.includes(food.id);
                  const proteinValue = Number(food.protein) || 0;
                  const carbsValue = Number(food.carbs) || 0;
                  const fatValue = Number(food.fat) || 0;
                  const searchText = normalizeLookupValue(
                    [food.name, canonicalizeImportedFoodName(food.name), food.category, food.macroGroup]
                      .filter(Boolean)
                      .join(" ")
                  );
                  const menuOpen = state.foodMenuOpenId === food.id;
                  return `
              <article class="food-row ${menuOpen ? "is-menu-open" : ""}" data-search="${escapeHtml(searchText)}" data-name="${escapeHtml(normalizeLookupValue(food.name))}">
                <button
                  class="food-row-star ${isFavoriteFood ? "is-active" : ""}"
                  type="button"
                  data-action="toggle-favorite-food"
                  data-food-id="${food.id}"
                  aria-label="${isFavoriteFood ? "Ukloni iz omiljenih" : "Dodaj u omiljene"}"
                  aria-pressed="${isFavoriteFood ? "true" : "false"}"
                >${renderStarIcon(isFavoriteFood)}</button>
                <button class="food-row-info" type="button" data-action="edit-food" data-food-id="${food.id}" aria-label="${escapeHtml(food.name)} — detalji i izmena">
                  <span class="food-row-line">
                    <span class="food-row-name">${escapeHtml(food.name)}</span>
                    <span class="food-row-kcal">${roundValue(food.kcal, 0)} kcal</span>
                  </span>
                  <span class="food-row-nutri">${getFoodNutritionBasisLabel(food)} · P ${roundValue(proteinValue, 1)} g · UH ${roundValue(carbsValue, 1)} g · M ${roundValue(fatValue, 1)} g</span>
                </button>
                <button
                  class="food-row-menu ${menuOpen ? "is-active" : ""}"
                  type="button"
                  data-action="toggle-food-menu"
                  data-food-id="${food.id}"
                  aria-label="Akcije za ${escapeHtml(food.name)}"
                  aria-expanded="${menuOpen ? "true" : "false"}"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>
                </button>
                ${
                  menuOpen
                    ? `<div class="food-row-actions">
                        <button class="ghost-button button-with-icon" type="button" data-action="edit-food" data-food-id="${food.id}">${renderButtonContent("Izmeni", "edit")}</button>
                        <button class="danger-button button-with-icon" type="button" data-action="delete-food" data-food-id="${food.id}">${renderButtonContent("Obriši iz baze", "delete")}</button>
                      </div>`
                    : ""
                }
              </article>
            `;
                })
                .join("")
            : `<div class="empty empty-passive">Nema namirnica za ovaj filter.</div>`
        }
        <div class="empty foods-list-empty" hidden>Nema u tvojim namirnicama.</div>
      </div>
      <div class="foods-external" data-role="foods-external"></div>
    </section>
  `;
}

// Sticky "+ Dodaj namirnicu" for the Foods tab. Rendered at the app-frame level
// (not inside the foods .section) because the section's backdrop-filter would
// otherwise become the containing block for position:fixed and pin the button
// to the (short) section instead of the viewport.
// "Yesterday" in a two-week template: the previous weekday; Monday → the other track's Sunday.
function getPreviousPlanDay(weekday, weekTrack) {
  const index = WEEKDAYS.indexOf(weekday);
  if (index > 0) {
    return { weekday: WEEKDAYS[index - 1], weekTrack: normalizeWeekTrack(weekTrack) };
  }
  return { weekday: WEEKDAYS[WEEKDAYS.length - 1], weekTrack: normalizeWeekTrack(weekTrack) === 1 ? 0 : 1 };
}

// First meal of the selected day that isn't checked off yet — where a quick
// "log what I'm eating" most likely belongs.
function getNextOpenMealLabel() {
  const meals = [...new Set([...defaultMeals, ...store.weeklyPlanEntries.map((entry) => normalizeMealLabel(entry.mealLabel))])];
  return meals.find((label) => !isMealCompletedForWeekday(state.selectedWeekday, label)) || "";
}

function renderFoodsAddFab() {
  return `
    <button class="foods-add-fab" type="button" data-action="open-food-editor-dialog" aria-label="Nova namirnica u bazi">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      Nova namirnica
    </button>
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
  const editingFavorite = state.editingFavoriteItem.favoriteId
    ? store.favoriteMeals.find((entry) => entry.id === state.editingFavoriteItem.favoriteId) || null
    : null;
  const favoriteDraftFood = getFoodById(state.favoriteDraft.foodId);
  const favoriteFoodSearchValue = favoriteDraftFood?.name || "";
  const recipeMealFilters = ["Sve", ...meals.filter(Boolean)];
  const filteredFavorites = favorites.filter((favorite) => {
    const mealMatch =
      state.recipeMealFilter === "Sve"
        ? true
        : normalizeMealLabel(favorite.mealLabel || favorite.name) === state.recipeMealFilter;
    const nutritionMatch =
      state.recipeNutritionFilter === "Sve"
        ? true
        : state.recipeNutritionFilter === "Obrok do 500 kcal"
          ? favorite.perServingTotals.kcal > 0 && favorite.perServingTotals.kcal <= 500
          : true;
    return mealMatch && nutritionMatch;
  });

  return `
    <section class="section recipes-builder-section ${state.recipesBuilderExpanded ? "is-expanded" : "is-collapsed"}">
      <button class="section-disclosure" type="button" data-action="toggle-recipes-builder" aria-expanded="${state.recipesBuilderExpanded}">
        <div class="section-disclosure-copy">
          <h2>${editingFavorite ? "Izmeni recept" : "Napravi recept"}</h2>
          <p>${
            editingFavorite
              ? `Menjaš „${escapeHtml(editingFavorite.name)}“ — čuvanje prepisuje postojeći recept.`
              : "Sastavi novi recept iz sastojaka."
          }</p>
        </div>
        <span class="section-disclosure-icon" aria-hidden="true">${renderChevronIcon(state.recipesBuilderExpanded)}</span>
      </button>
      <div class="plan-section-body ${state.recipesBuilderExpanded ? "is-expanded" : "is-collapsed"}">
      <article class="food-card suggestion-surface recipe-studio-card">
        <form id="favorite-meal-form" class="form-grid split recipe-builder-form">
          <div class="field">
            <label for="favorite-name">Naziv recepta</label>
            <input id="favorite-name" name="favoriteName" placeholder="npr. Tortilja sa jajima i piletinom" list="favorite-meal-options" value="${escapeHtml(state.favoriteDraft.favoriteName)}" required />
            <datalist id="favorite-meal-options">
              ${favorites.map((favorite) => `<option value="${escapeHtml(favorite.name)}"></option>`).join("")}
            </datalist>
          </div>
          <div class="field">
            <label for="favorite-meal-label">Tip obroka</label>
            <input id="favorite-meal-label" name="mealLabel" list="recipe-meal-options" placeholder="npr. 1. Doručak" value="${escapeHtml(state.favoriteDraft.mealLabel)}" required />
            <datalist id="recipe-meal-options">
              ${meals.map((meal) => `<option value="${escapeHtml(meal)}"></option>`).join("")}
            </datalist>
          </div>
          <div class="field recipe-builder-field-wide">
            <label for="favorite-description">Kratak opis</label>
            <input
              id="favorite-description"
              name="description"
              placeholder="npr. brz proteinski doručak koji drži sitost do treninga"
              value="${escapeHtml(state.favoriteDraft.description)}"
            />
          </div>
          <div class="field recipe-builder-field-wide">
            <label for="favorite-image">Slika obroka</label>
            <div class="recipe-image-pick">
              <label class="ghost-button button-with-icon" for="favorite-image">${renderButtonContent(state.favoriteDraft.imageUrl ? "Promeni sliku" : "Izaberi sliku", "open")}</label>
              <input id="favorite-image" name="image" type="file" accept="image/*" hidden />
            </div>
            <div class="footer-note">Opcionalno. Dodaj jednu fotku obroka i recept kartica će odmah izgledati bogatije.</div>
            ${
              state.favoriteDraft.imageUrl
                ? `
                  <div class="recipe-upload-preview">
                    <img src="${escapeHtml(state.favoriteDraft.imageUrl)}" alt="Preview recepta" />
                    <button class="ghost-button button-with-icon" type="button" data-action="clear-favorite-image">
                      ${renderButtonContent("Ukloni sliku", "close")}
                    </button>
                  </div>
                `
                : ""
            }
          </div>
          <div class="field">
            <label for="favorite-servings">Broj porcija</label>
            <input id="favorite-servings" name="servings" type="number" inputmode="decimal" min="1" step="1" placeholder="1" value="${state.favoriteDraft.servings}" />
          </div>
          <div class="field">
            <label for="favorite-prep-time">Vreme pripreme</label>
            <input id="favorite-prep-time" name="prepTimeMinutes" type="number" inputmode="decimal" min="1" step="1" placeholder="15" value="${state.favoriteDraft.prepTimeMinutes}" />
          </div>
          <div class="field recipe-builder-field-wide">
            <label for="favorite-instructions">Priprema</label>
            <textarea id="favorite-instructions" name="instructions" placeholder="npr. Ispeci jaja, zagrej tortilju, dodaj piletinu i sve urolaj.">${escapeHtml(state.favoriteDraft.instructions)}</textarea>
          </div>
          <div class="field">
            <label for="favorite-food-search">Sastojak</label>
            <input id="favorite-food-search" name="foodSearch" list="recipe-food-options" placeholder="Počni da kucaš namirnicu" value="${escapeHtml(favoriteFoodSearchValue)}" autocomplete="off" required />
            <input id="favorite-food-id" name="foodId" type="hidden" value="${state.favoriteDraft.foodId}" />
            <datalist id="recipe-food-options">
              ${selectableFoods.map((food) => `<option value="${escapeHtml(food.name)}"></option>`).join("")}
            </datalist>
          </div>
          <div class="field" id="favorite-amount-field">${renderFavoriteAmountFieldInner(favoriteDraftFood)}</div>
          <div class="entry-actions entry-actions--start recipe-builder-actions">
            <button class="solid-button secondary-button button-with-icon" type="submit">
              ${renderButtonContent(state.editingFavoriteItem.itemId ? "Sačuvaj stavku u preview" : "Dodaj stavku u preview", state.editingFavoriteItem.itemId ? "save" : "add")}
            </button>
            ${state.editingFavoriteItem.itemId ? `<button class="ghost-button button-with-icon" type="button" data-action="cancel-edit-favorite-item">${renderButtonContent("Odustani", "close")}</button>` : ""}
          </div>
        </form>
        <div class="recipe-studio-divider"></div>
        <div class="recipe-draft-panel">
          <div class="food-card-top recipe-draft-top">
            <div class="recipe-draft-copy">
              <h3>${escapeHtml(draftPreview.favoriteName || "Recept u izradi")}</h3>
              <p>${escapeHtml(draftPreview.description || draftPreview.instructions || "Dodaj opis ili kratku pripremu pa će se ovde pojaviti jasan pregled recepta.")}</p>
            </div>
            <span class="pill strong">${draftPreview.items.length} ${srPlural(draftPreview.items.length, "stavka", "stavke", "stavki")}</span>
          </div>
          ${
            draftPreview.imageUrl
              ? `<div class="recipe-draft-media"><img src="${escapeHtml(draftPreview.imageUrl)}" alt="${escapeHtml(draftPreview.favoriteName || "Preview recepta")}" /></div>`
              : ""
          }
          <div id="recipe-draft-summary">${renderRecipeDraftSummaryInner(draftPreview)}</div>
          ${
            draftPreview.instructions
              ? `<div class="recipe-draft-method">${escapeHtml(draftPreview.instructions)}</div>`
              : ""
          }
          <div class="recipe-draft-items">
            ${
              draftPreview.items.length
                ? draftPreview.items
                    .map((item) => {
                      const suggestedFood = !item.isPending ? getRecipeDraftItemSuggestedFood(item) : null;
                      const itemFood = getFoodById(item.foodId);
                      const unitLabel = getFoodServingUnit(itemFood) === "piece" ? "kom" : "g";
                      // Naziv je stajao dva puta (jednom kao naslov, jednom kao
                      // podnaslov) i kad su isti — druga linija ide samo kad
                      // stvarno kaže nešto novo (drugo ime u bazi, ili da veze
                      // još nema).
                      const linkNote = !item.isMatched
                        ? "Još nije povezano sa bazom"
                        : item.displayName && item.foodName && item.displayName !== item.foodName
                          ? `Povezano sa: ${item.foodName}`
                          : "";
                      return `
                        <div class="recipe-draft-item ${item.isPending ? "is-pending" : ""} ${!item.isMatched ? "is-unmatched" : ""}">
                          <div class="recipe-draft-item-main">
                            <strong class="recipe-draft-item-name">${escapeHtml(item.displayName || item.foodName)}</strong>
                            ${linkNote ? `<span class="recipe-draft-item-note">${escapeHtml(linkNote)}</span>` : ""}
                            ${item.isPending ? `<span class="recipe-draft-item-note">nova stavka — dodaj je u preview</span>` : ""}
                          </div>
                          <div class="recipe-draft-item-amount">
                            <input
                              ${item.isPending ? "" : `data-recipe-draft-item-grams="${item.id}"`}
                              type="number"
                              inputmode="decimal"
                              min="1"
                              step="1"
                              value="${item.grams ? roundValue(item.grams, 0) : ""}"
                              placeholder="${item.isPending ? "" : getFoodQuantityPlaceholder(itemFood)}"
                              aria-label="Količina — ${escapeHtml(item.displayName || item.foodName)}"
                              ${item.isPending ? "disabled" : ""}
                            />
                            <span class="recipe-draft-item-unit">${unitLabel}</span>
                          </div>
                          <span class="recipe-draft-item-kcal" data-recipe-draft-item-kcal="${item.id}">${roundValue(item.totals.kcal, 0)} kcal</span>
                          ${
                            item.isPending
                              ? `<span class="recipe-draft-item-spacer" aria-hidden="true"></span>`
                              : `<button class="danger-button button-with-icon icon-only-action" type="button" data-action="remove-draft-favorite-item" data-item-id="${item.id}" aria-label="Izbaci ${escapeHtml(item.displayName || item.foodName)} iz recepta" title="Izbaci iz recepta">${renderButtonContent("Izbaci", "delete")}</button>`
                          }
                          ${
                            !item.isMatched
                              ? `
                                <div class="recipe-draft-item-link">
                                  <select data-recipe-draft-item-food-id="${item.id}" aria-label="Poveži ${escapeHtml(item.displayName || item.foodName)} sa namirnicom">
                                    <option value="">Poveži sa namirnicom</option>
                                    ${selectableFoods
                                      .map((food) => `<option value="${food.id}" ${food.id === item.foodId ? "selected" : ""}>${escapeHtml(food.name)}</option>`)
                                      .join("")}
                                  </select>
                                  ${
                                    suggestedFood
                                      ? `<button class="ghost-button" type="button" data-action="apply-draft-favorite-item-suggestion" data-item-id="${item.id}" data-food-id="${suggestedFood.id}">Prihvati „${escapeHtml(suggestedFood.name)}“</button>`
                                      : ""
                                  }
                                </div>
                              `
                              : ""
                          }
                        </div>
                      `;
                    })
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
              ${renderButtonContent(editingFavorite ? "Sačuvaj izmene" : "Sačuvaj recept", "save")}
            </button>
            ${
              editingFavorite
                ? `<button class="ghost-button" type="button" data-action="cancel-edit-favorite-meal">Odustani</button>`
                : ""
            }
          </div>
        </div>
      </article>
      </div>
    </section>

    <section class="section recipes-library-section">
      <div class="section-header">
        <div>
          <h2>Biblioteka recepata</h2>
          <p>${favorites.length ? `Trenutno imaš ${favorites.length} ${srPlural(favorites.length, "sačuvan recept", "sačuvana recepta", "sačuvanih recepata")}.` : "Još nema sačuvanih recepata."}</p>
        </div>
      </div>
      ${renderHelpNote("Recept je sačuvana kombinacija namirnica (npr. „Piletina + pirinač + povrće“) sa ukupnim kalorijama i makroima. Sastaviš ga jednom u <strong>„Napravi recept“</strong>, a posle ga iz <strong>biblioteke</strong> ubaciš u bilo koji obrok jednim tapom — bez ponovnog kucanja svake namirnice.")}
      ${
        favorites.length
          ? `
            <div class="stack recipe-filter-stack" style="margin-bottom:14px;">
              <div class="foods-search recipe-search">
                <span class="foods-search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></svg></span>
                <input id="recipe-search" type="search" value="${escapeHtml(state.recipeSearch)}" placeholder="Pretraži recepte ili sastojke…" aria-label="Pretraga recepata" autocomplete="off" />
                <button class="foods-search-clear ${state.recipeSearch ? "" : "is-hidden"}" type="button" data-action="clear-recipe-search" aria-label="Obriši pretragu">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>
              </div>
              ${
                favorites.length >= 6
                  ? `
              <div>
                <div class="footer-note" style="margin-bottom:8px;">Filtriraj po tipu obroka</div>
                <div class="chips recipe-filter-bar">
                  ${recipeMealFilters
                    .map(
                      (mealFilter) => `
                        <button
                          class="chip is-light recipe-filter-chip ${mealFilter === state.recipeMealFilter ? "is-active" : ""}"
                          data-action="set-recipe-meal-filter"
                          data-filter="${mealFilter}"
                        >
                          ${mealFilter}
                        </button>
                      `
                    )
                    .join("")}
                </div>
              </div>
              <div>
                <div class="footer-note" style="margin-bottom:8px;">Filtriraj po kalorijama</div>
                <div class="chips recipe-filter-bar">
                  ${RECIPE_NUTRITION_FILTERS
                    .map(
                      (filter) => `
                        <button
                          class="chip is-light recipe-filter-chip ${filter.id === state.recipeNutritionFilter ? "is-active" : ""}"
                          data-action="set-recipe-nutrition-filter"
                          data-filter="${filter.id}"
                        >
                          ${filter.label}
                        </button>
                      `
                    )
                    .join("")}
                </div>
              </div>
                  `
                  : ""
              }
            </div>
          `
          : ""
      }
      <div class="stack recipes-library-stack">
        ${
          filteredFavorites.length
            ? filteredFavorites
                .map((favorite) => {
                  const isExpanded = isRecipeExpanded(favorite.id);
                  const recipeSearchText = normalizeLookupValue(
                    [favorite.name, favorite.mealLabel, favorite.description, ...(favorite.items || []).map((item) => item.displayName || item.foodName || "")]
                      .filter(Boolean)
                      .join(" ")
                  );
                  return `
                    <article class="food-card recipe-library-card ${isExpanded ? "" : "is-collapsed"}" data-search="${escapeHtml(recipeSearchText)}" data-name="${escapeHtml(normalizeLookupValue(favorite.name))}">
                      <div class="recipe-library-shell ${favorite.imageUrl ? "has-media" : "no-media"}">
                        ${
                          favorite.imageUrl
                            ? `
                              <div class="recipe-library-media">
                                <img src="${escapeHtml(favorite.imageUrl)}" alt="${escapeHtml(favorite.name)}" loading="lazy" />
                              </div>
                            `
                            : ""
                        }
                        <div class="recipe-library-body">
                          <div class="recipe-library-copy">
                            <button class="recipe-library-head" type="button" data-action="toggle-recipe-expanded" data-favorite-id="${favorite.id}" aria-expanded="${isExpanded}" aria-label="${isExpanded ? "Skupi recept" : "Raširi recept"}: ${escapeHtml(favorite.name)}">
                              <h3>${escapeHtml(favorite.name)}</h3>
                              <span class="recipe-library-head-chevron" aria-hidden="true">${renderChevronIcon(isExpanded)}</span>
                            </button>
                            ${
                              isExpanded
                                ? `<p>${escapeHtml(favorite.description || favorite.instructions || "Sačuvan recept bez dodatnog opisa.")}</p>`
                                : ""
                            }
                          </div>
                          <div class="recipe-library-meta">
                            ${[
                              favorite.mealLabel || favorite.name,
                              `${favorite.servings} ${favorite.servings === 1 ? "porcija" : favorite.servings < 5 ? "porcije" : "porcija"}`,
                              favorite.prepTimeMinutes ? `${favorite.prepTimeMinutes} min` : null,
                            ]
                              .filter(Boolean)
                              .map((part) => `<span>${escapeHtml(part)}</span>`)
                              .join("")}
                          </div>
                          <div class="recipe-library-stats">
                            <span class="recipe-library-stat-kcal"><strong>${roundValue(favorite.perServingTotals.kcal, 0)}</strong> kcal <span class="recipe-library-stat-sub">po porciji</span></span>
                            <span class="recipe-library-stat-macros">P ${roundValue(favorite.perServingTotals.protein, 1)} · UH ${roundValue(favorite.perServingTotals.carbs, 1)} · M ${roundValue(favorite.perServingTotals.fat, 1)} g</span>
                            ${getRecipeServingCount(favorite) > 1 ? `<span class="recipe-library-stat-total">Ceo recept ${roundValue(favorite.totals.kcal, 0)} kcal</span>` : ""}
                          </div>
                          ${
                            isExpanded
                              ? `
                                ${
                                  favorite.instructions
                                    ? `<div class="recipe-library-method">${escapeHtml(truncateText(favorite.instructions, 220))}</div>`
                                    : ""
                                }
                                <div class="footer-note" style="margin-top:10px;">Sastav recepta:</div>
                                <div class="stack recipe-library-ingredients" style="margin-top:12px;">
                                  ${favorite.items
                                    .map(
                                      (item) => `
                                        <div class="recipe-library-ingredient-card">
                                        <div class="recipe-library-ingredient-head">
                                            <strong>${escapeHtml(item.displayName || item.foodName)}</strong>
                                            <div class="footer-note">${formatFoodAmount(getFoodById(item.foodId), item.grams)}</div>
                                          </div>
                                          <div class="pill-row recipe-library-ingredient-macros">
                                            <span class="pill note">${roundValue(item.totals.kcal, 0)} kcal</span>
                                            <span class="pill">P ${roundValue(item.totals.protein, 1)} g</span>
                                            <span class="pill">UH ${roundValue(item.totals.carbs, 1)} g</span>
                                            <span class="pill">M ${roundValue(item.totals.fat, 1)} g</span>
                                          </div>
                                        </div>
                                      `
                                    )
                                    .join("")}
                                </div>
                              `
                              : ""
                          }
                          <div class="entry-actions" style="gap:8px; justify-content:flex-start; flex-wrap:wrap; margin-top:12px;">
                            <button class="solid-button secondary-button button-with-icon" data-action="open-recipe-apply-dialog" data-favorite-id="${favorite.id}">
                              ${renderButtonContent("Dodaj u plan", "add")}
                            </button>
                            <button class="ghost-button button-with-icon icon-only-action" data-action="prefill-favorite-meal" data-favorite-id="${favorite.id}" aria-label="Izmeni recept" title="Izmeni recept">
                              ${renderButtonContent("Izmeni recept", "edit")}
                            </button>
                            <button class="danger-button button-with-icon icon-only-action" data-action="delete-favorite-meal" data-favorite-id="${favorite.id}" aria-label="Obriši recept" title="Obriši recept">
                              ${renderButtonContent("Obriši recept", "delete")}
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  `
                })
                .join("")
            : favorites.length
              ? `<div class="empty empty-passive">Nema recepata za izabrane filtere. Promeni tip obroka ili nutritivni profil.</div>`
              : `<div class="empty">Napravi prvi recept ovde, pa ćeš ga posle dodavati u plan jednim tapom.</div>`
        }
      </div>
      <div class="empty recipe-list-empty" hidden>Nema recepata za ovu pretragu.</div>
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
  const todayExerciseTotal = templates.reduce((count, template) => count + template.exercises.length, 0);
  const todayExerciseCompleted = templates.reduce(
    (count, template) => count + getTrainingTemplateCompletionCount(template, state.selectedWeekday).completedCount,
    0
  );

  return `
    <section class="section routine-overview-section">
      <div class="section-header">
        <div>
          <h2>Nedeljni plan treninga</h2>
        </div>
      </div>
      ${renderHelpNote("Dva su nivoa: <strong>plan treninga</strong> je šta radiš kog dana (vežbe + potrošnja kalorija koja ulazi u dnevni bilans). Kalorije se na danima sa planom kucaju po sekcijama — <strong>trening, stomak, kardio</strong> — a ukupno je njihov zbir; broj sa sata važi samo kad nijedna sekcija nije upisana. <strong>Progres po vežbi</strong> je dnevnik kilaže i serija za svaku vežbu — beleži koliko si digao i koliko ponavljanja, pa kroz vreme vidiš grafik napretka i najbolji rezultat. Plan treninga je, kao i jelovnik, šablon za dve naizmenične nedelje — isti šablon važi svake druge nedelje dok ga ne promeniš.")}
      ${renderWeekTrackRow()}
      <div class="training-week-strip" role="group" aria-label="Izaberi dan">
        ${weeklyTrainingPlan
          .map(
            (day) => `
              <button class="chip training-day-chip ${day.weekday === state.selectedWeekday ? "is-active" : ""} ${day.weekday === getTodayWeekday() && state.selectedWeekTrack === getCurrentWeekTrack() ? "is-today" : ""} ${day.templates.length ? "has-plan" : ""}" type="button" data-action="select-weekday" data-weekday="${day.weekday}" aria-pressed="${day.weekday === state.selectedWeekday}" title="${weekdayLabel(day.weekday)}${day.templates.length ? ` · ${escapeHtml(day.templates.map((template) => template.name).join(", "))}` : " · odmor"}">
                <span>${weekdayLabel(day.weekday).slice(0, 3)}</span>
                <span class="training-day-dot" aria-hidden="true"></span>
              </button>
            `
          )
          .join("")}
      </div>
      ${(() => {
        const plannedDays = weeklyTrainingPlan.filter((day) => day.templates.length || day.trainingBurn > 0);
        if (!plannedDays.length) {
          return "";
        }
        return `
          <ul class="training-week-list">
            ${plannedDays
              .map((day) => {
                const exerciseCount = day.templates.reduce((count, template) => count + template.exercises.length, 0);
                const meta = [];
                if (day.templates.length) {
                  meta.push(`${exerciseCount} ${srPlural(exerciseCount, "vežba", "vežbe", "vežbi")}`);
                  meta.push(`${day.completedExerciseCount}/${day.totalExerciseCount}`);
                }
                if (day.trainingBurn > 0) {
                  meta.push(`${roundValue(day.trainingBurn, 0)} kcal`);
                }
                return `
                  <li class="training-week-item ${day.weekday === state.selectedWeekday ? "is-active" : ""}">
                    <button type="button" class="training-week-item-button" data-action="select-weekday" data-weekday="${day.weekday}">
                      <span class="training-week-item-main">
                        <strong>${weekdayLabel(day.weekday)}</strong>
                        <span class="training-week-item-name">${day.templates.length ? day.templates.map((template) => escapeHtml(template.name)).join(", ") : "Bez plana, samo potrošnja"}</span>
                      </span>
                      <span class="training-week-item-meta">${meta.join(" · ")}</span>
                    </button>
                  </li>`;
              })
              .join("")}
          </ul>`;
      })()}
    </section>

    <section class="section routine-habits-section">
      <div class="section-header">
        <div>
          <h2>Trening za ${weekdayAccusative(state.selectedWeekday)}</h2>
        </div>
      </div>
      <div class="training-day-spotlight">
        ${
          templates.length
            ? `
        <article class="food-card suggestion-surface training-day-summary-card">
          <dl class="glance-list training-day-glance">
            <div class="glance-item">
              <dt>Vežbe</dt>
              <dd>${todayExerciseTotal}</dd>
            </div>
            <div class="glance-item">
              <dt>Odrađeno</dt>
              <dd>${todayExerciseCompleted}/${todayExerciseTotal || 0}</dd>
            </div>
            <div class="glance-item">
              <dt>Kalorije</dt>
              <dd>${trainingBurn > 0 ? `${roundValue(trainingBurn, 0)} kcal` : `<span class="glance-sub">nije uneto</span>`}</dd>
            </div>
          </dl>
        </article>

            `
            : ""
        }
      </div>
      <div class="stack training-template-stack">
        ${
          templates.length
            ? templates
                .map((template) => {
                  const completion = getTrainingTemplateCompletionCount(template, state.selectedWeekday);
                  const isTemplateDone = completion.totalCount > 0 && completion.completedCount === completion.totalCount;
                  return `
                    <article class="training-card training-template-card ${isTemplateDone ? "is-done" : ""}">
                      <div class="training-top">
                        <div class="training-top-title">
                          ${
                            completion.totalCount
                              ? `<label class="routine-check training-done-check" title="${isTemplateDone ? "Poništi ceo trening" : "Označi ceo trening kao odrađen"}">
                                  <input class="routine-checkbox" type="checkbox" data-action="toggle-training-template-done" data-template-id="${template.id}" aria-label="${isTemplateDone ? "Poništi" : "Označi"} ceo trening „${escapeHtml(template.name)}“ kao odrađen" ${isTemplateDone ? "checked" : ""} />
                                  <span class="routine-check-ui" aria-hidden="true"></span>
                                </label>`
                              : ""
                          }
                          <h3>${escapeHtml(template.name)}</h3>
                        </div>
                        <span class="pill strong" aria-label="${completion.completedCount} od ${completion.totalCount} ${srPlural(completion.totalCount, "vežbe", "vežbe", "vežbi")} odrađeno">${completion.completedCount}/${completion.totalCount}</span>
                      </div>
                      <div class="training-exercise-list">
                        ${template.exercises
                          .map(
                            (exercise) => `
                              <div class="training-exercise-row">
                                <label class="routine-check training-exercise-check">
                                  <input class="routine-checkbox" type="checkbox" data-action="toggle-training-exercise" data-template-id="${template.id}" data-exercise-id="${exercise.id}" aria-label="${escapeHtml(exercise.name)}" ${isTrainingExerciseCompleted(state.selectedWeekday, template.id, exercise.id) ? "checked" : ""} />
                                  <span class="routine-check-ui" aria-hidden="true"></span>
                                </label>
                                <div class="training-exercise-copy">
                                  <strong class="training-exercise-name">${escapeHtml(exercise.name)}</strong>
                                  <div class="training-exercise-detail">${escapeHtml(exercise.details)}</div>
                                  ${renderExerciseProgression(exercise.name, exercise.details)}
                                </div>
                                <div class="training-exercise-actions">
                                  <button class="training-rest" type="button" data-action="toggle-rest-timer" data-rest-key="${template.id}:${exercise.id}" aria-label="Pokreni odmor" title="Odmor ${REST_TIMER_SECONDS} sekundi">
                                    ${renderRestIcon()}<span class="training-rest-label">Odmor</span>
                                  </button>
                                  <button class="training-exercise-log" type="button" data-action="prefill-exercise-progress" data-exercise-name="${escapeHtml(exercise.name)}" aria-label="Unesi kilažu za ${escapeHtml(exercise.name)}" title="Unesi kilažu">kg</button>
                                </div>
                              </div>
                            `
                          )
                          .join("")}
                      </div>
                      <div class="entry-actions training-template-actions" style="justify-content:flex-start; margin-top:12px;">
                        <button class="ghost-button button-with-icon" data-action="save-training-favorite" data-template-id="${template.id}">
                          ${renderButtonContent("Sačuvaj kao omiljeni", "save")}
                        </button>
                      </div>
                    </article>
                  `;
                })
                .join("")
            : `<div class="empty">Nema treninga za ${weekdayAccusative(state.selectedWeekday)}${state.selectedWeekTrack === getCurrentWeekTrack() ? "" : ` (${getWeekTrackLabel(state.selectedWeekTrack).toLowerCase()})`}. Dodaj šablon ispod${favoriteTrainings.length ? " ili ubaci omiljeni trening" : ""}.</div>`
        }
      </div>
      ${renderTrainingBurnSection(templates)}
    </section>

    ${
      favoriteTrainings.length
        ? `
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
                        <div>
                          <h3>${escapeHtml(training.name)}</h3>
                          <div class="footer-note">${training.exerciseCount} ${srPlural(training.exerciseCount, "vežba", "vežbe", "vežbi")} spremno za ubacivanje</div>
                        </div>
                        <span class="pill strong">${training.exerciseCount}</span>
                      </div>
                      <div class="training-favorite-copy">${training.exercises.map((exercise) => escapeHtml(exercise.details)).join(" · ")}</div>
                      <div class="entry-actions training-favorite-actions" style="justify-content:flex-start; margin-top:12px;">
                        <button class="solid-button secondary-button button-with-icon" data-action="apply-favorite-training" data-favorite-training-id="${training.id}">
                          ${renderButtonContent(`Ubaci u ${weekdayLabel(state.selectedWeekday)}`, "apply")}
                        </button>
                        <button class="danger-button button-with-icon" data-action="delete-favorite-training" data-favorite-training-id="${training.id}">
                          ${renderButtonContent("Obriši", "delete")}
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
        `
        : ""
    }

    <div class="section-toolbox">
    <details class="section routine-weekly-section form-collapse">
      <summary>
        <span class="form-collapse-title">Dodaj trening šablon</span>
        ${renderCollapseHint(
          (store.trainingTemplates || []).length
            ? `${(store.trainingTemplates || []).length} ${srPlural((store.trainingTemplates || []).length, "šablon", "šablona", "šablona")} u planu`
            : "Još nijedan šablon"
        )}
        <span class="form-collapse-icon" aria-hidden="true">+</span>
      </summary>
      <form id="training-form" class="form-grid">
        <div class="field">
          <label for="training-weekday">Dan</label>
          <select id="training-weekday" name="weekday" required>
            ${WEEKDAYS.map(
              (weekday) => `
                <option value="${weekday}" ${weekday === state.selectedWeekday ? "selected" : ""}>${weekdayLabel(weekday)}</option>
              `
            ).join("")}
          </select>
        </div>
        <div class="field">
          <label for="training-week-track">Nedelja</label>
          <select id="training-week-track" name="weekTrack" required>
            ${getWeekTrackDisplayOrder()
              .map((track) => `<option value="${track}" ${track === state.selectedWeekTrack ? "selected" : ""}>${getWeekTrackLabel(track)}</option>`)
              .join("")}
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
        <button class="solid-button" type="submit">Sačuvaj šablon</button>
      </form>
    </details>

    <details id="training-progress-details" class="section form-collapse form-collapse--view" ${state.trainingProgressOpen ? "open" : ""}>
      <summary>
        <span class="form-collapse-title">Progres po vežbi</span>
        ${renderCollapseHint(
          progressGroups.length
            ? `${progressGroups.length} ${srPlural(progressGroups.length, "vežba", "vežbe", "vežbi")} sa istorijom`
            : "Još nema praćenih vežbi"
        )}
        <span class="form-collapse-icon form-collapse-icon--chevron" aria-hidden="true">${renderChevronIcon(false)}</span>
      </summary>
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
                <option value="${weekday}" ${weekday === state.selectedWeekday ? "selected" : ""}>${weekdayLabel(weekday)}</option>
              `
            ).join("")}
          </select>
        </div>
        <div class="field">
          <label for="progress-exercise">Vežba</label>
          <input id="progress-exercise" name="exerciseName" list="training-exercise-options" placeholder="npr. Čučanj" value="${escapeHtml(state.trainingProgressPrefill || "")}" required />
          <datalist id="training-exercise-options">
            ${exerciseOptions.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("")}
          </datalist>
        </div>
        <div class="field">
          <label for="progress-weight">Kilaža</label>
          <input id="progress-weight" name="weightKg" type="number" inputmode="decimal" step="0.5" min="0" placeholder="npr. 80" required />
        </div>
        <div class="field">
          <label for="progress-reps">Serije / ponavljanja</label>
          <input id="progress-reps" name="reps" placeholder="npr. 4x8" />
        </div>
        <div class="field">
          <label for="progress-note">Napomena</label>
          <input id="progress-note" name="note" placeholder="npr. lagano, ostalo još" />
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
    </details>

    <details class="section form-collapse form-collapse--view">
      <summary>
        <span class="form-collapse-title">Poslednji unosi opterećenja</span>
        ${renderCollapseHint(
          recentProgressLogs.length
            ? `Poslednji: ${new Date(recentProgressLogs[0].date).toLocaleDateString("sr-RS")}`
            : "Još nema unosa"
        )}
        <span class="form-collapse-icon form-collapse-icon--chevron" aria-hidden="true">${renderChevronIcon(false)}</span>
      </summary>
      <div class="stack">
        ${
          recentProgressLogs.length
            ? recentProgressLogs
                .map(
                  (log) => `
                    <article class="food-card">
                      <div class="food-card-top">
                        <strong>${escapeHtml(log.exerciseName)}</strong>
                        <button class="danger-button" data-action="delete-training-progress" data-progress-id="${log.id}">Obriši</button>
                      </div>
                      <div class="pill-row">
                        <span class="pill strong">${roundValue(log.weightKg, 1)} kg</span>
                        <span class="pill">${new Date(log.date).toLocaleDateString("sr-RS")}</span>
                        <span class="pill">${log.weekday}</span>
                        ${log.reps ? `<span class="pill">${escapeHtml(log.reps)}</span>` : ""}
                      </div>
                      ${log.note ? `<div class="footer-note">${escapeHtml(log.note)}</div>` : ""}
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Još nema sačuvanih unosa opterećenja.</div>`
        }
      </div>
    </details>

    <details class="section form-collapse form-collapse--view">
      <summary>
        <span class="form-collapse-title">Beleške</span>
        ${renderCollapseHint(
          logs.length
            ? `${logs.length} ${srPlural(logs.length, "beleška", "beleške", "beleški")} za ${weekdayAccusative(state.selectedWeekday)}`
            : "Nema beleški za ovaj dan"
        )}
        <span class="form-collapse-icon form-collapse-icon--chevron" aria-hidden="true">${renderChevronIcon(false)}</span>
      </summary>
      <form id="training-log-form" class="form-grid">
        <div class="field">
          <label for="training-note">Beleška</label>
          <textarea id="training-note" name="note" placeholder="Npr. čučanj lagan, povećati težinu sledeći put"></textarea>
        </div>
        <button class="solid-button secondary-button" type="submit">Sačuvaj belešku</button>
      </form>
      <div class="stack training-log-stack" style="margin-top:14px;">
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
                      <div class="footer-note">${escapeHtml(log.note)}</div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Još nema beleški za ovaj dan.</div>`
        }
      </div>
    </details>
    </div>
  `;
}

// ---- Trčanje (running log) ------------------------------------------------
// Trenutna težina za grubu procenu potrošnje (≈1.036 kcal/kg/km). Profil ima
// prednost, pa najnovije merenje, inače nema procene (vrednost se sakrije).
function getCurrentWeightKg() {
  const profileWeight = toNumber(store.profile?.weightKg);
  if (profileWeight > 0) {
    return profileWeight;
  }
  const latest = getLatestMeasurement();
  const measured = latest ? toNumber(latest.weightKg) : 0;
  return measured > 0 ? measured : 0;
}

// Sekunde -> "M:SS" (ili "H:MM:SS" za trčanja preko sat vremena).
function formatRunDuration(totalSec) {
  const sec = Math.max(0, Math.round(Number(totalSec) || 0));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Sekundi-po-kilometru -> tempo "M:SS" (zaokruživanje 60s se prebacuje u minut).
function formatRunPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) {
    return "—";
  }
  let minutes = Math.floor(secPerKm / 60);
  let seconds = Math.round(secPerKm % 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getRunTypeLabel(typeId) {
  const match = RUN_TYPES.find((type) => type.id === typeId);
  return match ? match.label : "Trčanje";
}

// Izvedene veličine za jedno trčanje: tempo, brzina i procena potrošnje.
function getRunDerived(run) {
  const distanceKm = toNumber(run.distanceKm);
  const durationSec = Math.max(0, Number(run.durationSec) || 0);
  const paceSec = distanceKm > 0 && durationSec > 0 ? durationSec / distanceKm : null;
  const speedKmh = distanceKm > 0 && durationSec > 0 ? distanceKm / (durationSec / 3600) : null;
  const weightKg = getCurrentWeightKg();
  const calories = weightKg > 0 && distanceKm > 0 ? Math.round(1.036 * weightKg * distanceKm) : null;
  return { distanceKm, durationSec, paceSec, speedKmh, calories };
}

function getSortedRuns() {
  return [...(store.runs || [])].sort((a, b) => {
    const dateDiff = new Date(b.date) - new Date(a.date);
    if (dateDiff !== 0) {
      return dateDiff;
    }
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}

// Zbirne statistike: poslednjih 7 dana, tekući mesec, ukupno + rekordi.
function getRunStats() {
  const runs = store.runs || [];
  const now = new Date();
  // Lokalna ponoć pre 6 dana (ne "podne − 6×24h": posle promene sata to padne
  // na 13:00 i izbaci trčanje od tog dana, jer su trčanja upisana u podne).
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0).getTime(); // poslednjih 7 dana, uključujući danas
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0, 0).getTime();

  const stats = {
    totalCount: 0,
    totalKm: 0,
    totalSec: 0,
    weekCount: 0,
    weekKm: 0,
    weekSec: 0,
    monthCount: 0,
    monthKm: 0,
    monthSec: 0,
    bestPaceSec: null,
    longestKm: 0,
  };

  runs.forEach((run) => {
    const km = toNumber(run.distanceKm);
    const sec = Math.max(0, Number(run.durationSec) || 0);
    stats.totalCount += 1;
    stats.totalKm += km;
    stats.totalSec += sec;

    const runDate = getDateValueAsLocalDate(run.date);
    if (runDate) {
      const time = runDate.getTime();
      if (time >= weekStart) {
        stats.weekCount += 1;
        stats.weekKm += km;
        stats.weekSec += sec;
      }
      if (time >= monthStart) {
        stats.monthCount += 1;
        stats.monthKm += km;
        stats.monthSec += sec;
      }
    }

    // Najbrži tempo se računa samo za trčanja od bar 1 km da kratke deonice ne
    // izbace nerealan rekord.
    if (km >= 1 && sec > 0) {
      const pace = sec / km;
      if (stats.bestPaceSec === null || pace < stats.bestPaceSec) {
        stats.bestPaceSec = pace;
      }
    }
    if (km > stats.longestKm) {
      stats.longestKm = km;
    }
  });

  return stats;
}

// Apple Prečica formatira brojeve po lokalitetu i zalepi jedinicu ("5,2 km",
// "152 bpm", "9.123 koraka", "1,234 kcal"). Skinemo jedinicu, pa razlučimo
// decimalu od grupnog separatora: poslednji separator je decimalni samo ako ga
// prati 1–2 cifre (npr. "523.4" -> 523.4), inače je grupisanje ("9.123" ->
// 9123, "1,234" -> 1234). Tako i koraci/kalorije preko 1000 ulaze ispravno.
function parseRunNumber(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.,\-]/g, "");
  if (!cleaned) {
    return 0;
  }
  const lastSep = Math.max(cleaned.lastIndexOf(","), cleaned.lastIndexOf("."));
  if (lastSep === -1) {
    return Number(cleaned) || 0;
  }
  const decimalsAfter = cleaned.length - lastSep - 1;
  if (decimalsAfter >= 1 && decimalsAfter <= 2) {
    const intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, "");
    const fraction = cleaned.slice(lastSep + 1);
    return Number(`${intPart}.${fraction}`) || 0;
  }
  return Number(cleaned.replace(/[.,]/g, "")) || 0;
}

// "MM:SS" / "H:MM:SS" -> sekunde (svaki deo toleriše zalepljenu jedinicu).
function parseRunTimeToSeconds(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return 0;
  }
  const parts = raw
    .split(":")
    .map((part) => Number(part.trim().replace(",", ".").replace(/[^0-9.\-]/g, "")));
  if (parts.some((n) => Number.isNaN(n))) {
    return 0;
  }
  if (parts.length === 3) {
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  if (parts.length === 2) {
    return Math.max(0, parts[0] * 60 + parts[1]);
  }
  if (parts.length === 1) {
    return Math.max(0, Math.round(parts[0]));
  }
  return 0;
}

// Trajanje iz Prečice ume da dođe kao "1800", "30:00", "30 min", "0,5 h"...
// Pametno prepoznajemo format: dvotačka -> vreme; "min"/"h" -> množimo;
// inače čiste sekunde (grupni separatori se skidaju, npr. "1,800" -> 1800).
function parseRunDurationValue(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return 0;
  }
  if (raw.includes(":")) {
    return parseRunTimeToSeconds(raw);
  }
  // Svaka jedinica se čita zasebno pa se sabira, da "1h 30min" bude 5400 s
  // (ranije su se sve cifre spajale u "130" pa množile jednom jedinicom → 7800).
  const toDecimal = (text) => Number(String(text).replace(",", "."));
  const hourMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours|sat|sata|sati|cas|casa|časa|čas)(?![a-zčšž])/);
  const minMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:min|mins|minut|minuta|minute|minutes|minuti)(?![a-zčšž])/);
  const secMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:s|sec|secs|sek|sekund|sekunda|sekunde|sekundi|seconds)(?![a-zčšž])/);
  if (hourMatch || minMatch || secMatch) {
    let total = 0;
    if (hourMatch) {
      total += toDecimal(hourMatch[1]) * 3600;
      // "1h30" — sati pa goli broj = minuti.
      if (!minMatch && !secMatch) {
        const trailing = raw.slice(hourMatch.index + hourMatch[0].length).match(/^\s*(\d+)\s*$/);
        if (trailing) {
          total += Number(trailing[1]) * 60;
        }
      }
    }
    if (minMatch) {
      total += toDecimal(minMatch[1]) * 60;
    }
    if (secMatch) {
      total += toDecimal(secMatch[1]);
    }
    return Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0;
  }
  const seconds = Number(raw.replace(/[^0-9]/g, ""));
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

// Zajednička logika: skup polja (iz clipboard linije ili URL parametara) ->
// draft za formu, ili null ako nema ni distance ni vremena.
function buildRunDraftFromFields(fields) {
  const km = parseRunNumber(fields.km ?? fields.distanca ?? fields.distance);

  let durationSec = 0;
  if (fields.sec) {
    durationSec = parseRunDurationValue(fields.sec);
  } else if (fields.min) {
    const minRaw = String(fields.min).toLowerCase();
    // "min" key bez jedinice/dvotačke = minuti; ako nosi jedinicu, pusti pametni parser.
    durationSec = /[:hms]/.test(minRaw)
      ? parseRunDurationValue(minRaw)
      : Math.max(0, Math.round(parseRunNumber(minRaw) * 60));
  } else if (fields.t || fields.vreme || fields.time || fields.duration || fields.trajanje) {
    durationSec = parseRunDurationValue(fields.t ?? fields.vreme ?? fields.time ?? fields.duration ?? fields.trajanje);
  }

  // Bez bar distance ili vremena nema šta da se popuni — tretiramo kao promašaj.
  if (!(km > 0) && !(durationSec > 0)) {
    return null;
  }

  const avgHr = Math.round(parseRunNumber(fields.hr ?? fields.puls ?? fields.avghr));
  const maxHr = Math.round(parseRunNumber(fields.hrmax ?? fields.maxpuls ?? fields.maxhr));
  const typeRaw = String(fields.tip ?? fields.type ?? "").trim().toLowerCase();
  const type = RUN_TYPES.some((entry) => entry.id === typeRaw) ? typeRaw : null;
  const date = normalizeDateValue(fields.datum ?? fields.date ?? "");

  return {
    km: km > 0 ? roundValue(km, 2) : null,
    durationSec: durationSec > 0 ? durationSec : null,
    avgHr: avgHr > 0 ? avgHr : null,
    maxHr: maxHr > 0 ? maxHr : null,
    type,
    date: date || null,
  };
}

// Clipboard format (FITRUN marker pa key=value parovi razdvojeni ; ili novim redom):
//   FITRUN;km=5.2;sec=1800;hr=145;hrmax=168;tip=lagano;datum=2026-06-30
function parseRunClipboard(rawText) {
  const text = String(rawText || "").trim();
  const markerIndex = text.search(/FITRUN/i);
  if (markerIndex === -1) {
    return null;
  }
  const fields = {};
  text
    .slice(markerIndex + "FITRUN".length)
    .split(/[;\n\r]+/)
    .forEach((chunk) => {
      const eq = chunk.indexOf("=");
      if (eq === -1) {
        return;
      }
      const key = chunk.slice(0, eq).trim().toLowerCase();
      const value = chunk.slice(eq + 1).trim();
      if (key) {
        fields[key] = value;
      }
    });
  return buildRunDraftFromFields(fields);
}

// Deep-link uvoz: Prečica otvori sajt na #import-run?km=...&sec=...&hr=...
// pa app sam popuni formu — bez clipboard-a i bez dozvola.
function parseRunImportHash(hash) {
  const match = String(hash || "").match(/^#?(?:import-run|run-import|run)\?(.*)$/i);
  if (!match) {
    return null;
  }
  const params = new URLSearchParams(match[1]);
  const fields = {};
  params.forEach((value, key) => {
    fields[key.trim().toLowerCase()] = value;
  });
  return buildRunDraftFromFields(fields);
}

// ---- Dnevna aktivnost sa sata (Apple Watch summary) -----------------------
// YYYY-MM-DD -> ime dana iz WEEKDAYS (Pon..Ned), da Move kcal upišemo u
// postojeću po-dan potrošnju koja već ulazi u kalorijski bilans.
function weekdayFromDateValue(dateValue) {
  const date = getDateValueAsLocalDate(dateValue);
  if (!date) {
    return "";
  }
  return WEEKDAYS[(date.getDay() + 6) % 7] || "";
}

// "Trčanje|1800|320;Teretana|2400|210" -> [{name,durationSec,kcal}]. Toleriše i
// običan spisak imena bez brojeva ("Trčanje, Teretana").
function parseActivityWorkouts(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }
  // "~" razdvaja treninge (u clipboard FITACT formatu ";" već deli polja);
  // deep-link sme i ";" jer je workouts tamo jedan URL parametar.
  return raw
    .split(/[;\n~]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const parts = chunk.split("|");
      const name = String(parts[0] || "").trim();
      if (!name) {
        return null;
      }
      const durationSec = parts.length > 1 ? parseRunDurationValue(parts[1]) : 0;
      const kcal = parts.length > 2 ? Math.round(parseRunNumber(parts[2])) : 0;
      return { name, durationSec: durationSec > 0 ? durationSec : null, kcal: kcal > 0 ? kcal : null };
    })
    .filter(Boolean);
}

// Skup polja -> zapis dnevne aktivnosti, ili null ako nema nijedne metrike.
function buildActivityFromFields(fields) {
  const moveKcal = Math.round(parseRunNumber(fields.move ?? fields.kcal ?? fields.active ?? fields.aktivne));
  const exerciseMin = Math.round(parseRunNumber(fields.ex ?? fields.exercise ?? fields.vezbanje ?? fields.trening));
  const standHours = Math.round(parseRunNumber(fields.stand ?? fields.stajanje));
  const steps = Math.round(parseRunNumber(fields.steps ?? fields.koraci));
  const distanceKm = roundValue(parseRunNumber(fields.dist ?? fields.distance ?? fields.distanca ?? fields.km), 2);
  const workouts = parseActivityWorkouts(fields.workouts ?? fields.treninzi ?? fields.w);
  const date = normalizeDateValue(fields.datum ?? fields.date ?? "") || getTodayDateValue();

  const hasAny =
    moveKcal > 0 || exerciseMin > 0 || standHours > 0 || steps > 0 || distanceKm > 0 || workouts.length > 0;
  if (!hasAny) {
    return null;
  }

  return {
    date,
    moveKcal: moveKcal > 0 ? moveKcal : null,
    exerciseMin: exerciseMin > 0 ? exerciseMin : null,
    standHours: standHours > 0 ? standHours : null,
    steps: steps > 0 ? steps : null,
    distanceKm: distanceKm > 0 ? distanceKm : null,
    workouts,
  };
}

function parseActivityImportHash(hash) {
  const match = String(hash || "").match(/^#?import-activity\?(.*)$/i);
  if (!match) {
    return null;
  }
  const params = new URLSearchParams(match[1]);
  const fields = {};
  params.forEach((value, key) => {
    fields[key.trim().toLowerCase()] = value;
  });
  return buildActivityFromFields(fields);
}

// Clipboard format: FITACT;move=523;ex=46;stand=10;steps=8432;dist=6.1;workouts=Trčanje|1800|320
function parseActivityClipboard(rawText) {
  const text = String(rawText || "").trim();
  const markerIndex = text.search(/FITACT/i);
  if (markerIndex === -1) {
    return null;
  }
  const fields = {};
  text
    .slice(markerIndex + "FITACT".length)
    .split(/[;\n\r]+/)
    .forEach((chunk) => {
      const eq = chunk.indexOf("=");
      if (eq === -1) {
        return;
      }
      const key = chunk.slice(0, eq).trim().toLowerCase();
      const value = chunk.slice(eq + 1).trim();
      if (key) {
        fields[key] = value;
      }
    });
  return buildActivityFromFields(fields);
}

function getActivityForDate(dateValue) {
  const record = (store.activityByDate || {})[dateValue];
  return record && typeof record === "object" ? record : null;
}

// Upiše dnevnu aktivnost: bogat zapis po datumu + Move kcal u po-dan potrošnju
// (koja već ulazi u neto, pa zameni ručnu, bez duplog brojanja) + korake po datumu.
// Idempotentno je — ponovni uvoz istog datuma samo prepiše, ne duplira.
function applyActivityImport(record) {
  if (!record || !record.date) {
    return false;
  }
  store.activityByDate = store.activityByDate && typeof store.activityByDate === "object" ? store.activityByDate : {};
  store.activityByDate[record.date] = { ...record, updatedAt: new Date().toISOString() };

  if (record.moveKcal != null) {
    const weekday = weekdayFromDateValue(record.date);
    if (weekday) {
      store.trainingBurnByWeekday = store.trainingBurnByWeekday || {};
      store.trainingBurnByWeekday[weekday] = record.moveKcal;
    }
  }
  if (record.steps != null) {
    store.stepsByDate = store.stepsByDate && typeof store.stepsByDate === "object" ? store.stepsByDate : {};
    store.stepsByDate[record.date] = record.steps;
  }
  persist();
  return true;
}

function applyActivityClipboardText(text, options = {}) {
  const { silentOnMiss = false } = options;
  const record = parseActivityClipboard(text);
  if (!record) {
    if (!silentOnMiss) {
      showFeedbackToast({
        title: "Ništa za uvoz",
        detail: "Nisam našao dnevnu aktivnost u clipboard-u. Pokreni prečicu pa probaj ponovo.",
        tone: "warning",
        duration: 3400,
      });
    }
    return false;
  }
  applyActivityImport(record);
  render();
  showFeedbackToast({
    title: "Aktivnost učitana",
    detail: "Dnevni podaci sa sata su sačuvani.",
    tone: "success",
    duration: 3400,
  });
  return true;
}

// Pokreni korisnikovu Prečicu po imenu preko iOS "shortcuts://" šeme. Prečica
// pročita Health i (preko "Open URL" na kraju) vrati u app sa podacima. Na
// ne-iOS uređajima šema nema handler pa se ništa ne desi (bez greške).
function launchShortcut(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return false;
  }
  window.location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(trimmed)}`;
  return true;
}

function getShortcutName(key) {
  return String(store.shortcutNames?.[key] || "").trim();
}

// Deep-link uvoz: Prečica otvori sajt na #import-run?... (trčanje, popuni formu)
// ili #import-activity?... (dnevna aktivnost, odmah sačuva). Očisti hash da
// reload ne ponovi uvoz. Vraća true ako je nešto obrađeno.
function consumeImportFromUrl() {
  const hash = String(window.location.hash || "");

  if (/^#?import-activity\?/i.test(hash)) {
    const record = parseActivityImportHash(hash);
    const cleanUrl = window.location.pathname + window.location.search + "#plan";
    try {
      window.history.replaceState(null, "", cleanUrl);
    } catch (error) {
      window.location.hash = "plan";
    }
    state.activeTab = "plan";
    state.navMenuOpen = false;
    if (record) {
      applyActivityImport(record);
      showFeedbackToast({
        title: "Aktivnost učitana",
        detail: "Dnevni podaci sa sata su sačuvani.",
        tone: "success",
        duration: 3400,
      });
    } else {
      showFeedbackToast({
        title: "Link bez podataka",
        detail: "Prečica nije poslala nijednu metriku. Proveri akcije u prečici.",
        tone: "warning",
        duration: 3400,
      });
    }
    return true;
  }

  if (/^#?(?:import-run|run-import|run)\?/i.test(hash)) {
    const draft = parseRunImportHash(hash);
    const cleanUrl = window.location.pathname + window.location.search + "#running";
    try {
      window.history.replaceState(null, "", cleanUrl);
    } catch (error) {
      window.location.hash = "running";
    }
    state.activeTab = "running";
    state.navMenuOpen = false;
    if (draft) {
      state.runImportDraft = draft;
      showFeedbackToast({
        title: "Učitano sa sata",
        detail: "Proveri vrednosti i pritisni „Sačuvaj trčanje”.",
        tone: "success",
        duration: 3400,
      });
    } else {
      showFeedbackToast({
        title: "Link bez podataka",
        detail: "Prečica nije poslala distancu ni vreme. Proveri akcije u prečici.",
        tone: "warning",
        duration: 3400,
      });
    }
    return true;
  }

  return false;
}

function applyRunClipboardText(text, options = {}) {
  const { silentOnMiss = false } = options;
  const parsed = parseRunClipboard(text);
  if (!parsed) {
    if (!silentOnMiss) {
      showFeedbackToast({
        title: "Ništa za uvoz",
        detail: "Nisam našao podatke iz Prečice u clipboard-u. Pokreni prečicu pa probaj ponovo.",
        tone: "warning",
        duration: 3400,
      });
    }
    return false;
  }
  state.runImportDraft = parsed;
  render();
  showFeedbackToast({
    title: "Učitano sa sata",
    detail: "Proveri vrednosti i pritisni „Sačuvaj trčanje”.",
    tone: "success",
    duration: 3400,
  });
  return true;
}

// Auto-pokušaj pri otvaranju Trčanja: čitamo clipboard samo ako je dozvola već
// data, da ne iskačemo sa sistemskim promptom na svaki ulazak u tab. Ako nije
// (npr. iOS Safari), korisnik koristi dugme „Popuni sa sata” koje radi uz tap.
async function maybeAutoImportRunFromClipboard() {
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
    return;
  }
  let granted = false;
  try {
    if (navigator.permissions && typeof navigator.permissions.query === "function") {
      const status = await navigator.permissions.query({ name: "clipboard-read" });
      granted = status.state === "granted";
    }
  } catch (error) {
    granted = false;
  }
  if (!granted) {
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    applyRunClipboardText(text, { silentOnMiss: true });
  } catch (error) {
    /* tihi promašaj — dugme „Popuni sa sata” ostaje kao pouzdan put */
  }
}

function renderRunCard(run) {
  const derived = getRunDerived(run);
  const dateLabel = formatDateValueLabel(run.date) || String(run.date || "");
  const pills = [
    { text: `${roundValue(derived.distanceKm, 2)} km`, strong: true },
    { text: formatRunDuration(derived.durationSec) },
    { text: `${formatRunPace(derived.paceSec)} /km` },
    { text: derived.speedKmh ? `${roundValue(derived.speedKmh, 1)} km/h` : "— km/h" },
  ];
  if (run.avgHr) {
    pills.push({ text: `Pros. ${run.avgHr} bpm` });
  }
  if (run.maxHr) {
    pills.push({ text: `Maks. ${run.maxHr} bpm` });
  }
  if (derived.calories) {
    pills.push({ text: `${derived.calories} kcal` });
  }

  return `
    <article class="food-card run-card">
      <div class="food-card-top run-card-top">
        <div class="run-card-head">
          <strong>${escapeHtml(dateLabel)}</strong>
          <span class="run-type-pill run-type-${escapeHtml(run.type || "lagano")}">${escapeHtml(getRunTypeLabel(run.type))}</span>
        </div>
        <div class="record-row-actions">
          ${renderEditRecordButton("edit-run", "data-run-id", run.id, `Izmeni trčanje od ${escapeHtml(dateLabel)}`)}
          <button class="danger-button" data-action="delete-run" data-run-id="${run.id}">Obriši</button>
        </div>
      </div>
      <div class="pill-row">
        ${pills.map((pill) => `<span class="pill${pill.strong ? " strong" : ""}">${escapeHtml(pill.text)}</span>`).join("")}
      </div>
      ${run.note ? `<div class="footer-note run-card-note">${escapeHtml(run.note)}</div>` : ""}
    </article>
  `;
}

function renderRunningTab() {
  const stats = getRunStats();
  const runs = getSortedRuns();
  const hasRuns = runs.length > 0;
  const weekPaceSec = stats.weekKm > 0 ? stats.weekSec / stats.weekKm : null;

  // Tri izvora za istu formu, po prioritetu: izmena postojećeg trčanja, pa
  // deep-link iz Prečice (#import-run), pa prazan ručni unos. Izmena ima
  // prednost jer je eksplicitna radnja korisnika.
  const editingRun = getEditingRecord(store.runs, state.editingRunId);
  const draft = editingRun
    ? {
        date: normalizeDateValue(editingRun.date),
        km: editingRun.distanceKm,
        durationSec: editingRun.durationSec,
        avgHr: editingRun.avgHr,
        maxHr: editingRun.maxHr,
        type: editingRun.type,
        note: editingRun.note,
      }
    : state.runImportDraft || {};
  const draftDate = draft.date || getTodayDateValue();
  const draftKm = draft.km != null ? String(draft.km) : "";
  const draftMinutes = draft.durationSec != null ? String(Math.floor(draft.durationSec / 60)) : "";
  const draftSeconds = draft.durationSec != null ? String(draft.durationSec % 60) : "";
  const draftAvgHr = draft.avgHr != null ? String(draft.avgHr) : "";
  const draftMaxHr = draft.maxHr != null ? String(draft.maxHr) : "";
  const draftType = draft.type || "";
  const draftNote = draft.note != null ? String(draft.note) : "";

  return `
    <section class="section running-summary-section">
      <div class="section-header">
        <div>
          <h2>Trčanje ove nedelje</h2>
          <p>Poslednjih 7 dana.</p>
        </div>
      </div>
      ${renderHelpNote(
        "Upiši svako trčanje sa <strong>distancom</strong> i <strong>vremenom</strong> — aplikacija sama računa <strong>tempo</strong> (min/km), brzinu i grubu procenu potrošnje kalorija (na osnovu tvoje težine iz profila). Puls je opcioni, ali pomaže da pratiš da li trčiš lagano ili napadaš. Tip trčanja (lagano, tempo, intervali, dugačko, trka) ti kasnije olakšava da prepoznaš kakva je sesija bila."
      )}
      ${
        hasRuns
          ? `
            <dl class="glance-list running-week-glance">
              <div class="glance-item">
                <dt>Trčanja</dt>
                <dd>${stats.weekCount}</dd>
              </div>
              <div class="glance-item">
                <dt>Kilometri</dt>
                <dd>${roundValue(stats.weekKm, 1)} <span class="glance-sub">km</span></dd>
              </div>
              <div class="glance-item">
                <dt>Vreme</dt>
                <dd>${stats.weekSec ? formatRunDuration(stats.weekSec) : "0:00"}</dd>
              </div>
              <div class="glance-item">
                <dt>Prosečan tempo</dt>
                <dd>${formatRunPace(weekPaceSec)} <span class="glance-sub">/km</span></dd>
              </div>
            </dl>
          `
          : `<div class="empty">Još nema trčanja ove nedelje. Dodaj prvo ispod i ovde se pojavljuje nedeljni zbir.</div>`
      }
    </section>

    <details class="section form-collapse running-add-section" ${state.runImportDraft || editingRun ? "open" : ""}>
      <summary>
        <span class="form-collapse-title">${editingRun ? "Izmeni trčanje" : "Dodaj trčanje"}</span>
        <span class="form-collapse-icon" aria-hidden="true">+</span>
      </summary>
      <form id="run-form" class="form-grid split run-form">
        <div class="field date-field">
          <label for="run-date">Datum</label>
          <input id="run-date" name="date" type="date" value="${draftDate}" required />
        </div>
        ${renderChoiceField("Tip trčanja", "type", draftType, RUN_TYPES.map((type) => ({ id: type.id, label: type.label })))}
        ${renderUnitField("run-distance", "Distanca", "km", `<input id="run-distance" name="distanceKm" type="number" step="0.01" min="0" inputmode="decimal" placeholder="npr. 5.2" value="${draftKm}" required />`)}
        <div class="field">
          <label for="run-minutes">Vreme (min : sek)</label>
          <div class="run-time-inputs">
            <input id="run-minutes" name="minutes" type="number" min="0" step="1" inputmode="numeric" placeholder="min" aria-label="Minuti" value="${draftMinutes}" />
            <span class="run-time-sep" aria-hidden="true">:</span>
            <input id="run-seconds" name="seconds" type="number" min="0" max="59" step="1" inputmode="numeric" placeholder="sek" aria-label="Sekunde" value="${draftSeconds}" />
          </div>
        </div>
        <div class="field">
          <label for="run-avg-hr">Prosečan puls</label>
          <input id="run-avg-hr" name="avgHr" type="number" min="0" max="260" step="1" inputmode="numeric" placeholder="npr. 145" value="${draftAvgHr}" />
        </div>
        <div class="field">
          <label for="run-max-hr">Maksimalan puls</label>
          <input id="run-max-hr" name="maxHr" type="number" min="0" max="260" step="1" inputmode="numeric" placeholder="npr. 168" value="${draftMaxHr}" />
        </div>
        <div class="field run-note-field">
          <label for="run-note">Napomena</label>
          <input id="run-note" name="note" placeholder="npr. lagano oko jezera, lepo vreme" value="${escapeHtml(draftNote)}" />
        </div>
        ${editingRun ? `<button class="ghost-button" type="button" data-action="cancel-edit-run">Odustani</button>` : ""}
        <button class="solid-button secondary-button run-form-submit" type="submit">${editingRun ? "Sačuvaj izmenu" : "Sačuvaj trčanje"}</button>
      </form>
    </details>

    ${
      hasRuns
        ? `
          <section class="section running-records-section">
            <div class="section-header">
              <div>
                <h2>Rekordi i ukupno</h2>
              </div>
            </div>
            <div class="stats-grid stats-grid--glance running-records-grid">
              <article class="stat-card">
                <strong>Najduže trčanje</strong>
                <div class="macro-value">${roundValue(stats.longestKm, 2)} <small>km</small></div>
                <div class="footer-note">Najveća distanca</div>
              </article>
              <article class="stat-card">
                <strong>Najbrži tempo</strong>
                <div class="macro-value">${formatRunPace(stats.bestPaceSec)} <small>/km</small></div>
                <div class="footer-note">Na ≥ 1 km</div>
              </article>
              <article class="stat-card">
                <strong>Ukupno km</strong>
                <div class="macro-value">${roundValue(stats.totalKm, 1)} <small>km</small></div>
                <div class="footer-note">${stats.totalCount} ${stats.totalCount === 1 ? "trčanje" : "trčanja"}</div>
              </article>
              <article class="stat-card">
                <strong>Ukupno vreme</strong>
                <div class="macro-value">${stats.totalSec ? formatRunDuration(stats.totalSec) : "0:00"}</div>
                <div class="footer-note">Provedeno u trčanju</div>
              </article>
            </div>
          </section>
        `
        : ""
    }

    ${
      hasRuns
        ? `<section class="section running-history-section">
      <div class="section-header">
        <div>
          <h2>Istorija trčanja</h2>
          <p>Sva tvoja trčanja, od najnovijeg ka starijem.</p>
        </div>
      </div>
      <div class="stack running-history-stack">
        ${runs.map((run) => renderRunCard(run)).join("")}
      </div>
    </section>`
        : ""
    }
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
          <h2>Rutina za ${weekdayAccusative(state.selectedWeekday)}</h2>
        </div>
      </div>
      ${renderHelpNote("Tri stvari, tri svrhe: <strong>Nedeljne navike</strong> su veće stvari koje ciljaš par puta nedeljno (npr. „trening 3×“) i čekiraš po danima. <strong>Taskovi</strong> su sitne dnevne obaveze za izabrani dan. <strong>Dugoročni streakovi</strong> broje dane u nizu za stvari tipa „bez alkohola“ — prekineš ga i kreće od nule. Taskovi su, kao trening i jelovnik, šablon za dve naizmenične nedelje (Ova / Sledeća); navike i streakovi su isti svake nedelje.")}
      <div class="hero-day-picker routine-day-picker">
        <div class="chips hero-day-chips">
          ${WEEKDAYS.map(
            (weekday) => `
              <button class="chip ${weekday === state.selectedWeekday ? "is-active" : ""} ${weekday === getTodayWeekday() ? "is-today" : ""}" data-action="select-weekday" data-weekday="${weekday}" aria-pressed="${weekday === state.selectedWeekday}">
                ${weekdayLabel(weekday).slice(0, 3)}
              </button>
            `
          ).join("")}
        </div>
      </div>
      ${
        summary.habits.length || summary.tasks.length || summary.streakHabits.length
          ? `<div class="plan-net-row">
        <div class="plan-net-item">
          <span class="plan-net-label">Navike</span>
          <strong>${summary.doneHabits}/${summary.habits.length}</strong>
        </div>
        <div class="plan-net-item">
          <span class="plan-net-label">Taskovi</span>
          <strong>${summary.doneTasks}/${summary.tasks.length}</strong>
        </div>
        <div class="plan-net-item">
          <span class="plan-net-label">Streakovi</span>
          <strong>${summary.streakHabits.length}</strong>
        </div>
      </div>
      <div class="footer-note plan-net-note">
        ${
          summary.streakHabits.length
            ? summary.longestStreakDays
              ? `Najduži aktivni streak: ${getDayCountLabel(summary.longestStreakDays)}`
              : "Streakovi su dodati, još nema aktivnog niza"
            : "Dodaj prvi streak ispod i kreni da brojiš"
        }
      </div>`
          : ""
      }
    </section>

    <section class="section routine-habits-section">
      <div class="section-header">
        <div>
          <h2>Nedeljne navike</h2>
          ${summary.habits.length ? "" : `<p>Npr. 10k koraka, čitanje ili bez slatkiša. Čekiraš kad ispuniš za izabrani dan.</p>`}
        </div>
      </div>
      <details class="form-collapse" ${editingHabit ? "open" : ""}>
        <summary>
          <span class="form-collapse-title">${editingHabit ? "Izmena navike" : "Dodaj naviku"}</span>
          <span class="form-collapse-icon" aria-hidden="true">+</span>
        </summary>
      <form id="habit-form" class="form-grid split routine-habit-form">
        <div class="field">
          <label for="habit-name">${editingHabit ? "Naziv navike" : "Nova navika"}</label>
          <input
            id="habit-name"
            name="name"
            placeholder="npr. 10k koraka ili bez alkohola"
            value="${escapeHtml(editingHabit?.name || "")}"
            required
          />
        </div>
        ${renderChoiceField("Tip praćenja", "trackingMode", habitTrackingMode, [
          { id: "weekly", label: "Nedeljna", hint: "čekiraš po danima" },
          { id: "streak", label: "Streak", hint: "broji dane u nizu" },
        ])}
        <div class="field">
          <label for="habit-note">Opis / cilj</label>
          <input id="habit-note" name="note" placeholder="npr. svaki dan, makar 10 min" value="${escapeHtml(editingHabit?.note || "")}" />
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
      </details>
      <div class="stack routine-habit-stack" style="margin-top:14px;">
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
                            aria-label="${escapeHtml(habit.name)}"
                            ${isHabitDoneForDay(habit, state.selectedWeekday) ? "checked" : ""}
                          />
                          <span class="routine-check-ui" aria-hidden="true"></span>
                        </label>
                        <div class="routine-content">
                          <strong>${escapeHtml(habit.name)}</strong>
                          ${habit.note ? `<div class="footer-note">${escapeHtml(habit.note)}</div>` : ""}
                          <div class="pill-row">
                            <span class="pill">${getHabitWeeklyCount(habit)}/7 dana</span>
                            <span class="pill note">${isHabitDoneForDay(habit, state.selectedWeekday) ? "Označeno danas" : "Čeka za danas"}</span>
                          </div>
                        </div>
                        <div class="entry-actions" style="justify-content:flex-start; margin-top:0;">
                          <button class="ghost-button button-with-icon icon-only-action" type="button" data-action="edit-habit" data-habit-id="${habit.id}" aria-label="Izmeni naviku" title="Izmeni">${renderButtonContent("Izmeni", "edit")}</button>
                          <button class="danger-button button-with-icon icon-only-action" type="button" data-action="delete-habit" data-habit-id="${habit.id}" aria-label="Obriši naviku" title="Obriši">${renderButtonContent("Obriši", "delete")}</button>
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
          ${summary.streakHabits.length ? "" : `<p>Za stvari koje meriš na duže staze, tipa bez alkohola, bez cigareta ili doslednost mesecima.</p>`}
        </div>
      </div>
      ${
        topStreakHabit && summary.streakHabits.length > 1
          ? `
            <article class="routine-streak-spotlight">
              <div>
                <div class="routine-streak-spotlight-label">Najduži aktivni streak</div>
                <h3>${escapeHtml(topStreakHabit.name)}</h3>
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
                          <strong>${escapeHtml(habit.name)}</strong>
                          <div class="footer-note">${escapeHtml(habit.note || "Dugoročna evidencija je uključena za ovu naviku.")}</div>
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
                          <button class="ghost-button button-with-icon icon-only-action" type="button" data-action="edit-habit" data-habit-id="${habit.id}" aria-label="Izmeni naviku" title="Izmeni">${renderButtonContent("Izmeni", "edit")}</button>
                          <button class="danger-button button-with-icon icon-only-action" type="button" data-action="delete-habit" data-habit-id="${habit.id}" aria-label="Obriši naviku" title="Obriši">${renderButtonContent("Obriši", "delete")}</button>
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
          <h2>Taskovi za ${weekdayAccusative(state.selectedWeekday)}</h2>
          <p>Sitne obaveze za izabrani dan.</p>
        </div>
      </div>
      ${renderWeekTrackRow()}
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
      <details class="form-collapse" ${editingTask ? "open" : ""}>
        <summary>
          <span class="form-collapse-title">${editingTask ? "Izmena taska" : "Dodaj task"}</span>
          <span class="form-collapse-icon" aria-hidden="true">+</span>
        </summary>
      <form id="task-form" class="form-grid split">
        <div class="field">
          <label for="task-title">${editingTask ? "Izmena taska" : "Novi task"}</label>
          <input id="task-title" name="title" placeholder="npr. Spremi ručak" value="${escapeHtml(editingTask?.title || "")}" required />
        </div>
        <div class="field">
          <label for="task-note">Napomena</label>
          <input id="task-note" name="note" placeholder="opciono" value="${escapeHtml(editingTask?.note || "")}" />
        </div>
        <div class="entry-actions" style="justify-content:flex-start; gap:8px; flex-wrap:wrap;">
          <button class="solid-button secondary-button" type="submit">${editingTask ? "Sačuvaj izmenu" : "Dodaj task"}</button>
          ${editingTask ? '<button class="ghost-button" type="button" data-action="cancel-edit-task">Odustani</button>' : ""}
        </div>
      </form>
      </details>
      <div class="stack routine-task-stack" style="margin-top:14px;">
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
                            aria-label="${escapeHtml(task.title)}"
                            ${task.done ? "checked" : ""}
                          />
                          <span class="routine-check-ui" aria-hidden="true"></span>
                        </label>
                        <div class="routine-content">
                          <strong>${escapeHtml(task.title)}</strong>
                          ${task.note ? `<div class="footer-note">${escapeHtml(task.note)}</div>` : ""}
                        </div>
                        <div class="entry-actions" style="justify-content:flex-start; margin-top:0;">
                          <button class="ghost-button button-with-icon icon-only-action" type="button" data-action="edit-task" data-task-id="${task.id}" aria-label="Izmeni task" title="Izmeni">${renderButtonContent("Izmeni", "edit")}</button>
                          <button class="danger-button button-with-icon icon-only-action" type="button" data-action="delete-task" data-task-id="${task.id}" aria-label="Obriši task" title="Obriši">${renderButtonContent("Obriši", "delete")}</button>
                        </div>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">Još nema taskova za ${weekdayAccusative(state.selectedWeekday)} (${getWeekTrackLabel(state.selectedWeekTrack).toLowerCase()}). Dodaj prvi pa čekiraj kad završiš.</div>`
        }
      </div>
    </section>

    <section class="section routine-weekly-section">
      <div class="section-header">
        <div>
          <h2>Nedeljni pregled navika</h2>
        </div>
      </div>
      ${
        summary.habits.length
          ? `
            <div class="stats-grid stats-grid--glance">
              ${weeklyHabitProgress
                .map(
                  (day) => `
                    <article class="stat-card">
                      <strong>${weekdayLabel(day.weekday)}</strong>
                      <div class="macro-value">${day.progress}%</div>
                      <div class="footer-note">${day.doneCount}/${day.totalCount} ${srPlural(day.totalCount, "navika", "navike", "navika")}</div>
                    </article>
                  `
                )
                .join("")}
            </div>
          `
          : `<div class="empty empty-passive">Kad dodaš nedeljne navike, ovde ćeš videti pregled po danima.</div>`
      }
    </section>
  `;
}

// Adaptive correction: when measured weight drifts from the weight the goal
// was computed on, offer a one-tap recompute so the deficit stays accurate.
function renderAdaptiveGoalNudge() {
  const basis = toNumber(store.goals?.basisWeightKg);
  if (!basis) {
    return "";
  }
  const measurements = [...(store.measurements || [])]
    .filter((m) => toNumber(m.weightKg) > 0)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!measurements.length) {
    return "";
  }
  const currentWeight = toNumber(measurements[0].weightKg);
  if (Math.abs(currentWeight - basis) < 2) {
    return "";
  }
  const rec = getGoalRecommendation({ ...store.profile, weightKg: currentWeight }, store.goals);
  if (!rec) {
    return "";
  }
  return `
    <section class="section adaptive-goal-nudge">
      <div class="section-header">
        <div class="section-copy">
          <h2>Ažuriraj cilj</h2>
          <p>Težina se promenila (${roundValue(basis, 1)} → ${roundValue(currentWeight, 1)} kg). Da deficit ostane tačan, predlog je <strong>${rec.targetCalories} kcal</strong>${rec.rateKgPerWeek ? ` (${rec.rateKgPerWeek > 0 ? "+" : ""}${rec.rateKgPerWeek} kg/ned)` : ""}.</p>
        </div>
        <button class="solid-button secondary-button button-with-icon" type="button" data-action="apply-adaptive-goal">${renderButtonContent("Ažuriraj", "apply")}</button>
      </div>
    </section>`;
}

// ---- Kalibracija cilja (closed goal loop) -----------------------------------
// The profile formula (Mifflin + activity multiplier) is only a starting guess.
// Once there are enough fully-logged days and weigh-ins, the body itself tells
// us the real expenditure: what you ate minus what the scale did. From that we
// derive the calorie target that actually delivers the chosen pace, and offer
// it as a one-tap update. Nothing changes without the user's tap.
const CALIBRATION_INTAKE_WINDOW_DAYS = 14;
const CALIBRATION_WEIGHT_WINDOW_DAYS = 21;
const CALIBRATION_MIN_LOGGED_DAYS = 8;
const CALIBRATION_MIN_WEIGHINS = 3;
const CALIBRATION_MIN_WEIGHT_SPAN_DAYS = 10;
const CALIBRATION_MIN_CHANGE_KCAL = 75;
const CALIBRATION_MAX_STEP_KCAL = 250;
const CALIBRATION_COOLDOWN_DAYS = 7;

function getCalibrationState() {
  store.goals = store.goals || {};
  const raw = store.goals.calibration;
  return raw && typeof raw === "object" ? raw : {};
}

function daysBetweenDateValues(fromValue, toValue) {
  const from = getDateValueAsLocalDate(normalizeDateValue(fromValue));
  const to = getDateValueAsLocalDate(normalizeDateValue(toValue));
  if (!from || !to) {
    return null;
  }
  return Math.round((to.getTime() - from.getTime()) / DAY_IN_MS);
}

// Least-squares slope of weight over time (kg/day) — smooths the day-to-day
// water noise that a first-vs-last comparison would swallow whole.
function getWeightTrendSlope(points) {
  if (points.length < 2) {
    return null;
  }
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.day, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.kg, 0) / n;
  let num = 0;
  let den = 0;
  points.forEach((point) => {
    num += (point.day - meanX) * (point.kg - meanY);
    den += (point.day - meanX) ** 2;
  });
  return den > 0 ? num / den : null;
}

function getGoalCalibration() {
  const currentGoal = roundValue(toNumber(store.goals?.calories), 0);
  const rec = getGoalRecommendation();
  const today = getTodayDateValue();

  const days = getHistoryDays(CALIBRATION_INTAKE_WINDOW_DAYS);
  const loggedDays = days.filter((day) => isHistoryDayFinal(day));
  const avgKcal = loggedDays.length
    ? Math.round(loggedDays.reduce((sum, day) => sum + toNumber(day.snap.kcal), 0) / loggedDays.length)
    : 0;

  const weightPoints = [...(store.measurements || [])]
    .filter((m) => toNumber(m.weightKg) > 0)
    .map((m) => ({ date: normalizeDateValue(m.date), kg: toNumber(m.weightKg) }))
    .filter((m) => m.date && daysBetweenDateValues(m.date, today) != null && daysBetweenDateValues(m.date, today) <= CALIBRATION_WEIGHT_WINDOW_DAYS && daysBetweenDateValues(m.date, today) >= 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((m) => ({ ...m, day: -daysBetweenDateValues(m.date, today) }));
  const weightSpanDays = weightPoints.length >= 2 ? weightPoints[weightPoints.length - 1].day - weightPoints[0].day : 0;

  const missing = [];
  if (!currentGoal) missing.push("dnevni cilj");
  if (!rec) missing.push("popunjen profil");
  if (loggedDays.length < CALIBRATION_MIN_LOGGED_DAYS) {
    const need = CALIBRATION_MIN_LOGGED_DAYS - loggedDays.length;
    missing.push(`još ${need} ${need === 1 ? "kompletan dan" : need < 5 ? "kompletna dana" : "kompletnih dana"} unosa`);
  }
  if (weightPoints.length < CALIBRATION_MIN_WEIGHINS) {
    missing.push(`još ${CALIBRATION_MIN_WEIGHINS - weightPoints.length} ${CALIBRATION_MIN_WEIGHINS - weightPoints.length === 1 ? "merenje" : "merenja"} težine`);
  } else if (weightSpanDays < CALIBRATION_MIN_WEIGHT_SPAN_DAYS) {
    missing.push(`merenja razmaknuta bar ${CALIBRATION_MIN_WEIGHT_SPAN_DAYS} dana`);
  }

  const base = {
    status: "insufficient",
    loggedDays: loggedDays.length,
    windowDays: CALIBRATION_INTAKE_WINDOW_DAYS,
    weighIns: weightPoints.length,
    weightSpanDays,
    avgKcal,
    currentGoal,
    missing,
  };
  if (missing.length) {
    return base;
  }

  const slopePerDay = getWeightTrendSlope(weightPoints);
  const actualRate = roundValue(slopePerDay * 7, 2); // kg/week, negative = losing
  const expectedRate = roundValue(rec.rateKgPerWeek, 2);
  // Energy balance: intake minus what the scale says was stored/burned.
  const measuredTdee = Math.round(avgKcal - (actualRate * KCAL_PER_KG) / 7);
  const desiredRate = rec.requestedRateKgPerWeek;
  const floorCalories = Math.max(1200, roundValue(rec.bmr, 0));
  let idealTarget = Math.round((measuredTdee + (desiredRate * KCAL_PER_KG) / 7) / 10) * 10;
  let floored = false;
  if (desiredRate < 0 && idealTarget < floorCalories) {
    idealTarget = Math.round(floorCalories / 10) * 10;
    floored = true;
  }
  // One calibration moves the target by at most a modest step; the next one
  // (a week+ later, on fresh data) takes it further if the trend holds.
  const rawDelta = idealTarget - currentGoal;
  const delta = Math.max(-CALIBRATION_MAX_STEP_KCAL, Math.min(CALIBRATION_MAX_STEP_KCAL, rawDelta));
  const proposedTarget = Math.round((currentGoal + delta) / 10) * 10;

  const calibration = getCalibrationState();
  const lastTouched = calibration.lastAppliedAt || calibration.lastDismissedAt || "";
  const sinceTouched = lastTouched ? daysBetweenDateValues(lastTouched, today) : null;
  const inCooldown = sinceTouched != null && sinceTouched >= 0 && sinceTouched < CALIBRATION_COOLDOWN_DAYS;

  const rateGap = roundValue(actualRate - expectedRate, 2);
  const onTrack = Math.abs(proposedTarget - currentGoal) < CALIBRATION_MIN_CHANGE_KCAL;

  return {
    ...base,
    status: onTrack ? "on-track" : inCooldown ? "cooldown" : "suggest",
    actualRate,
    expectedRate,
    rateGap,
    measuredTdee,
    profileTdee: rec.maintenance,
    proposedTarget,
    idealTarget,
    delta: proposedTarget - currentGoal,
    capped: Math.abs(rawDelta) > CALIBRATION_MAX_STEP_KCAL,
    floored,
    floorCalories,
    currentWeight: weightPoints[weightPoints.length - 1].kg,
    goalMode: rec.goalMode,
    cooldownDaysLeft: inCooldown ? CALIBRATION_COOLDOWN_DAYS - sinceTouched : 0,
  };
}

function formatSignedRate(rate) {
  const value = roundValue(toNumber(rate), 2);
  if (Math.abs(value) < 0.005) {
    return "0 kg/ned";
  }
  return `${value > 0 ? "+" : "−"}${Math.abs(value)} kg/ned`;
}

function applyGoalCalibration() {
  const cal = getGoalCalibration();
  if (cal.status !== "suggest" && cal.status !== "cooldown") {
    return null;
  }
  const previous = roundValue(toNumber(store.goals.calories), 0);
  const macros = splitMacros(cal.proposedTarget, cal.currentWeight, cal.goalMode);
  store.goals.calories = cal.proposedTarget;
  store.goals.protein = macros.protein;
  store.goals.carbs = macros.carbs;
  store.goals.fat = macros.fat;
  store.goals.basisWeightKg = cal.currentWeight;
  store.profile.weightKg = cal.currentWeight;
  const today = getTodayDateValue();
  const state = getCalibrationState();
  const log = Array.isArray(state.log) ? state.log : [];
  log.unshift({
    date: today,
    from: previous,
    to: cal.proposedTarget,
    measuredTdee: cal.measuredTdee,
    avgKcal: cal.avgKcal,
    actualRate: cal.actualRate,
    expectedRate: cal.expectedRate,
  });
  store.goals.calibration = { ...state, lastAppliedAt: today, lastTdee: cal.measuredTdee, log: log.slice(0, 12) };
  persist();
  return { previous, next: cal.proposedTarget };
}

function dismissGoalCalibration() {
  const state = getCalibrationState();
  store.goals.calibration = { ...state, lastDismissedAt: getTodayDateValue() };
  persist();
}

function renderGoalCalibrationCard() {
  const cal = getGoalCalibration();
  const lastLog = (getCalibrationState().log || [])[0];
  const lastLine = lastLog
    ? `<div class="footer-note calibration-last">Poslednja kalibracija ${formatDateValueLabel(lastLog.date) || lastLog.date}: ${lastLog.from} → ${lastLog.to} kcal.</div>`
    : "";

  if (cal.status === "insufficient") {
    return `
    <section class="section calibration-section is-waiting">
      ${renderSectionLead("Kalibracija cilja", "Kad se skupi dovoljno podataka, cilj se proverava prema onome što telo stvarno radi, ne prema formuli.")}
      <div class="calibration-progress">
        <div class="calibration-progress-item">
          <span class="plan-net-label">Kompletni dani</span>
          <strong>${cal.loggedDays}/${CALIBRATION_MIN_LOGGED_DAYS}</strong>
          <span class="footer-note">u poslednjih ${cal.windowDays} dana</span>
        </div>
        <div class="calibration-progress-item">
          <span class="plan-net-label">Merenja težine</span>
          <strong>${cal.weighIns}/${CALIBRATION_MIN_WEIGHINS}</strong>
          <span class="footer-note">u poslednjih ${CALIBRATION_WEIGHT_WINDOW_DAYS} dan${CALIBRATION_WEIGHT_WINDOW_DAYS % 10 === 1 && CALIBRATION_WEIGHT_WINDOW_DAYS % 100 !== 11 ? "" : "a"}</span>
        </div>
      </div>
      <div class="footer-note">Fali: ${escapeHtml(cal.missing.join(", "))}. Čekiraj sve obroke u danu da bi se dan računao.</div>
      ${lastLine}
    </section>`;
  }

  const gapWord =
    Math.abs(cal.rateGap) < 0.1
      ? "Tempo se poklapa sa ciljem."
      : cal.actualRate < cal.expectedRate
        ? "Ide brže nego što je planirano."
        : "Ide sporije nego što je planirano.";
  const tdeeDiff = cal.measuredTdee - cal.profileTdee;
  const tdeeNote =
    Math.abs(tdeeDiff) < 60
      ? "Poklapa se sa procenom iz profila."
      : `${Math.abs(tdeeDiff)} kcal ${tdeeDiff > 0 ? "više" : "manje"} nego što formula iz profila kaže.`;

  const comparison = `
      <dl class="glance-list calibration-glance">
        <div class="glance-item">
          <dt>Očekivano</dt>
          <dd>${formatSignedRate(cal.expectedRate)}</dd>
        </div>
        <div class="glance-item">
          <dt>Stvarno</dt>
          <dd>${formatSignedRate(cal.actualRate)}</dd>
        </div>
        <div class="glance-item">
          <dt>Prosečan unos</dt>
          <dd>${cal.avgKcal} kcal</dd>
        </div>
      </dl>
      <div class="calibration-tdee">
        <span class="plan-net-label">Stvarna potrošnja</span>
        <strong>${cal.measuredTdee} kcal/dan</strong>
        <span class="footer-note">${tdeeNote}</span>
      </div>`;

  if (cal.status === "on-track") {
    const appliedAt = getCalibrationState().lastAppliedAt;
    const sinceApplied = appliedAt ? daysBetweenDateValues(appliedAt, getTodayDateValue()) : null;
    const freshlyCalibrated = sinceApplied != null && sinceApplied >= 0 && sinceApplied < CALIBRATION_COOLDOWN_DAYS;
    const okCopy = freshlyCalibrated
      ? `Cilj od ${cal.currentGoal} kcal je tek kalibrisan. Sledeća provera kad se skupi nova nedelja podataka.`
      : `${gapWord} Cilj od ${cal.currentGoal} kcal ostaje.`;
    return `
    <section class="section calibration-section is-ok">
      ${renderSectionLead("Kalibracija cilja", okCopy)}
      ${comparison}
      <div class="footer-note">Na osnovu ${cal.loggedDays} ${srPlural(cal.loggedDays, "kompletnog dana", "kompletna dana", "kompletnih dana")} i ${cal.weighIns} merenja.</div>
      ${lastLine}
    </section>`;
  }

  const direction = cal.delta < 0 ? "manje" : "više";
  return `
    <section class="section calibration-section is-suggest">
      ${renderSectionLead("Kalibracija cilja", `${gapWord} Da ${cal.goalMode.id === "gain" ? "dobijanje" : cal.goalMode.id === "lose" ? "mršavljenje" : "održavanje"} ide planiranim tempom, predlog je ${Math.abs(cal.delta)} kcal ${direction} dnevno.`)}
      ${comparison}
      <div class="calibration-proposal">
        <div class="calibration-proposal-values">
          <span class="calibration-from">${cal.currentGoal}</span>
          <span class="calibration-arrow" aria-hidden="true">→</span>
          <strong class="calibration-to">${cal.proposedTarget}</strong>
          <span class="calibration-unit">kcal</span>
        </div>
        <div class="footer-note">Makroi se preračunavaju uz novi cilj.${
          cal.floored
            ? ` Niže od ${cal.floorCalories} kcal ne idemo — to je bezbedni minimum (≈ BMR), pa će tempo biti blaži od izabranog.`
            : cal.capped
              ? " Promena je ograničena na 250 kcal po koraku; sledeća provera stiže za nedelju dana."
              : ""
        }</div>
      </div>
      <div class="meta-row meta-row--compact calibration-actions">
        ${
          cal.status === "cooldown"
            ? `<span class="footer-note">Odloženo — nova provera za ${getDayCountLabel(cal.cooldownDaysLeft)}.</span>
               <button class="ghost-button button-with-icon" type="button" data-action="apply-goal-calibration">${renderButtonContent("Primeni ipak", "apply")}</button>`
            : `<button class="solid-button button-with-icon" type="button" data-action="apply-goal-calibration">${renderButtonContent(`Primeni ${cal.proposedTarget} kcal`, "apply")}</button>
               <button class="ghost-button" type="button" data-action="dismiss-goal-calibration">Ne sada</button>`
        }
      </div>
      <div class="footer-note">Na osnovu ${cal.loggedDays} ${srPlural(cal.loggedDays, "kompletnog dana", "kompletna dana", "kompletnih dana")} i ${cal.weighIns} merenja u poslednjih ${CALIBRATION_WEIGHT_WINDOW_DAYS} dan${CALIBRATION_WEIGHT_WINDOW_DAYS % 10 === 1 && CALIBRATION_WEIGHT_WINDOW_DAYS % 100 !== 11 ? "" : "a"}.</div>
      ${lastLine}
    </section>`;
}

// Estimate when the target weight will be reached at the configured pace,
// anchored to the latest measured weight (falls back to the profile weight).
function getGoalEta() {
  const target = toNumber(store.goals?.targetWeightKg);
  if (!target) {
    return { status: "none" };
  }
  const weights = [...(store.measurements || [])]
    .filter((m) => toNumber(m.weightKg) > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const current = weights.length ? toNumber(weights[weights.length - 1].weightKg) : toNumber(store.profile?.weightKg);
  if (!current) {
    return { status: "none" };
  }
  const remaining = roundValue(target - current, 1);
  if (Math.abs(remaining) < 0.2) {
    return { status: "reached", target, current };
  }
  const rec = getGoalRecommendation();
  if (!rec) {
    return { status: "no-profile", target, current, remaining };
  }
  const rate = rec.rateKgPerWeek; // kg/week, negative = loss
  if (!rate) {
    return { status: "no-rate", target, current, remaining };
  }
  if (remaining < 0 !== rate < 0) {
    return { status: "wrong-direction", target, current, remaining };
  }
  const weeks = remaining / rate; // same sign → positive
  return { status: "ok", target, current, remaining, weeks, days: Math.round(weeks * 7) };
}

// Manual Latin month names — toLocaleDateString("sr-RS", {month:"long"}) returns
// Cyrillic in some engines, which clashes with the app's Latin script.
const SR_MONTHS_LATIN = ["januar", "februar", "mart", "april", "maj", "jun", "jul", "avgust", "septembar", "oktobar", "novembar", "decembar"];
function formatEtaDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getDate()}. ${SR_MONTHS_LATIN[d.getMonth()]} ${d.getFullYear()}.`;
}

function renderGoalEtaCard() {
  const eta = getGoalEta();
  if (eta.status === "none") {
    return "";
  }
  let tone = "info";
  let body;
  if (eta.status === "reached") {
    tone = "good";
    body = `Stigao si do cilja od <strong>${eta.target} kg</strong> 🎉`;
  } else if (eta.status === "no-profile") {
    body = `Cilj: <strong>${eta.target} kg</strong> (još ${Math.abs(eta.remaining)} kg). Popuni profil (pol, godine, visina, težina) pa procenim datum.`;
  } else if (eta.status === "no-rate") {
    body = `Cilj: <strong>${eta.target} kg</strong> (još ${Math.abs(eta.remaining)} kg). Izaberi tempo (ne „održavanje“) pa procenim datum.`;
  } else if (eta.status === "wrong-direction") {
    tone = "warn";
    body = `Cilj <strong>${eta.target} kg</strong> je u suprotnom smeru od izabranog cilja/tempa — proveri podešavanja.`;
  } else {
    const weeksLabel = eta.weeks < 1.5 ? "oko nedelju dana" : `za ~${Math.round(eta.weeks)} ned`;
    body = `Do cilja <strong>${eta.target} kg</strong> još <strong>${Math.abs(eta.remaining)} kg</strong> — pri ovom tempu oko <strong>${formatEtaDate(eta.days)}</strong> (${weeksLabel}).`;
  }
  return `<div class="goal-eta goal-eta--${tone}"><span class="goal-eta-icon" aria-hidden="true">🎯</span><p>${body}</p></div>`;
}

function renderGoalsTab() {
  const weeklyOverview = getWeeklyOverview();
  const goalRecommendation = getGoalRecommendation();
  const weeklyMetrics = [
    // Calories already shown in the stat cards above; keep only macros here.
    {
      label: "Proteini",
      value: roundValue(weeklyOverview.totals.protein, 1),
      goal: weeklyOverview.goals.protein,
      unit: "g",
      kind: "target",
      note: formatPlanDelta(weeklyOverview.totals.protein - weeklyOverview.goals.protein, "g"),
    },
    {
      label: "Ugljeni hidrati",
      value: roundValue(weeklyOverview.totals.carbs, 1),
      goal: weeklyOverview.goals.carbs,
      unit: "g",
      kind: "limit",
      note: formatPlanDelta(weeklyOverview.totals.carbs - weeklyOverview.goals.carbs, "g"),
    },
    {
      label: "Masti",
      value: roundValue(weeklyOverview.totals.fat, 1),
      goal: weeklyOverview.goals.fat,
      unit: "g",
      kind: "limit",
      note: formatPlanDelta(weeklyOverview.totals.fat - weeklyOverview.goals.fat, "g"),
    },
  ];

  const gView = ["cilj", "nedeljno", "nalog"].includes(state.goalsView) ? state.goalsView : "cilj";
  const gSegNav = `<div class="seg-nav">${[["cilj", "Cilj"], ["nedeljno", "Nedeljno"], ["nalog", "Nalog"]]
    .map(([id, label]) => `<button type="button" class="seg-nav-btn ${id === gView ? "is-active" : ""}" data-action="set-goals-view" data-view="${id}">${label}</button>`)
    .join("")}</div>`;

  return `
    ${gSegNav}

    ${gView === "cilj" ? `
    ${renderGoalCalibrationCard()}
    ${getGoalCalibration().status === "insufficient" ? renderAdaptiveGoalNudge() : ""}

    <section class="section goals-profile-section">
      ${renderSectionLead("Profil i ciljevi", "")}
      ${renderHelpNote("Iz profila (pol, godine, visina, težina, aktivnost) računamo <strong>BMR</strong> (potrošnja u mirovanju) i <strong>održavanje</strong> (sa aktivnošću). Tvoj <strong>dnevni cilj</strong> = održavanje ± tempo koji izabereš (npr. −0,5 kg/ned znači manji unos). Kad se težina promeni, ponudimo <strong>ažuriranje cilja</strong> da deficit ostane tačan. <strong>Backup</strong> je izvoz svih podataka u fajl — sigurnosna kopija koju možeš da uvezeš na drugom uređaju.")}
      <div class="goals-cilj-layout">
      <div class="goals-cilj-main">
      ${(() => {
        // The headline is the goal the app actually tracks against (store.goals),
        // which may be hand-set; the profile-based recommendation is shown as a
        // hint when it differs, instead of dashes hiding a perfectly valid goal.
        const activeCalories = roundValue(store.goals.calories, 0);
        const headline = activeCalories > 0 ? activeCalories : goalRecommendation ? goalRecommendation.targetCalories : 0;
        const recDiffers = goalRecommendation && activeCalories > 0 && Math.abs(goalRecommendation.targetCalories - activeCalories) > 25;
        const paceLabel = goalRecommendation
          ? goalRecommendation.rateKgPerWeek
            ? `${goalRecommendation.goalMode.label} · ${goalRecommendation.rateKgPerWeek > 0 ? "+" : ""}${goalRecommendation.rateKgPerWeek} kg/ned${
                goalRecommendation.paceLimited ? " (tempo ograničen bezbednim minimumom kalorija)" : ""
              }`
            : goalRecommendation.goalMode.label
          : "";
        const calibrated = getCalibrationState();
        const note = !headline
          ? "Popuni profil i izaberi cilj ispod"
          : calibrated.lastAppliedAt
            ? `Kalibrisano prema stvarnoj potrošnji (${calibrated.lastTdee} kcal/dan) · ${paceLabel || goalRecommendation.goalMode.label}`
            : recDiffers
              ? `Iz profila bi bilo ${goalRecommendation.targetCalories} kcal — „Izračunaj iz cilja“ ispod da preuzmeš`
              : goalRecommendation
                ? paceLabel
                : "Ručno postavljen cilj · popuni pol i visinu za obračun iz profila";
        const macro = (key) => {
          const stored = toNumber(store.goals[key]);
          if (stored > 0) return `${roundValue(stored, 0)} g`;
          if (goalRecommendation) return `${goalRecommendation[key]} g`;
          return "—";
        };
        return `
      <div class="stat-hero">
        <span class="hero-day-label">Dnevni cilj</span>
        <div class="stat-hero-value">
          ${headline ? `<strong>${headline}</strong> kcal` : `<strong>—</strong>`}
        </div>
        <div class="footer-note">${note}</div>
      </div>
      ${
        goalRecommendation
          ? `<div class="plan-net-row goals-calc-row">
        <div class="plan-net-item">
          <span class="plan-net-label">BMR</span>
          <strong>${goalRecommendation.bmr}</strong>
        </div>
        <span class="plan-net-op">→</span>
        <div class="plan-net-item">
          <span class="plan-net-label">Održavanje</span>
          <strong>${goalRecommendation.maintenance}</strong>
        </div>
      </div>`
          : ""
      }
      <div class="plan-net-row goals-macro-row">
        <div class="plan-net-item">
          <span class="plan-net-label">Proteini</span>
          <strong>${macro("protein")}</strong>
        </div>
        <div class="plan-net-item">
          <span class="plan-net-label">UH</span>
          <strong>${macro("carbs")}</strong>
        </div>
        <div class="plan-net-item">
          <span class="plan-net-label">Masti</span>
          <strong>${macro("fat")}</strong>
        </div>
      </div>`;
      })()}
      ${renderGoalEtaCard()}
      <form id="goals-form" class="form-grid split goals-form-layout">
        <div class="form-group-label">Profil</div>
        <div class="field field--full">
          <label for="profile-name">Ime</label>
          <input id="profile-name" name="name" value="${escapeHtml(store.profile.name || "")}" />
        </div>
        ${renderChoiceField("Pol", "sex", store.profile.sex, [
          { id: "male", label: "Muško" },
          { id: "female", label: "Žensko" },
        ])}
        ${renderUnitField("profile-age", "Godine", "god.", `<input id="profile-age" name="age" type="number" inputmode="decimal" min="0" value="${store.profile.age || ""}" />`)}
        ${renderUnitField("profile-weight", "Težina", "kg", `<input id="profile-weight" name="weightKg" type="number" inputmode="decimal" step="0.1" min="0" value="${store.profile.weightKg || ""}" />`)}
        ${renderUnitField("profile-height", "Visina", "cm", `<input id="profile-height" name="heightCm" type="number" inputmode="decimal" step="1" min="0" value="${store.profile.heightCm || ""}" />`)}
        ${renderChoiceField(
          "Aktivnost",
          "activityLevel",
          store.profile.activityLevel,
          ACTIVITY_LEVELS.map((activity) => ({
            id: activity.id,
            label: ACTIVITY_SHORT_LABELS[activity.id] || activity.label,
            hint: ACTIVITY_HINTS[activity.id] || "",
          }))
        )}
        <div class="form-group-label">Cilj i tempo</div>
        ${renderChoiceField("Cilj", "targetMode", store.goals.targetMode, GOAL_MODES.map((mode) => ({ id: mode.id, label: mode.label })))}
        ${renderChoiceField(
          "Tempo",
          "paceLevel",
          store.goals.paceLevel || "umereno",
          PACE_LEVELS.map((level) => ({ id: level.id, label: level.label, hint: paceHintFor(level.id, store.goals.targetMode) }))
        )}
        ${renderUnitField("goal-target-weight", "Ciljna težina", "kg", `<input id="goal-target-weight" name="targetWeightKg" type="number" inputmode="decimal" step="0.1" min="0" value="${store.goals.targetWeightKg || ""}" placeholder="npr. 78" />`, true)}
        <div class="form-group-label">Dnevni unos</div>
        ${renderUnitField("goal-calories", "Dnevni cilj", "kcal", `<input id="goal-calories" name="calories" type="number" inputmode="decimal" step="1" min="0" value="${store.goals.calories || ""}" />`, true)}
        <div class="form-grid-3">
        ${renderUnitField("goal-protein", "Proteini", "g", `<input id="goal-protein" name="protein" type="number" inputmode="decimal" step="0.1" min="0" value="${store.goals.protein || ""}" />`)}
        ${renderUnitField("goal-carbs", "Ugljeni hidrati", "g", `<input id="goal-carbs" name="carbs" type="number" inputmode="decimal" step="0.1" min="0" value="${store.goals.carbs || ""}" />`)}
        ${renderUnitField("goal-fat", "Masti", "g", `<input id="goal-fat" name="fat" type="number" inputmode="decimal" step="0.1" min="0" value="${store.goals.fat || ""}" />`)}
        </div>
        <!-- Makroi i kalorijski cilj su dva odvojena polja koja se lako raziđu.
             Ovaj red živo sabira 4/4/9 i kaže koliko fali ili je previše. -->
        <p class="macro-check field--full" id="goal-macro-check" data-role="macro-check">${renderGoalMacroCheck(store.goals)}</p>
        <div class="form-grid-3 goals-daily-extras">
        <div class="field">
          <label for="goal-water">Voda</label>
          <input id="goal-water" name="waterL" type="number" inputmode="decimal" step="0.25" min="0.5" max="6" value="${(Math.max(0, toNumber(store.goals.waterMl) || 2500) / 1000).toFixed(2).replace(/\.?0+$/, "")}" />
        </div>
        <div class="field">
          <label for="goal-steps">Koraci dnevno</label>
          <input id="goal-steps" name="stepsGoal" type="number" inputmode="numeric" step="500" min="0" value="${Math.max(0, toNumber(store.goals.stepsGoal) || 10000)}" />
        </div>
        <div class="field">
          <label for="goal-coffee">Kafa (kcal/šoljica)</label>
          <input id="goal-coffee" name="coffeeKcal" type="number" inputmode="numeric" step="1" min="0" max="500" value="${getCoffeeCupKcal()}" />
        </div>
        </div>
        <!-- Crna kafa je ~10 kcal na šoljicu od 200 ml; šećer i mleko su ono
             što je diže, pa broj ostaje na tebi. Nula = red samo broji šoljice. -->
        <p class="footer-note field--full">Kafa: crna ~10 kcal po šoljici, sa kašičicom šećera ~26, sa mlekom i šećerom ~50. Stavi 0 ako želiš samo da brojiš šoljice.</p>
        <div class="meta-row">
          <button class="ghost-button" type="button" data-action="recalculate-goals">Izračunaj iz cilja</button>
          <button class="solid-button" type="submit">Sačuvaj</button>
        </div>
      </form>
      </div>
      ${
        // At >=1280px this card is a two-column composition: form on the left,
        // weight trend on the right. With no weigh-ins there is no chart, and
        // the column used to sit empty — a 500px void beside a capped form.
        // The prompt that fills it is also the thing that unlocks both the
        // chart and the goal calibration, so the space earns its place.
        getMeasurementSeries("weightKg").length
          ? `<div class="goals-cilj-chart">${renderTrendCard(measurementFields.find((field) => field.id === "weightKg"))}</div>`
          : `<div class="goals-cilj-chart goals-chart-invite">
              <div class="empty">
                <strong>Još nema merenja težine.</strong>
                <span>Unesi težinu jednom nedeljno — ovde se crta trend, a cilj počinje da se proverava prema onome što telo stvarno radi, ne prema formuli.</span>
                <button class="solid-button button-with-icon" type="button" data-action="jump-measurement">${renderButtonContent("Unesi prvo merenje", "add")}</button>
              </div>
            </div>`
      }
      </div>
    </section>
    ` : ""}

    ${gView === "nedeljno" ? `
    <section class="section goals-weekly-section">
      ${renderSectionLead("Nedeljni nivo", "Zbir za svih 7 dana, da odmah vidiš da li si u kalorijama i makroima na nivou cele nedelje.")}
      <div class="stats-grid stats-grid--glance">
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
          <div class="footer-note">Zbir kalorija treninga po danima</div>
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

    <details class="section goals-days-section form-collapse form-collapse--view">
      <summary>
        <span class="form-collapse-title">Pregled po danima</span>
        <span class="form-collapse-icon form-collapse-icon--chevron" aria-hidden="true">${renderChevronIcon(false)}</span>
      </summary>
      <div class="stats-grid stats-grid--glance">
        ${weeklyOverview.days
          .map(
            (day) => `
              <article class="stat-card">
                <strong>${weekdayLabel(day.weekday)}</strong>
                <div class="macro-value">${roundValue(day.totals.kcal, 0)} kcal</div>
                <div class="footer-note">${formatPlanDelta(day.goalDelta, "kcal")}</div>
              </article>
            `
          )
          .join("")}
      </div>
    </details>
    ` : ""}

    ${gView === "nalog" ? `
    ${renderAccountSection()}
    ` : ""}
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
            ${renderButtonContent(`Primeni u ${weekdayLabel(state.selectedWeekday)}`, "apply")}
          </button>
          <button class="ghost-button button-with-icon" data-action="apply-nutrition-plan-day" data-plan-id="${selectedPlan.id}" data-mode="append">
            ${renderButtonContent(`Dodaj u ${weekdayLabel(state.selectedWeekday)}`, "add")}
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
                              <span class="pill">${escapeHtml(item.displayName || item.foodName)} · ${formatFoodAmount(getFoodById(item.foodId), item.grams)}</span>
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
          title: `${documents.length} ${srPlural(documents.length, "dokument", "dokumenta", "dokumenata")} u arhivi`,
          detail: "Svaki import pamti izvor, kratak sažetak i koliko je recepata, namirnica i preporuka izvučeno.",
          statusLabel: documents.length ? "Arhiva živa" : "Još prazno",
          tone: documents.length ? "success" : "warning",
          pills: [
            { label: `${plans.length} dana u planu`, tone: "success" },
            { label: `${recommendations.length} ${srPlural(recommendations.length, "preporuka", "preporuke", "preporuka")}`, tone: "info" },
            { label: `${importedRecipes.length} ${srPlural(importedRecipes.length, "recept", "recepta", "recepata")}`, tone: "success" },
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
            : `<div class="empty empty-passive">Kad uvezeš dokumente, ovde će se pojaviti saveti, smernice i napomene nutricioniste.</div>`
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
                        <span class="pill">${recipe.items.length} ${srPlural(recipe.items.length, "sastojak", "sastojka", "sastojaka")}</span>
                        <span class="pill">${recipe.servings || 1} ${recipe.servings === 1 ? "porcija" : recipe.servings < 5 ? "porcije" : "porcija"}</span>
                        <span class="pill">${recipe.prepTimeMinutes ? `${recipe.prepTimeMinutes} min` : "Vreme nije nađeno"}</span>
                        <span class="pill note">Ukupno ${roundValue(recipe.totals.kcal, 0)} kcal</span>
                        <span class="pill">Po porciji ${roundValue(recipe.perServingTotals.kcal, 0)} kcal</span>
                        <span class="pill">P ${roundValue(recipe.perServingTotals.protein, 1)} g</span>
                        <span class="pill">UH ${roundValue(recipe.perServingTotals.carbs, 1)} g</span>
                        <span class="pill">M ${roundValue(recipe.perServingTotals.fat, 1)} g</span>
                        ${pendingReviewCount ? `<span class="pill pill--warning">${pendingReviewCount} ${srPlural(pendingReviewCount, "stavka", "stavke", "stavki")} za povezivanje</span>` : ""}
                      </div>
                      ${renderNutritionSourcePills(recipe.importSourceDocNames)}
                      <div class="recipe-library-ingredients suggestion-row nutrition-inline-list">
                        ${recipe.items
                          .map(
                            (item) =>
                              `<span class="pill">${escapeHtml(item.displayName || item.foodName)} · ${formatFoodAmount(getFoodById(item.foodId), item.grams)}</span>`
                          )
                          .join("")}
                      </div>
                      <div class="entry-actions nutrition-card-actions">
                        <button class="solid-button secondary-button button-with-icon" data-action="open-recipe-apply-dialog" data-favorite-id="${recipe.id}">
                          ${renderButtonContent("Dodaj u plan", "apply")}
                        </button>
                        ${
                          pendingReviewCount
                            ? `
                              <button class="ghost-button button-with-icon" data-action="switch-tab" data-tab="nutrition">
                                ${renderButtonContent("Poveži stavke", "edit")}
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
            : `<div class="empty empty-passive">Ovde ćeš videti recepte koje izvučem iz dokumenata, zajedno sa sastojcima i gramažom.</div>`
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
                      type="number" inputmode="decimal"
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
                    <input id="nutrition-food-protein" name="protein" type="number" inputmode="decimal" step="0.1" min="0" value="${toNumber(nutritionEditingFood.protein) > 0 ? roundValue(nutritionEditingFood.protein, 1) : ""}" />
                  </div>
                  <div class="field">
                    <label for="nutrition-food-carbs">Ugljeni hidrati na 100 g</label>
                    <input id="nutrition-food-carbs" name="carbs" type="number" inputmode="decimal" step="0.1" min="0" value="${toNumber(nutritionEditingFood.carbs) > 0 ? roundValue(nutritionEditingFood.carbs, 1) : ""}" />
                  </div>
                  <div class="field">
                    <label for="nutrition-food-fat">Masti na 100 g</label>
                    <input id="nutrition-food-fat" name="fat" type="number" inputmode="decimal" step="0.1" min="0" value="${toNumber(nutritionEditingFood.fat) > 0 ? roundValue(nutritionEditingFood.fat, 1) : ""}" />
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
            : `<div class="empty empty-passive">Review inbox je čist. Kad parser izvuče nove nerešene namirnice, pojaviće se ovde dok ih ne dopuniš ili ukloniš kao duplikat.</div>`
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
                        <span class="pill">${doc.recipeCount || 0} ${srPlural(doc.recipeCount || 0, "recept", "recepta", "recepata")}</span>
                        <span class="pill">${doc.foodCount || 0} ${srPlural(doc.foodCount || 0, "namirnica", "namirnice", "namirnica")}</span>
                        <span class="pill">${doc.recommendationCount || 0} ${srPlural(doc.recommendationCount || 0, "preporuka", "preporuke", "preporuka")}</span>
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

function renderAccountSection() {
  const syncStatusTone = getSyncStatusTone();

  return `
    <section class="section settings-account-section">
      ${(() => {
        const email = String(state.authUser?.email || "").trim();
        const demo = isDemoAccount();
        const name = demo ? "Demo nalog" : String(store.profile?.name || "").trim() || (email ? email.split("@")[0] : "Nalog");
        const initial = (name || email || "?").charAt(0).toUpperCase();
        const facts = [];
        if (toNumber(store.profile?.age) > 0) facts.push(["Godine", `${roundValue(toNumber(store.profile.age), 0)}`]);
        if (toNumber(store.profile?.heightCm) > 0) facts.push(["Visina", `${roundValue(toNumber(store.profile.heightCm), 0)} cm`]);
        if (toNumber(store.profile?.weightKg) > 0) facts.push(["Težina", `${roundValue(toNumber(store.profile.weightKg), 1)} kg`]);
        if (toNumber(store.goals?.calories) > 0) facts.push(["Dnevni cilj", `${roundValue(toNumber(store.goals.calories), 0)} kcal`]);
        return `
          <div class="profile-hero">
            <span class="profile-hero-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
            <div class="profile-hero-copy">
              <h2 class="profile-hero-name">${escapeHtml(name)}${demo ? `<span class="more-sheet-user-badge">DEMO</span>` : ""}</h2>
              ${email ? `<div class="profile-hero-email">${escapeHtml(email)}</div>` : ""}
              <div class="pill-row profile-hero-pills">
                <span class="pill strong pill--${syncStatusTone}">${state.syncStatus}</span>
              </div>
            </div>
          </div>
          ${
            facts.length
              ? `<dl class="glance-list profile-facts">${facts
                  .map(([label, value]) => `<div class="glance-item"><dt>${label}</dt><dd>${value}</dd></div>`)
                  .join("")}</dl>`
              : ""
          }`;
      })()}
      <div class="settings-grid">
        <article class="status-summary-card">
          <div class="status-summary-top">
            <div class="status-summary-copy">
              <strong>Nalog</strong>
              <div class="footer-note">Cloud sync čuva plan, obroke, trening, rutinu, merenja i ciljeve. Slike ostaju na ovom uređaju.</div>
            </div>
          </div>
          <div class="meta-row meta-row--compact status-summary-actions">
            <button class="ghost-button button-with-icon" type="button" data-action="force-refresh" title="Povuci najnoviju verziju aplikacije">${renderButtonContent("Osveži aplikaciju", "refresh")}</button>
            <button class="ghost-button signout-button button-with-icon" type="button" data-action="sign-out">${renderButtonContent("Odjavi se", "signout")}</button>
          </div>
        </article>

        <article class="status-summary-card">
          <div class="status-summary-top">
            <div class="status-summary-copy">
              <strong>Deljeni proizvodi</strong>
              <div class="footer-note">Proizvodi koje su drugi korisnici skenirali (barkod, vrednosti na 100 g) pojavljuju se u pretrazi namirnica pod „Deljeni proizvodi“. Tvoje namirnice ostaju samo tvoje.</div>
            </div>
            <span class="pill strong ${isSharedFoodsEnabled() ? "pill--success" : "pill--info"}">${isSharedFoodsEnabled() ? "Uključeno" : "Isključeno"}</span>
          </div>
          <label class="settings-toggle">
            <input type="checkbox" class="routine-checkbox" data-action="toggle-shared-foods" ${isSharedFoodsEnabled() ? "checked" : ""} />
            <span class="routine-check-ui" aria-hidden="true"></span>
            <span class="settings-toggle-label">Prikaži deljene proizvode u pretrazi</span>
          </label>
        </article>

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
        <article class="status-summary-card settings-danger-card">
          <div class="status-summary-top">
            <div class="status-summary-copy">
              <strong>Isprazni plan obroka</strong>
              <div class="footer-note">Briše sve obroke iz obe nedelje plana. Čekirani (pojedeni) obroci ostaju, namirnice i recepti se ne diraju. Može da se poništi odmah posle brisanja.</div>
            </div>
          </div>
          <div class="meta-row meta-row--compact status-summary-actions">
            <button class="danger-button button-with-icon" type="button" data-action="delete-all-plan-meals" ${store.weeklyPlanEntries.length ? "" : "disabled"}>${renderButtonContent("Obriši sve obroke", "delete")}</button>
          </div>
        </article>
${
          isDemoAccount()
            ? `
        <article class="status-summary-card settings-danger-card">
          <div class="status-summary-top">
            <div class="status-summary-copy">
              <strong>Demo nalog</strong>
              <div class="footer-note">Vrati ovaj nalog na početni plan, namirnice i trening. Briše sve izmene na demo nalogu (i lokalne slike na ovom uređaju). Tvoji lični nalozi se ne diraju.</div>
            </div>
            <span class="pill strong pill--warning">Demo</span>
          </div>
          <div class="meta-row meta-row--compact status-summary-actions">
            <button class="danger-button button-with-icon" type="button" data-action="reset-demo-data">${renderButtonContent("Vrati na fabrička", "refresh")}</button>
          </div>
        </article>`
            : `
        <article class="status-summary-card settings-danger-card">
          <div class="status-summary-top">
            <div class="status-summary-copy">
              <strong>Obriši sve podatke</strong>
              <div class="footer-note">Briše plan, trening, rutinu, dnevnik, merenja i slike. Namirnice, recepti, profil i ciljevi (kalorije/makroi) ostaju netaknuti. Ne može da se poništi; napravi backup gore ako želiš da nešto sačuvaš.</div>
            </div>
            <span class="pill strong pill--warning">Trajno</span>
          </div>
          <div class="meta-row meta-row--compact status-summary-actions">
            <button class="danger-button button-with-icon" type="button" data-action="delete-all-data">${renderButtonContent("Obriši sve podatke", "delete")}</button>
          </div>
        </article>`
        }
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

// Catmull-Rom → cubic Bézier so the trend reads as a smooth curve, not a
// jagged polyline. Passes through every point; gentle 1/6 tension.
function buildSmoothLinePath(pts) {
  if (!pts.length) {
    return "";
  }
  if (pts.length < 3) {
    return `M ${pts.map((p) => `${p.x},${p.y}`).join(" L ")}`;
  }
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = roundValue(p1.x + (p2.x - p0.x) / 6, 2);
    const cp1y = roundValue(p1.y + (p2.y - p0.y) / 6, 2);
    const cp2x = roundValue(p2.x - (p3.x - p1.x) / 6, 2);
    const cp2y = roundValue(p2.y - (p3.y - p1.y) / 6, 2);
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
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

  // Goal projection (weight only): where you'd be at each weigh-in date if the
  // configured pace holds, anchored at the first measurement. Lets you see at a
  // glance whether the actual line is running ahead of or behind plan.
  let projection = null;
  let goalRate = 0;
  if (field.id === "weightKg" && series.length >= 2) {
    const rec = getGoalRecommendation();
    goalRate = rec ? rec.rateKgPerWeek : 0;
    const anchorDate = getDateValueAsLocalDate(series[0].date);
    if (goalRate && anchorDate) {
      const anchorValue = series[0].value;
      projection = series.map((point) => {
        const pointDate = getDateValueAsLocalDate(point.date);
        const weeks = pointDate ? (pointDate.getTime() - anchorDate.getTime()) / (7 * DAY_IN_MS) : 0;
        return anchorValue + goalRate * weeks;
      });
    }
  }

  const targetWeight = field.id === "weightKg" ? toNumber(store.goals?.targetWeightKg) : 0;
  const valuesForScale = series
    .map((point) => point.value)
    .concat(projection || [])
    .concat(targetWeight ? [targetWeight] : []);
  const min = Math.min(...valuesForScale);
  const max = Math.max(...valuesForScale);
  const width = 320;
  const height = 160;
  const paddingX = 18;
  const paddingY = 18;
  const range = max - min || 1;
  const stepX = series.length > 1 ? (width - paddingX * 2) / (series.length - 1) : 0;
  const toY = (value) => roundValue(height - paddingY - ((value - min) / range) * (height - paddingY * 2), 1);
  const points = series.map((point, index) => ({
    ...point,
    x: roundValue(paddingX + index * stepX, 1),
    y: toY(point.value),
  }));
  const latest = series[series.length - 1];
  const first = series[0];
  const delta = roundValue(latest.value - first.value, 1);
  const last = points[points.length - 1];
  const gradId = `chart-grad-${field.id}`;
  const baseline = height - paddingY;
  const linePath = buildSmoothLinePath(points);
  const areaPath = `${linePath} L ${last.x},${baseline} L ${points[0].x},${baseline} Z`;
  const gridLines = [0.5, 1]
    .map((factor) => {
      const gy = roundValue(paddingY + factor * (height - paddingY * 2) * 0.66, 1);
      return `<line x1="${paddingX}" y1="${gy}" x2="${width - paddingX}" y2="${gy}" class="chart-grid"></line>`;
    })
    .join("");

  let goalLineSvg = "";
  let targetLineSvg = "";
  let trackPill = "";
  let etaCaption = "";
  const legendItems = [];
  if (projection) {
    const projPoints = projection.map((value, index) => `${roundValue(paddingX + index * stepX, 1)},${toY(value)}`);
    goalLineSvg = `<polyline points="${projPoints.join(" ")}" class="chart-goal-line" fill="none"></polyline>`;
    const expectedNow = projection[projection.length - 1];
    const diff = roundValue(latest.value - expectedNow, 1);
    // Loss (rate < 0): being below the line is ahead; gain (rate > 0): above.
    const aheadGood = goalRate < 0 ? diff <= 0 : diff >= 0;
    if (Math.abs(diff) < 0.3) {
      trackPill = `<span class="pill strong pill--success">na cilju</span>`;
    } else {
      trackPill = `<span class="pill strong pill--${aheadGood ? "success" : "warning"}">${Math.abs(diff)} kg ${aheadGood ? "ispred plana" : "iza plana"}</span>`;
    }
    legendItems.push(`<span class="chart-legend-item"><span class="chart-legend-swatch chart-legend-swatch--actual"></span>stvarno</span>`);
    legendItems.push(`<span class="chart-legend-item"><span class="chart-legend-swatch chart-legend-swatch--goal"></span>tempo (${goalRate > 0 ? "+" : ""}${goalRate} kg/ned)</span>`);
  }
  if (targetWeight) {
    const ty = toY(targetWeight);
    targetLineSvg = `<line x1="${paddingX}" y1="${ty}" x2="${width - paddingX}" y2="${ty}" class="chart-target-line"></line>`;
    if (!legendItems.length) {
      legendItems.push(`<span class="chart-legend-item"><span class="chart-legend-swatch chart-legend-swatch--actual"></span>stvarno</span>`);
    }
    legendItems.push(`<span class="chart-legend-item"><span class="chart-legend-swatch chart-legend-swatch--target"></span>ciljna težina (${roundValue(targetWeight, 1)} kg)</span>`);
    const eta = getGoalEta();
    if (eta.status === "ok") {
      etaCaption = `<div class="chart-eta">🎯 cilj oko <strong>${formatEtaDate(eta.days)}</strong> (za ~${Math.round(eta.weeks)} ned)</div>`;
    } else if (eta.status === "reached") {
      etaCaption = `<div class="chart-eta">🎯 cilj dostignut!</div>`;
    } else if (eta.status === "no-profile") {
      etaCaption = `<div class="chart-eta">Popuni profil (pol, godine, visina, težina) da procenim datum.</div>`;
    } else if (eta.status === "no-rate") {
      etaCaption = `<div class="chart-eta">Izaberi tempo (ne „održavanje“) da procenim datum.</div>`;
    } else if (eta.status === "wrong-direction") {
      etaCaption = `<div class="chart-eta chart-eta--warn">Težina ide suprotno od cilja — proveri podešavanja.</div>`;
    }
  }
  const legendHtml = legendItems.length ? `<div class="chart-legend">${legendItems.join("")}</div>` : "";

  return `
    <article class="chart-card">
      <div class="chart-card-top">
        <h3>${field.label}</h3>
        <span class="pill strong">${formatFieldValue(field, latest.value)}</span>
      </div>
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Trend za ${field.label}">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.2"></stop>
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${areaPath}" class="chart-area" fill="url(#${gradId})"></path>
        ${targetLineSvg}
        ${goalLineSvg}
        <path d="${linePath}" class="chart-line" fill="none"></path>
        <circle cx="${last.x}" cy="${last.y}" r="3.6" class="chart-dot is-current"></circle>
      </svg>
      <div class="meta-row">
        <span class="pill">${first.label}</span>
        <span class="pill">${latest.label}</span>
        ${renderMeasurementDelta(delta, field.unit)}
        ${trackPill}
      </div>
      ${legendHtml}
      ${etaCaption}
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
        <h3>${escapeHtml(group.exerciseName)}</h3>
        <span class="pill strong">${roundValue(group.latest.weightKg, 1)} kg</span>
      </div>
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend za ${escapeHtml(group.exerciseName)}">
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
        Poslednje: ${new Date(group.latest.date).toLocaleDateString("sr-RS")}${group.latest.weekday ? ` · ${group.latest.weekday}` : ""}${group.latest.note ? ` · ${escapeHtml(group.latest.note)}` : ""}
      </div>
    </article>
  `;
}

function getPhotoDateDefault() {
  return getLocalDateInputValue();
}

// Kalorijski cilj koji je važio na dati dan. recordTodaySnapshot piše cilj u
// store.history svakog dana, pa je snapshot tačniji od tekućeg cilja za datume
// unazad; tekući cilj je fallback za dane bez snapshota (npr. prvi dan).
function getCalorieGoalForDate(date) {
  const key = normalizeDateValue(date) || date;
  const snapshotGoal = roundValue(toNumber((store.history || {})[key]?.calorieGoal), 0);
  if (snapshotGoal > 0) {
    return snapshotGoal;
  }
  return roundValue(toNumber(store.goals?.calories), 0);
}

// Pilula sa kalorijama za jedan unos. Nova merenja nose zamrznut cilj
// (calorieGoal); stari unosi imaju ručno kucan calorieDeficit i prikazuju se pod
// svojim imenom, da im ne pripišemo značenje koje nisu imali.
function getMeasurementCaloriePill(entry) {
  const goal = roundValue(toNumber(entry?.calorieGoal), 0);
  if (goal > 0) {
    return `<span class="pill">Cilj: ${goal} kcal</span>`;
  }
  const legacy = roundValue(toNumber(entry?.calorieDeficit), 0);
  return legacy > 0 ? `<span class="pill">Kalorije: ${legacy} kcal</span>` : "";
}

function renderMeasurementGoalNote(date) {
  const goal = getCalorieGoalForDate(date);
  if (!(goal > 0)) {
    return `<span class="footer-note">Kalorijski cilj se upisuje sam uz merenje — postavi ga u Ciljevima.</span>`;
  }
  return `<span class="footer-note">Kalorijski cilj tog dana: <strong>${goal} kcal</strong> — upisuje se sam, ne kucaš ga.</span>`;
}

function getPhotoTagLabel(tag) {
  return PHOTO_TAG_LABELS[tag] || tag || "bez taga";
}

// Slike i merenja se spajaju po datumu, bez tvrde veze: postojeće slike se same
// povežu (nema migracije), slika dodata kasnije sa istim datumom uđe u istu
// sesiju, a brisanje merenja ne ostavlja siročiće.
function getMeasurementWeightForDate(date) {
  const key = normalizeDateValue(date) || date;
  const match = (store.measurements || []).find(
    (entry) => (normalizeDateValue(entry?.date) || entry?.date) === key && toNumber(entry?.weightKg) > 0
  );
  return match ? roundValue(toNumber(match.weightKg), 1) : null;
}

// Galerija se grupiše po danu snimanja: jedan red = jedna sesija (front/bok/leđa),
// pa se čita kao vremenska linija umesto kao ravan niz pojedinačnih slika.
function groupPhotosByDate(photos) {
  const byDate = new Map();
  photos.forEach((photo) => {
    const key = normalizeDateValue(photo?.date) || photo?.date || "";
    if (!byDate.has(key)) {
      byDate.set(key, []);
    }
    byDate.get(key).push(photo);
  });
  return [...byDate.entries()]
    .map(([date, items]) => ({
      date,
      photos: [...items].sort((a, b) => PHOTO_TAGS.indexOf(a.tag) - PHOTO_TAGS.indexOf(b.tag)),
    }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Ono zbog čega se poređenje uopšte otvara: koliko je kilograma otišlo između
// dve slike i za koliko dana. Ćuti ako za neki od dva datuma nema merenja.
function renderCompareDelta(leftPhoto, rightPhoto) {
  const leftWeight = getMeasurementWeightForDate(leftPhoto?.date);
  const rightWeight = getMeasurementWeightForDate(rightPhoto?.date);
  const days = getDaysBetweenDates(leftPhoto?.date, rightPhoto?.date);
  // days === 0 je validno (dve slike istog dana) — samo null znači „ne znam“.
  if (leftWeight === null || rightWeight === null || days === null) {
    return `<div class="footer-note compare-delta-note">Unesi merenje za oba datuma pa će ovde pisati razlika u kilogramima.</div>`;
  }
  const leftIsOlder = new Date(leftPhoto.date) <= new Date(rightPhoto.date);
  const olderWeight = leftIsOlder ? leftWeight : rightWeight;
  const newerWeight = leftIsOlder ? rightWeight : leftWeight;
  const delta = roundValue(newerWeight - olderWeight, 1);
  const tone = delta < 0 ? "measure-delta--down" : delta > 0 ? "measure-delta--up" : "measure-delta--flat";
  const deltaLabel = delta === 0 ? "bez promene" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} kg`;
  return `
    <div class="compare-delta">
      <span class="compare-delta-range">${olderWeight} kg → ${newerWeight} kg</span>
      <span class="measure-delta ${tone}">${deltaLabel}</span>
      <span class="footer-note">${days === 0 ? "isti dan" : `za ${days} ${days === 1 ? "dan" : "dana"}`}</span>
    </div>`;
}

function getPhotosForDate(photos, date) {
  const key = normalizeDateValue(date) || date;
  return photos.filter((photo) => (normalizeDateValue(photo?.date) || photo?.date) === key);
}

// 1 slika / 2-4 slike / 5+ slika — sr množina, da pilula ne zvuči kao prevod.
function getPhotoCountLabel(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} slika`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} slike`;
  }
  return `${count} slika`;
}

// Dana između dva datuma, za natpis ispod poređenja slika.
function getDaysBetweenDates(fromDate, toDate) {
  const from = getDateValueAsLocalDate(normalizeDateValue(fromDate));
  const to = getDateValueAsLocalDate(normalizeDateValue(toDate));
  if (!from || !to) {
    return null;
  }
  return Math.abs(Math.round((to - from) / 86400000));
}

function getProgressSummary(history, photos) {
  const latestMeasurement = history[0] || null;
  const latestPhoto = photos[0] || null;
  const compareReadyTags = PHOTO_TAGS.filter((tag) => photos.filter((photo) => photo.tag === tag).length >= 2);

  return {
    measurementCount: history.length,
    photoCount: photos.length,
    latestMeasurement,
    latestPhoto,
    compareReadyTags,
  };
}

// Brand-new account: instead of four cards of prose (Uvidi, glance grid, tip,
// Dnevnik) one section says what to do first.
function renderProgressEmptyState() {
  return `
    <section class="section progress-empty-section">
      ${renderSectionLead("Napredak", "")}
      <div class="empty progress-empty-guide">
        <strong>Još nema merenja.</strong>
        <span>Unesi težinu jednom nedeljno — trend, uvidi i poređenje slika se pojavljuju sami kako se podaci skupljaju.</span>
        <div class="progress-empty-actions">
          <button class="solid-button button-with-icon" type="button" data-action="set-progress-view" data-view="merenja">${renderButtonContent("Unesi prvo merenje", "add")}</button>
          <button class="ghost-button button-with-icon" type="button" data-action="set-progress-view" data-view="slike">${renderButtonContent("Dodaj sliku", "open")}</button>
        </div>
      </div>
    </section>
  `;
}

function renderProgressSummary(summary) {
  return `
    <section class="section progress-overview-section">
      ${renderSectionLead("Napredak na prvi pogled", "")}
      <dl class="glance-list progress-glance">
        <div class="glance-item">
          <dt>Poslednje merenje</dt>
          <dd>${summary.latestMeasurement ? formatDateValueLabel(summary.latestMeasurement.date) || new Date(summary.latestMeasurement.date).toLocaleDateString("sr-RS") : "još nema"}</dd>
        </div>
        <div class="glance-item">
          <dt>Merenja</dt>
          <dd>${summary.measurementCount}</dd>
        </div>
        <div class="glance-item">
          <dt>Progress slike</dt>
          <dd>${summary.photoCount}${summary.latestPhoto ? ` <span class="glance-sub">poslednja ${formatDateValueLabel(summary.latestPhoto.date) || new Date(summary.latestPhoto.date).toLocaleDateString("sr-RS")}</span>` : ""}</dd>
        </div>
        <div class="glance-item">
          <dt>Poređenje</dt>
          <dd>${summary.compareReadyTags.length ? `spremno (${summary.compareReadyTags.join(", ")})` : `<span class="glance-sub">treba još slika sa istim tagom</span>`}</dd>
        </div>
      </dl>
      ${
        getShareProgressData().hasData
          ? `<button class="solid-button secondary-button button-with-icon progress-share-button" type="button" data-action="share-progress">${renderButtonContent("Podeli napredak", "share")}</button>`
          : ""
      }
      ${
        !summary.measurementCount && !summary.photoCount
          ? `
            <div class="empty progress-empty-guide">
              <strong>Kreni od jednostavnog ritma.</strong>
              <span>Unesi težinu i stomak jednom nedeljno, pa dodaj po jednu sliku za front, side i back. Tako će trend i poređenje odmah postati korisni.</span>
            </div>
          `
          : ""
      }
    </section>
  `;
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
        ${latestValue !== null ? `${latestValue}${field.unit ? ` ${field.unit}` : ""}` : "–"}
      </div>
      <div class="stat-card-meta">
        <span class="footer-note">${latest && latestValue !== null ? `Poslednje: ${formatDateValueLabel(latest.date)}` : "Još nema unosa"}</span>
        ${renderMeasurementDelta(delta, field.unit)}
      </div>
    </article>
  `;
}

// Change vs the previous reading as a coloured directional chip. Down reads as
// progress (teal) since the app is deficit/cut-oriented; up is a warm clay.
function renderMeasurementDelta(delta, unit) {
  if (delta === null) {
    return "";
  }
  const suffix = unit ? ` ${unit}` : "";
  if (delta === 0) {
    return `<span class="measure-delta measure-delta--flat">bez promene</span>`;
  }
  const down = delta < 0;
  return `<span class="measure-delta ${down ? "measure-delta--down" : "measure-delta--up"}">
    ${renderTrendArrowIcon(down)}
    ${Math.abs(delta)}${suffix}
  </span>`;
}

// ---- Daily history / dnevnik ----------------------------------------------
// Each day's actual numbers are snapshotted by date so the plan (a weekly
// template) gains a longitudinal record: calendar heatmap, averages, streak.
function recordTodaySnapshot() {
  const date = getTodayDateValue();
  const weekday = getTodayWeekday();
  const entries = getPlanEntriesForDay(weekday, getCurrentWeekTrack());
  // Kafa se pije, ne planira — ulazi u „pojedeno“ u trenutku kad je tapneš, pa
  // dnevnik, prosek i streak vide iste kalorije koje vidi i prsten na „Danas“.
  const eaten = addTotals(getDayTotals(entries.filter((entry) => entry.done)), getCoffeeTotalsForDate(date));
  const mealLabels = [...new Set(entries.map((entry) => entry.mealLabel))];
  const mealsDone = mealLabels.filter((label) => {
    const mealEntries = entries.filter((entry) => entry.mealLabel === label);
    return mealEntries.length > 0 && mealEntries.every((entry) => entry.done);
  }).length;
  store.history = store.history && typeof store.history === "object" ? store.history : {};
  store.history[date] = {
    date,
    kcal: roundValue(eaten.kcal, 0),
    protein: roundValue(eaten.protein, 1),
    carbs: roundValue(eaten.carbs, 1),
    fat: roundValue(eaten.fat, 1),
    calorieGoal: roundValue(store.goals?.calories || 0, 0),
    waterMl: getTodayWaterMl(),
    coffeeCups: getCoffeeCupsForDate(date),
    mealsDone,
    mealsTotal: mealLabels.length,
  };
}

// A history day is "final" when it's in the past with any intake, or it's today
// and every planned meal is checked off (an unplanned day counts as soon as
// something is logged).
function isHistoryDayFinal(day) {
  const snap = day && day.snap;
  if (!snap || !(snap.kcal > 0)) {
    return false;
  }
  if (day.date !== getTodayDateValue()) {
    return true;
  }
  const total = toNumber(snap.mealsTotal);
  return total <= 0 || toNumber(snap.mealsDone) >= total;
}

function getHistoryDays(count) {
  const now = new Date();
  const days = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.push({ date: key, snap: (store.history || {})[key] || null });
  }
  return days;
}

function isHistoryDayOnTarget(snap) {
  if (!snap || !(snap.kcal > 0)) {
    return false;
  }
  const goal = snap.calorieGoal;
  if (goal > 0) {
    return snap.kcal >= goal * 0.8 && snap.kcal <= goal * 1.1;
  }
  return true;
}

function getHistoryStats() {
  // A year back so the streak isn't silently capped at the window size (it used
  // to freeze at "30 dana u nizu" forever); averages still use the last 7 days.
  const days = getHistoryDays(366);
  const avgOver = (windowDays, key) => {
    const xs = windowDays.map((d) => d.snap && d.snap[key]).filter((v) => v > 0);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  };
  const last7 = days.slice(-7);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (isHistoryDayOnTarget(days[i].snap)) {
      streak++;
    } else if (i === days.length - 1) {
      continue; // today still in progress — don't break the streak
    } else {
      break;
    }
  }
  return {
    avgKcal7: avgOver(last7, "kcal"),
    avgProtein7: avgOver(last7, "protein"),
    avgWater7: avgOver(last7, "waterMl"),
    streak,
  };
}

function renderProgressHistorySection() {
  const days = getHistoryDays(35);
  const hasAny = days.some((d) => d.snap && d.snap.kcal > 0);
  if (!hasAny) {
    return `
    <section class="section">
      <div class="section-header">
        <div class="section-copy">
          <h2>Dnevnik ishrane</h2>
          <p>Čekiraj obroke kao pojedene i unesi vodu — ovde se gradi tvoja istorija: kalendar doslednosti, proseci i streak.</p>
        </div>
      </div>
    </section>`;
  }
  const stats = getHistoryStats();
  // Semantic, token-based and theme-aware: a month of "on target" days used to
  // paint a solid block of the brand accent (gold in dark). Status colours say
  // what the day was; the accent stays reserved for active/CTA/progress.
  const toneColor = {
    none: "var(--bar-track)",
    low: "color-mix(in srgb, var(--status-success-text) 26%, transparent)",
    ok: "var(--status-success-text)",
    over: "var(--status-error-text)",
  };
  const cellTone = (snap) => {
    if (!snap || !(snap.kcal > 0)) return "none";
    const goal = snap.calorieGoal;
    if (!goal) return "ok";
    const r = snap.kcal / goal;
    return r > 1.1 ? "over" : r >= 0.8 ? "ok" : "low";
  };
  const cells = days
    .map((d) => {
      const tone = cellTone(d.snap);
      const title = d.snap && d.snap.kcal > 0 ? `${d.date}: ${d.snap.kcal} kcal` : `${d.date}: nema unosa`;
      return `<span class="history-cell" title="${title}" style="background:${toneColor[tone]};"></span>`;
    })
    .join("");
  return `
    <section class="section progress-history-section">
      <div class="section-header">
        <div class="section-copy">
          <h2>Dnevnik ishrane</h2>
          <p>Poslednjih 5 nedelja — zeleno je dan na cilju.</p>
        </div>
        ${stats.streak > 0 ? `<span class="pill strong pill--success">🔥 ${stats.streak} ${stats.streak === 1 ? "dan" : "dana"} u nizu</span>` : ""}
      </div>
      ${
        // These three were a full stat grid, directly under two cards that
        // already showed the same week's average calories and protein. The
        // numbers stay, the third identical-looking grid does not — this card
        // is here for the consistency calendar.
        (() => {
          const parts = [];
          if (stats.avgKcal7) parts.push(`<strong>${stats.avgKcal7}</strong> kcal`);
          if (stats.avgProtein7) parts.push(`<strong>${stats.avgProtein7} g</strong> proteina`);
          if (stats.avgWater7) parts.push(`<strong>${(stats.avgWater7 / 1000).toFixed(1)} L</strong> vode`);
          return parts.length ? `<p class="history-averages">Prosek za 7 dana: ${parts.join(" · ")}</p>` : "";
        })()
      }
      <div class="history-heatmap">
        ${cells}
      </div>
      <div class="meta-row" style="margin-top:10px;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="footer-note">Manje</span>
        <span style="width:14px;height:14px;border-radius:4px;background:${toneColor.low};display:inline-block;"></span>
        <span style="width:14px;height:14px;border-radius:4px;background:${toneColor.ok};display:inline-block;"></span>
        <span class="footer-note">na cilju</span>
        <span style="width:14px;height:14px;border-radius:4px;background:${toneColor.over};display:inline-block;"></span>
        <span class="footer-note">preko</span>
      </div>
    </section>`;
}

function getWeeklyReport() {
  const days = getHistoryDays(14);
  const thisWeek = days.slice(7);
  const lastWeek = days.slice(0, 7);
  const avg = (arr, key) => {
    const xs = arr.filter((d) => key !== "kcal" || isHistoryDayFinal(d)).map((d) => d.snap && d.snap[key]).filter((v) => v > 0);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  };
  const onTarget = (arr) => arr.filter((d) => isHistoryDayFinal(d) && isHistoryDayOnTarget(d.snap)).length;
  const loggedDays = thisWeek.filter((d) => isHistoryDayFinal(d)).length;
  const measurements = [...(store.measurements || [])]
    .filter((m) => toNumber(m.weightKg) > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  let weightDelta = null;
  if (measurements.length >= 2) {
    const recent = measurements[measurements.length - 1];
    const prior = [...measurements].reverse().find((m) => new Date(recent.date) - new Date(m.date) >= 6 * 86400000);
    if (prior) {
      weightDelta = roundValue(toNumber(recent.weightKg) - toNumber(prior.weightKg), 1);
    }
  }
  return {
    avgKcal: avg(thisWeek, "kcal"),
    avgKcalLast: avg(lastWeek, "kcal"),
    avgWater: avg(thisWeek, "waterMl"),
    onTarget: onTarget(thisWeek),
    onTargetLast: onTarget(lastWeek),
    loggedDays,
    weightDelta,
    hasData: loggedDays > 0,
  };
}

function renderWeeklyReportSection() {
  const r = getWeeklyReport();
  if (!r.hasData) {
    return "";
  }
  const verdict =
    r.onTarget >= 5
      ? "Sjajna nedelja 💪 — većinu dana na cilju."
      : r.onTarget >= 3
        ? "Solidna nedelja, samo nastavi."
        : r.loggedDays >= 4
          ? "Unosi su bili redovni — sledeće nedelje fokus na pogađanje cilja."
          : "Čekiraj obroke svaki dan pa ćemo imati precizniji uvid.";
  const onTargetDelta = r.onTarget - r.onTargetLast;
  const kcalDelta = r.avgKcal && r.avgKcalLast ? r.avgKcal - r.avgKcalLast : 0;
  const deltaTag = (value, unit) =>
    value ? `<span class="footer-note">${value > 0 ? "▲" : "▼"} ${Math.abs(value)}${unit} od prošle nedelje</span>` : "";
  return `
    <section class="section weekly-report-section">
      <div class="section-header">
        <div class="section-copy">
          <h2>Nedeljni izveštaj</h2>
          <p>${verdict}</p>
        </div>
      </div>
      <div class="stats-grid stats-grid--glance">
        <article class="stat-card">
          <strong>Dana na cilju</strong>
          <div class="macro-value">${r.onTarget}/7</div>
          ${onTargetDelta ? deltaTag(onTargetDelta, "") : `<div class="footer-note">poslednjih 7 dana</div>`}
        </article>
        <article class="stat-card">
          <strong>Prosek kcal</strong>
          <div class="macro-value">${r.avgKcal || "—"}</div>
          ${kcalDelta ? deltaTag(kcalDelta, "") : `<div class="footer-note">poslednjih 7 dana</div>`}
        </article>
        ${
          r.weightDelta !== null
            ? `<article class="stat-card">
                 <strong>Težina</strong>
                 <div class="macro-value">${r.weightDelta > 0 ? "+" : ""}${r.weightDelta} kg</div>
                 <div class="footer-note">ove nedelje</div>
               </article>`
            : `<article class="stat-card">
                 <strong>Prosek vode</strong>
                 <div class="macro-value">${r.avgWater ? `${(r.avgWater / 1000).toFixed(1)} L` : "—"}</div>
                 <div class="footer-note">poslednjih 7 dana</div>
               </article>`
        }
      </div>
    </section>`;
}

// Photo blobs are read back from IndexedDB after first paint; until previewUrl is
// stitched in, render a neutral placeholder instead of a broken-image icon.
function renderProgressPhotoImg(photo, alt) {
  if (!photo || !photo.previewUrl) {
    return `<div class="photo-loading">Učitavanje…</div>`;
  }
  return `<img src="${escapeHtml(photo.previewUrl)}" alt="${escapeHtml(alt)}" loading="lazy" />`;
}

function getLabStatus(value, low, high) {
  if (low != null && value < low) return "under";
  if (high != null && value > high) return "over";
  if (low != null || high != null) return "ok";
  return "none";
}

function formatLabRange(low, high) {
  if (low != null && high != null) return `opseg ${low}–${high}`;
  if (high != null) return `do ${high}`;
  if (low != null) return `od ${low}`;
  return "";
}

// Group lab entries by marker, each sorted oldest -> newest; most recently
// updated marker first.
function getLabResultsGrouped() {
  const groups = new Map();
  (store.labResults || []).forEach((entry) => {
    const key = String(entry.marker || "").trim();
    if (!key) {
      return;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(entry);
  });
  const out = [];
  groups.forEach((entries, marker) => {
    entries.sort((a, b) => new Date(a.date) - new Date(b.date));
    out.push({ marker, entries });
  });
  out.sort((a, b) => new Date(b.entries[b.entries.length - 1].date) - new Date(a.entries[a.entries.length - 1].date));
  return out;
}

// Tiny inline sparkline of a marker's value history (neutral — up/down isn't
// inherently good or bad for labs).
function renderLabSparkline(entries) {
  if (entries.length < 2) {
    return "";
  }
  const vals = entries.map((entry) => toNumber(entry.value));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const w = 110;
  const h = 30;
  const pad = 3;
  const stepX = (w - pad * 2) / (entries.length - 1);
  const pts = vals.map((v, i) => `${roundValue(pad + i * stepX, 1)},${roundValue(h - pad - ((v - min) / range) * (h - pad * 2), 1)}`);
  const last = pts[pts.length - 1].split(",");
  return `<svg class="lab-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(" ")}" fill="none"></polyline><circle cx="${last[0]}" cy="${last[1]}" r="2.6"></circle></svg>`;
}

function renderLabSection() {
  const groups = getLabResultsGrouped();
  return `
    <section class="section lab-section">
      <div class="section-header">
        <div>
          <h2>Krvna slika</h2>
          <p>Upiši nalaze i prati koliko je bilo pre, koliko je sad.</p>
        </div>
      </div>
      ${renderHelpNote("Izaberi marker (Vitamin D, Glukoza, Holesterol…), upiši vrednost i datum. Za poznate markere dobiješ oznaku „u opsegu / iznad / ispod“ prema orijentacionom referentnom opsegu, a kad imaš više nalaza istog markera — deltu i mini-grafik trenda.")}

      ${(() => {
      const editingLab = getEditingRecord(store.labResults, state.editingLabId);
      return `
      <details class="form-collapse" ${editingLab ? "open" : ""}>
        <summary>
          <span class="form-collapse-title">${editingLab ? "Izmeni nalaz" : "Dodaj nalaz"}</span>
          <span class="form-collapse-icon" aria-hidden="true">+</span>
        </summary>
        <form id="lab-form" class="form-grid split">
          <div class="field">
            <label for="lab-marker">Marker</label>
            <input id="lab-marker" name="marker" list="lab-marker-options" placeholder="npr. Vitamin D" autocomplete="off" value="${escapeHtml(editingLab ? editingLab.marker || "" : "")}" required />
            <datalist id="lab-marker-options">
              ${LAB_MARKERS.map((m) => `<option value="${escapeHtml(m.name)}"></option>`).join("")}
            </datalist>
          </div>
          <div class="field">
            <label for="lab-value">Vrednost</label>
            <input id="lab-value" name="value" type="number" inputmode="decimal" step="0.01" min="0" placeholder="npr. 34" value="${editingLab && editingLab.value != null ? escapeHtml(String(editingLab.value)) : ""}" required />
          </div>
          <div class="field">
            <label for="lab-date">Datum</label>
            <input id="lab-date" name="date" type="date" value="${editingLab ? normalizeDateValue(editingLab.date) : getLocalDateInputValue()}" required />
          </div>
          <div class="meta-row field--full">
            ${editingLab ? `<button class="ghost-button" type="button" data-action="cancel-edit-lab-result">Odustani</button>` : ""}
            <button class="solid-button secondary-button" type="submit">${editingLab ? "Sačuvaj izmenu" : "Sačuvaj nalaz"}</button>
          </div>
        </form>`;
      })()}
        <div class="footer-note lab-disclaimer">Referentni opsezi su orijentacioni (zavise od laboratorije, pola i godina) — nije medicinski savet.</div>
      </details>

      ${
        groups.length
          ? `<div class="lab-list">
              ${groups
                .map((group) => {
                  const latest = group.entries[group.entries.length - 1];
                  const prev = group.entries.length > 1 ? group.entries[group.entries.length - 2] : null;
                  const value = toNumber(latest.value);
                  const status = getLabStatus(value, latest.refLow, latest.refHigh);
                  const statusLabel = status === "ok" ? "u opsegu" : status === "over" ? "iznad" : status === "under" ? "ispod" : "";
                  const rangeText = formatLabRange(latest.refLow, latest.refHigh);
                  let deltaHtml = "";
                  if (prev) {
                    const d = roundValue(value - toNumber(prev.value), 2);
                    deltaHtml =
                      d === 0
                        ? `<span class="lab-delta">bez promene</span>`
                        : `<span class="lab-delta lab-delta--${d > 0 ? "up" : "down"}">${renderTrendArrowIcon(d < 0)} ${Math.abs(d)}</span>`;
                  }
                  const metaText = [rangeText, new Date(latest.date).toLocaleDateString("sr-RS"), group.entries.length > 1 ? `${group.entries.length} nalaza` : ""]
                    .filter(Boolean)
                    .join(" · ");
                  return `
                    <article class="lab-row">
                      <div class="lab-row-main">
                        <div class="lab-row-top">
                          <span class="lab-name">${escapeHtml(group.marker)}</span>
                          ${statusLabel ? `<span class="lab-status lab-status--${status}">${statusLabel}</span>` : ""}
                        </div>
                        <div class="lab-row-value">
                          <strong>${roundValue(value, 2)}</strong>
                          ${latest.unit ? `<span class="lab-unit">${escapeHtml(latest.unit)}</span>` : ""}
                          ${deltaHtml}
                        </div>
                        <div class="lab-row-meta">${metaText}</div>
                      </div>
                      ${renderLabSparkline(group.entries)}
                      ${renderEditRecordButton("edit-lab-result", "data-id", latest.id, `Izmeni poslednji nalaz za ${group.marker}`)}
                      <button class="lab-row-del" type="button" data-action="delete-lab-result" data-id="${latest.id}" aria-label="Obriši poslednji nalaz za ${escapeHtml(group.marker)}">✕</button>
                    </article>
                  `;
                })
                .join("")}
            </div>`
          : `<div class="empty">Još nema nalaza. Dodaj prvi (npr. Vitamin D, Glukoza, Gvožđe) pa prati trend kroz vreme.</div>`
      }
    </section>
  `;
}

// One metric's value history across all analyses, oldest -> newest, skipping
// analyses where that field was left blank.
function getBodyMetricSeries(key) {
  const series = [];
  (store.bodyComposition || []).forEach((entry) => {
    const raw = entry.values ? entry.values[key] : undefined;
    if (raw == null || raw === "") {
      return;
    }
    const value = Number(raw);
    if (!Number.isNaN(value)) {
      series.push({ date: entry.date, value });
    }
  });
  series.sort((a, b) => new Date(a.date) - new Date(b.date));
  return series;
}

// Delta vs the previous analysis, colored by whether the change goes in the
// healthy direction for that metric.
function renderBodyDelta(curr, prev, dir, dec) {
  if (prev == null) {
    return "";
  }
  const d = roundValue(curr - prev, dec === 0 ? 1 : dec);
  if (d === 0) {
    return `<span class="bc-delta">bez promene</span>`;
  }
  let tone = "neutral";
  if (dir !== "neutral") {
    const good = (dir === "down" && d < 0) || (dir === "up" && d > 0);
    tone = good ? "good" : "bad";
  }
  return `<span class="bc-delta bc-delta--${tone}">${renderTrendArrowIcon(d < 0)} ${d > 0 ? `+${d}` : d}</span>`;
}

function renderBodySparkline(values) {
  if (values.length < 2) {
    return "";
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 110;
  const h = 30;
  const pad = 3;
  const stepX = (w - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => `${roundValue(pad + i * stepX, 1)},${roundValue(h - pad - ((v - min) / range) * (h - pad * 2), 1)}`);
  const last = pts[pts.length - 1].split(",");
  return `<svg class="lab-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(" ")}" fill="none"></polyline><circle cx="${last[0]}" cy="${last[1]}" r="2.6"></circle></svg>`;
}

function renderBodyCompositionSection() {
  const entries = store.bodyComposition || [];
  const hasData = entries.length > 0;
  const editingBodyComp = getEditingRecord(entries, state.editingBodyCompId);
  const editingValues = (editingBodyComp && editingBodyComp.values) || {};
  const bodyCompValue = (key) => {
    const raw = editingValues[key];
    return raw === null || raw === undefined || raw === "" ? "" : String(raw);
  };

  const formFields = BODY_METRIC_GROUPS.map(
    (group) => `
      <div class="bc-form-group">
        <h4 class="bc-form-group-title">${group.group}</h4>
        <div class="bc-form-fields">
          ${group.metrics
            .map(
              (m) => `
            <div class="field">
              <label for="bc-${m.key}">${m.label}${m.unit ? ` <span class="bc-field-unit">(${m.unit})</span>` : ""}</label>
              <input id="bc-${m.key}" name="${m.key}" type="number" step="${m.dec === 0 ? "1" : m.dec === 2 ? "0.01" : "0.1"}" min="0" inputmode="decimal" placeholder="—" value="${bodyCompValue(m.key)}" />
            </div>`
            )
            .join("")}
        </div>
      </div>`
  ).join("");

  const trends = BODY_METRIC_GROUPS.map((group) => {
    const withData = group.metrics.filter((m) => getBodyMetricSeries(m.key).length > 0);
    if (!withData.length) {
      return "";
    }
    const rows = withData
      .map((m) => {
        const series = getBodyMetricSeries(m.key);
        const latest = series[series.length - 1];
        const prev = series.length > 1 ? series[series.length - 2] : null;
        const deltaHtml = renderBodyDelta(latest.value, prev ? prev.value : null, m.dir, m.dec);
        const metaText = [new Date(latest.date).toLocaleDateString("sr-RS"), series.length > 1 ? `${series.length} merenja` : ""]
          .filter(Boolean)
          .join(" · ");
        return `
          <article class="lab-row bc-row">
            <div class="lab-row-main">
              <div class="lab-row-top"><span class="lab-name">${m.label}</span></div>
              <div class="lab-row-value">
                <strong>${roundValue(latest.value, m.dec)}</strong>
                ${m.unit ? `<span class="lab-unit">${m.unit}</span>` : ""}
                ${deltaHtml}
              </div>
              <div class="lab-row-meta">${metaText}</div>
            </div>
            ${renderBodySparkline(series.map((s) => s.value))}
          </article>`;
      })
      .join("");
    return `<div class="bc-group"><h3 class="bc-group-title">${group.group}</h3><div class="lab-list">${rows}</div></div>`;
  }).join("");

  const sessions = [...entries].sort((a, b) => new Date(b.date) - new Date(a.date));
  const sessionsDetails = `
    <details class="form-collapse form-collapse--view bc-sessions">
      <summary>
        <span class="form-collapse-title">Sve analize (${entries.length})</span>
        <span class="form-collapse-icon form-collapse-icon--chevron" aria-hidden="true">${renderChevronIcon(false)}</span>
      </summary>
      <div class="bc-session-list">
        ${sessions
          .map((e) => {
            const count = Object.values(e.values || {}).filter((v) => v != null && v !== "").length;
            return `<div class="bc-session-row">
              <span>${new Date(e.date).toLocaleDateString("sr-RS")} · ${count} ${count === 1 ? "vrednost" : "vrednosti"}</span>
              <div class="record-row-actions">
                ${renderEditRecordButton("edit-body-comp", "data-id", e.id, `Izmeni analizu od ${new Date(e.date).toLocaleDateString("sr-RS")}`)}
                <button class="lab-row-del" type="button" data-action="delete-body-comp" data-id="${e.id}" aria-label="Obriši analizu">✕</button>
              </div>
            </div>`;
          })
          .join("")}
      </div>
    </details>`;

  return `
    <section class="section bc-section">
      <div class="section-header">
        <div>
          <h2>Sastav tela</h2>
          <p>Unesi rezultat analize (InBody, Sonka…) i prati kako se menja kroz vreme.</p>
        </div>
      </div>
      ${renderHelpNote("Jedan unos = jedna analiza. Prepiši brojeve sa izveštaja (popuni samo polja koja imaš). Za svaku metriku se pamti trend: poslednja vrednost, promena u odnosu na prošli put i mini-grafik. Boja promene prati zdrav smer — mast/visceralna dole = zeleno, mišić/voda gore = zeleno. Nije medicinski savet.")}

      <details class="form-collapse" ${editingBodyComp ? "open" : ""}>
        <summary>
          <span class="form-collapse-title">${editingBodyComp ? "Izmeni analizu" : "Dodaj analizu"}</span>
          <span class="form-collapse-icon" aria-hidden="true">+</span>
        </summary>
        <form id="body-comp-form" class="bc-form">
          <div class="field bc-date-field">
            <label for="bc-date">Datum analize</label>
            <input id="bc-date" name="date" type="date" value="${editingBodyComp ? normalizeDateValue(editingBodyComp.date) : getLocalDateInputValue()}" required />
          </div>
          ${formFields}
          <div class="meta-row bc-submit-row">
            ${editingBodyComp ? `<button class="ghost-button" type="button" data-action="cancel-edit-body-comp">Odustani</button>` : ""}
            <button class="solid-button secondary-button bc-submit" type="submit">${editingBodyComp ? "Sačuvaj izmenu" : "Sačuvaj analizu"}</button>
          </div>
          <div class="footer-note">Popuni samo polja koja imaš sa izveštaja — ostalo ostavi prazno.${
            editingBodyComp ? " Pri izmeni ispražnjeno polje skida tu vrednost sa analize." : ""
          }</div>
        </form>
      </details>

      ${
        hasData
          ? `<div class="bc-trends">${trends}</div>${sessionsDetails}`
          : `<div class="empty">Još nema analiza. Dodaj prvu pa prati kako se menjaju procenat masti, mišićna masa, visceralna mast i ostalo.</div>`
      }
    </section>
  `;
}

// Collapsed-by-default "how this works" note. Native <details> so it needs no
// state/JS; experienced users never see it, new users get one tap of context.
function renderHelpNote(body, label = "Kako ovo radi?", inline = false) {
  return `
    <details class="help-note ${inline ? "help-note--inline" : ""}">
      <summary><span class="help-note-icon" aria-hidden="true">${renderInfoIcon()}</span> ${label}</summary>
      <div class="help-note-body">${body}</div>
    </details>`;
}

// ---- Uvidi (insights digest) ----------------------------------------------
// Synthesizes the data the app already collects (daily nutrition history,
// weight, body composition, training logs) into a period-based narrative:
// what changed, how consistent you were, and whether intake explains the
// result. Everything is null-guarded so sparse data degrades gracefully.
function getInsights(periodDays) {
  const days = getHistoryDays(periodDays);
  const startDate = getDateValueAsLocalDate(days[0].date);
  const inPeriod = (dateValue) => {
    const d = getDateValueAsLocalDate(dateValue);
    return Boolean(d && startDate && d.getTime() >= startDate.getTime());
  };

  // A day counts once it's final: any past day with intake, or today only when
  // every planned meal is checked — a half-logged today (one breakfast) used to
  // drag the average to 378 kcal/dan and "predict" −2 kg/ned.
  const loggedDays = days.filter((d) => isHistoryDayFinal(d));
  const loggedCount = loggedDays.length;
  const avgOf = (key) => {
    const xs = loggedDays.map((d) => toNumber(d.snap[key])).filter((v) => v > 0);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  };
  const avgKcal = avgOf("kcal");
  const avgProtein = avgOf("protein");
  const avgWater = avgOf("waterMl");
  const kcalOnTarget = loggedDays.filter((d) => isHistoryDayOnTarget(d.snap)).length;
  const kcalOnTargetPct = loggedCount ? Math.round((kcalOnTarget / loggedCount) * 100) : 0;
  const proteinGoal = toNumber(store.goals?.protein);
  const proteinHitPct =
    proteinGoal > 0 && loggedCount
      ? Math.round((loggedDays.filter((d) => toNumber(d.snap.protein) >= proteinGoal * 0.9).length / loggedCount) * 100)
      : null;

  const weights = [...(store.measurements || [])]
    .filter((m) => toNumber(m.weightKg) > 0 && inPeriod(m.date))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  let weightChange = null;
  let weightRate = null;
  if (weights.length >= 2) {
    const first = weights[0];
    const last = weights[weights.length - 1];
    weightChange = roundValue(toNumber(last.weightKg) - toNumber(first.weightKg), 1);
    const weeks = (getDateValueAsLocalDate(last.date).getTime() - getDateValueAsLocalDate(first.date).getTime()) / (7 * DAY_IN_MS);
    weightRate = weeks > 0 ? roundValue(weightChange / weeks, 2) : null;
  }

  const bodyDelta = (key) => {
    const series = getBodyMetricSeries(key).filter((p) => inPeriod(p.date));
    return series.length >= 2 ? roundValue(series[series.length - 1].value - series[0].value, 1) : null;
  };
  const fatChange = bodyDelta("fatPct");
  const muscleChange = bodyDelta("muscleMass");

  const trainingSessions = new Set(
    (store.trainingProgressLogs || []).map((log) => log.date).filter((date) => inPeriod(date))
  ).size;

  // Energy link: average intake vs estimated maintenance → expected weekly
  // rate, then compared to what actually happened on the scale.
  const rec = getGoalRecommendation();
  let energy = null;
  // An energy → weight projection from fewer than five logged days is noise.
  if (rec && avgKcal > 0 && loggedCount >= 5) {
    const dailyDelta = avgKcal - rec.maintenance; // negative = deficit
    energy = {
      maintenance: rec.maintenance,
      avgKcal,
      dailyDelta: roundValue(dailyDelta, 0),
      expectedRate: roundValue((dailyDelta * 7) / KCAL_PER_KG, 2),
      actualRate: weightRate,
    };
  }

  return {
    periodDays,
    loggedCount,
    avgKcal,
    avgProtein,
    avgWater,
    kcalOnTargetPct,
    proteinHitPct,
    weightChange,
    weightRate,
    fatChange,
    muscleChange,
    trainingSessions,
    energy,
    hasAnything: loggedCount > 0 || weightChange != null || fatChange != null || trainingSessions > 0,
  };
}

function renderInsightsSection() {
  const period = [30, 60, 90].includes(state.insightsPeriod) ? state.insightsPeriod : 30;
  const ins = getInsights(period);
  const periodChips = [30, 60, 90]
    .map(
      (p) =>
        `<button type="button" class="chip ${p === period ? "is-active" : ""}" data-action="set-insights-period" data-period="${p}">${p} dana</button>`
    )
    .join("");

  if (!ins.hasAnything) {
    return `
      <section class="section insights-section">
        <div class="section-header">
          <div class="section-copy">
            <h2>Uvidi</h2>
            <p>Čim počneš da čekiraš obroke i unosiš težinu, ovde dobijaš sažetak: napredak, proseci i šta je uticalo na rezultat.</p>
          </div>
        </div>
        <div class="insights-period">${periodChips}</div>
      </section>`;
  }

  let headline = `Pregled za poslednjih ${period} dana.`;
  if (ins.weightChange != null && ins.weightChange !== 0) {
    headline = `Za ${period} dana: <strong>${ins.weightChange < 0 ? "−" : "+"}${Math.abs(ins.weightChange)} kg</strong>${ins.weightRate ? ` (${ins.weightRate < 0 ? "−" : "+"}${Math.abs(ins.weightRate)} kg/ned)` : ""}.`;
  } else if (ins.loggedCount) {
    headline = `Uneto <strong>${ins.loggedCount}</strong> od ${period} dana — nastavi da gradiš istoriju.`;
  }

  const card = (label, value, note) =>
    `<article class="stat-card"><strong>${label}</strong><div class="macro-value">${value}</div><div class="footer-note">${note}</div></article>`;
  const signed = (value) => `${value > 0 ? "+" : ""}${value}`;
  const cards = [];
  if (ins.weightChange != null) cards.push(card("Težina", `${signed(ins.weightChange)} kg`, ins.weightRate ? `${signed(ins.weightRate)} kg/ned` : "u periodu"));
  if (ins.fatChange != null) cards.push(card("Mast", `${signed(ins.fatChange)} %`, "telesna mast"));
  if (ins.muscleChange != null) cards.push(card("Mišić", `${signed(ins.muscleChange)} kg`, "mišićna masa"));
  if (ins.avgKcal) cards.push(card("Kalorije", `${ins.avgKcal}`, `prosek/dan · cilj ${ins.kcalOnTargetPct}% dana`));
  if (ins.avgProtein) cards.push(card("Protein", `${ins.avgProtein} g`, ins.proteinHitPct != null ? `cilj ${roundValue(toNumber(store.goals?.protein), 0)} g · ${ins.proteinHitPct}% dana` : "prosek/dan"));
  if (ins.trainingSessions) cards.push(card("Trening", `${ins.trainingSessions}`, "zabeleženih"));
  if (ins.avgWater) cards.push(card("Voda", `${(ins.avgWater / 1000).toFixed(1)} L`, "prosek/dan"));

  let energyHtml = "";
  if (ins.energy) {
    const e = ins.energy;
    const deficitWord =
      e.dailyDelta < 0 ? `deficit ~${Math.abs(e.dailyDelta)} kcal/dan` : e.dailyDelta > 0 ? `višak ~${e.dailyDelta} kcal/dan` : "na održavanju";
    let verdict = "";
    if (e.actualRate != null && e.expectedRate) {
      const sameDirection = e.actualRate <= 0 === e.expectedRate <= 0;
      if (!sameDirection) {
        verdict = " Težina ide suprotno od onoga što unos predviđa — proveri unos ili merenja.";
      } else if (Math.abs(e.actualRate - e.expectedRate) < 0.15) {
        verdict = " Rezultat se poklapa sa unosom 👍";
      } else if (Math.abs(e.actualRate) > Math.abs(e.expectedRate)) {
        verdict = " Menjaš se brže nego što kalorije predviđaju (voda/glikogen ili je održavanje precenjeno).";
      } else {
        verdict = " Sporije nego što unos predviđa (možda je unos potcenjen ili održavanje niže).";
      }
    }
    energyHtml = `
      <div class="insights-callout">
        <strong>Energija</strong>
        <p>Prosečno unosiš <strong>${e.avgKcal} kcal/dan</strong>, procena održavanja je <strong>${e.maintenance} kcal</strong> → ${deficitWord}, što predviđa <strong>${e.expectedRate} kg/ned</strong>.${e.actualRate != null ? ` Stvarno: <strong>${e.actualRate} kg/ned</strong>.` : ""}${verdict}</p>
      </div>`;
  }

  return `
    <section class="section insights-section">
      <div class="section-header">
        <div class="section-copy">
          <h2>Uvidi</h2>
          <p class="insights-headline">${headline}</p>
        </div>
      </div>
      ${renderHelpNote("Sažetak tvojih podataka za izabrani period (30/60/90 dana). Kartice pokazuju promenu težine, masti i mišića, prosečne kalorije i koliko dana si pogodio cilj. „Energija“ uparuje tvoj prosečan unos sa procenom održavanja i pokazuje da li težina stvarno prati ono što kalorije predviđaju.")}
      <div class="insights-period">${periodChips}</div>
      <div class="stats-grid stats-grid--glance insights-grid">${cards.join("")}</div>
      ${energyHtml}
    </section>`;
}

// ---- Share progress card --------------------------------------------------
// Composites a clean before/after image (photos when available + key numbers)
// onto a canvas, then shares it via the Web Share API or downloads a PNG.
function getShareProgressData() {
  const weights = [...(store.measurements || [])]
    .filter((m) => toNumber(m.weightKg) > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  let weight = null;
  if (weights.length >= 2) {
    const f = weights[0];
    const l = weights[weights.length - 1];
    weight = { from: toNumber(f.weightKg), to: toNumber(l.weightKg), delta: roundValue(toNumber(l.weightKg) - toNumber(f.weightKg), 1), fromDate: f.date, toDate: l.date };
  }
  const fatSeries = getBodyMetricSeries("fatPct");
  const fat = fatSeries.length >= 2 ? { delta: roundValue(fatSeries[fatSeries.length - 1].value - fatSeries[0].value, 1) } : null;

  const photos = [...store.progressPhotos].sort((a, b) => new Date(a.date) - new Date(b.date));
  let pair = null;
  for (const tag of PHOTO_TAGS) {
    const tagged = photos.filter((p) => p.tag === tag && p.previewUrl);
    if (tagged.length >= 2) {
      pair = { before: tagged[0], after: tagged[tagged.length - 1] };
      break;
    }
  }

  let period = null;
  const start = (weight && weight.fromDate) || (pair && pair.before.date);
  const end = (weight && weight.toDate) || (pair && pair.after.date);
  if (start && end) {
    const days = Math.round((getDateValueAsLocalDate(end).getTime() - getDateValueAsLocalDate(start).getTime()) / DAY_IN_MS);
    period = { days, weeks: Math.max(1, Math.round(days / 7)) };
  }
  return { weight, fat, pair, period, hasData: Boolean(weight || fat || pair) };
}

function loadShareImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawCoverImage(ctx, img, x, y, w, h, r) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.clip();
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

async function buildShareCardCanvas(data) {
  const W = 1080;
  const H = 1350;
  const pad = 72;
  const cream = "#f4efe3";
  const ink = "#1b2a20";
  const green = "#2f6e4e";
  const goodGreen = "#2f8f5b";
  const muted = "#7a847b";
  const panel = "#eaf1e8";

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = cream;
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = green;
  ctx.font = "700 26px -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText("FIT TRACKER", pad, 104);
  ctx.fillStyle = ink;
  ctx.font = "700 66px Georgia, 'Times New Roman', serif";
  ctx.fillText("Moj napredak", pad, 176);
  if (data.period) {
    const w = data.period.weeks;
    const mod10 = w % 10;
    const mod100 = w % 100;
    const weeksWord = mod10 === 1 && mod100 !== 11 ? "nedelju" : mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14) ? "nedelje" : "nedelja";
    ctx.fillStyle = muted;
    ctx.font = "400 30px -apple-system, 'Segoe UI', Roboto, sans-serif";
    ctx.fillText(`za ${w} ${weeksWord}`, pad, 224);
  }

  let cursorY = 270;

  // Before/after photos
  if (data.pair) {
    const [beforeImg, afterImg] = await Promise.all([loadShareImage(data.pair.before.previewUrl), loadShareImage(data.pair.after.previewUrl)]);
    const gap = 32;
    const boxW = (W - pad * 2 - gap) / 2;
    const boxH = 620;
    const cols = [
      { img: beforeImg, label: "PRE", date: data.pair.before.date, x: pad },
      { img: afterImg, label: "SAD", date: data.pair.after.date, x: pad + boxW + gap },
    ];
    cols.forEach((col) => {
      if (col.img) {
        drawCoverImage(ctx, col.img, col.x, cursorY, boxW, boxH, 28);
      } else {
        ctx.fillStyle = panel;
        roundRectPath(ctx, col.x, cursorY, boxW, boxH, 28);
        ctx.fill();
      }
      // label chip
      ctx.fillStyle = green;
      roundRectPath(ctx, col.x + 20, cursorY + 20, col.label === "PRE" ? 96 : 104, 48, 24);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 26px -apple-system, 'Segoe UI', Roboto, sans-serif";
      ctx.fillText(col.label, col.x + 40, cursorY + 53);
      // date under
      ctx.fillStyle = muted;
      ctx.font = "400 26px -apple-system, 'Segoe UI', Roboto, sans-serif";
      ctx.fillText(new Date(col.date).toLocaleDateString("sr-RS"), col.x + 4, cursorY + boxH + 40);
    });
    cursorY += boxH + 80;
  } else {
    cursorY += 30;
  }

  // Stat tiles
  const tiles = [];
  if (data.weight) tiles.push({ value: `${data.weight.delta > 0 ? "+" : "−"}${Math.abs(data.weight.delta)} kg`, label: "težina", good: data.weight.delta < 0 });
  if (data.fat) tiles.push({ value: `${data.fat.delta > 0 ? "+" : "−"}${Math.abs(data.fat.delta)} %`, label: "telesna mast", good: data.fat.delta < 0 });
  if (data.weight) tiles.push({ value: `${data.weight.to}`, label: "kg sada", good: null });
  const shown = tiles.slice(0, 3);
  if (shown.length) {
    const gap = 28;
    const tileW = (W - pad * 2 - gap * (shown.length - 1)) / shown.length;
    const tileH = 200;
    shown.forEach((tile, i) => {
      const x = pad + i * (tileW + gap);
      ctx.fillStyle = panel;
      roundRectPath(ctx, x, cursorY, tileW, tileH, 26);
      ctx.fill();
      ctx.fillStyle = tile.good === true ? goodGreen : ink;
      ctx.font = "700 58px -apple-system, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(tile.value, x + tileW / 2, cursorY + 110);
      ctx.fillStyle = muted;
      ctx.font = "400 30px -apple-system, 'Segoe UI', Roboto, sans-serif";
      ctx.fillText(tile.label, x + tileW / 2, cursorY + 158);
      ctx.textAlign = "left";
    });
  }

  // Footer wordmark
  ctx.fillStyle = green;
  ctx.font = "700 34px Georgia, serif";
  ctx.fillText("Fit Tracker", pad, H - 64);
  ctx.fillStyle = muted;
  ctx.font = "400 26px -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("tvoj plan ishrane i treninga", W - pad, H - 64);
  ctx.textAlign = "left";

  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

async function shareProgressCard() {
  const data = getShareProgressData();
  if (!data.hasData) {
    showFeedbackToast({ title: "Nema šta da se podeli još", detail: "Unesi bar dva merenja težine ili dve slike pa probaj.", tone: "warning" });
    return;
  }
  try {
    const canvas = await buildShareCardCanvas(data);
    const blob = await canvasToBlob(canvas);
    if (!blob) {
      throw new Error("blob");
    }
    const file = new File([blob], "fit-tracker-napredak.png", { type: "image/png" });
    if (typeof navigator !== "undefined" && navigator.canShare && navigator.canShare({ files: [file] }) && typeof navigator.share === "function") {
      try {
        await navigator.share({ files: [file], title: "Moj napredak", text: "Moj napredak — Fit Tracker" });
      } catch (error) {
        if (error && error.name === "AbortError") {
          return;
        }
        throw error;
      }
      return;
    }
    // Fallback: download the PNG.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fit-tracker-napredak.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showFeedbackToast({ title: "Slika je sačuvana", detail: "Deljenje nije podržano na ovom uređaju, pa je slika preuzeta.", tone: "success" });
  } catch (error) {
    console.error("Share progress failed", error);
    showFeedbackToast({ title: "Pravljenje slike nije uspelo", detail: "Pokušaj ponovo.", tone: "error" });
  }
}

function renderProgressTab() {
  const history = [...store.measurements].sort((a, b) => new Date(b.date) - new Date(a.date));
  const chartFields = measurementFields.filter((field) =>
    ["weightKg", "upperWaistCm", "lowerWaistCm"].includes(field.id)
  );
  const photos = [...store.progressPhotos].sort((a, b) => new Date(b.date) - new Date(a.date));
  const summary = getProgressSummary(history, photos);
  const activeCompareTag = getActiveCompareTag(photos);
  const taggedPhotos = photos.filter((photo) => photo.tag === activeCompareTag);
  const compare = getPhotoComparePair(taggedPhotos);

  const view = ["pregled", "merenja", "zdravlje", "slike"].includes(state.progressView) ? state.progressView : "pregled";
  const segNav = `<div class="seg-nav">${[["pregled", "Pregled"], ["merenja", "Merenja"], ["zdravlje", "Zdravlje"], ["slike", "Slike"]]
    .map(([id, label]) => `<button type="button" class="seg-nav-btn ${id === view ? "is-active" : ""}" data-action="set-progress-view" data-view="${id}">${label}</button>`)
    .join("")}</div>`;

  return `
    ${segNav}

    ${view === "pregled" ? (
      !summary.measurementCount && !summary.photoCount && !getInsights(30).hasAnything
        ? renderProgressEmptyState()
        : `
    ${renderInsightsSection()}

    ${renderProgressSummary(summary)}

    ${renderWeeklyReportSection()}

    ${renderProgressHistorySection()}
    `
    ) : ""}

    ${view === "merenja" ? `
    ${(() => {
      const editing = getEditingRecord(store.measurements, state.editingMeasurementId);
      const formDate = editing ? normalizeDateValue(editing.date) : getLocalDateInputValue();
      const fieldValue = (fieldId) => {
        const raw = editing ? editing[fieldId] : null;
        return raw === null || raw === undefined || raw === "" ? "" : String(raw);
      };
      return `
    <details class="section form-collapse" ${editing ? "open" : ""}>
      <summary>
        <span class="form-collapse-title">${editing ? "Izmeni merenje" : "Dodaj merenje"}</span>
        <span class="form-collapse-icon" aria-hidden="true">+</span>
      </summary>
      <form id="measurement-form" class="form-grid split">
        <div class="field">
          <label for="measurement-date">Datum</label>
          <input id="measurement-date" name="date" type="date" value="${formDate}" required />
        </div>
        ${renderUnitField(
          "measurement-weightKg",
          "Težina",
          "kg",
          `<input id="measurement-weightKg" name="weightKg" type="number" step="0.1" min="0" value="${fieldValue("weightKg")}" required />`
        )}
        <div class="field field--full measurement-goal-note" id="measurement-calorie-goal">
          ${renderMeasurementGoalNote(formDate)}
        </div>
        <div class="field field--full measurement-photo-field">
          <label>Slike (opciono)</label>
          <div class="measurement-photo-row">
            ${PHOTO_TAGS.map(
              (tag) => `
                <div class="measurement-photo-slot">
                  <label for="measurement-photo-${tag}">${PHOTO_TAG_LABELS[tag]}</label>
                  <input id="measurement-photo-${tag}" name="photo-${tag}" type="file" accept="image/*" />
                </div>
              `
            ).join("")}
          </div>
          <div class="footer-note">Slike dobijaju datum merenja, pa u tabu „Slike“ stoje u istom redu sa težinom tog dana. Čuvaju se <strong>samo na ovom uređaju</strong> — za prenos na drugi telefon izvezi backup (Ciljevi → Izvezi backup).${
            editing
              ? " Postojeće slike se izmenom ne diraju: vezane su za datum, pa ako promeniš datum ostaju na starom."
              : ""
          }</div>
        </div>
        <details class="field field--full measurement-extra">
          <summary>
            <span class="measurement-extra-title">Dodatne mere (opciono)</span>
            <span class="measurement-extra-icon" aria-hidden="true">${renderChevronIcon(false)}</span>
          </summary>
          <div class="form-grid split">
            ${measurementFields
              .filter((field) => optionalMeasurementFieldIds.includes(field.id))
              .map(
                (field) => `
                  ${renderUnitField(
                    `measurement-${field.id}`,
                    field.label,
                    field.unit || "",
                    `<input
                      id="measurement-${field.id}"
                      name="${field.id}"
                      type="${field.type}"
                      ${field.step ? `step="${field.step}"` : ""}
                      ${field.type === "number" ? 'min="0"' : ""}
                      placeholder="${field.placeholder || ""}"
                      value="${fieldValue(field.id)}"
                    />`
                  )}
                `
              )
              .join("")}
          </div>
        </details>
        <div class="meta-row field--full">
          ${editing ? `<button class="ghost-button" type="button" data-action="cancel-edit-measurement">Odustani</button>` : ""}
          <button class="solid-button" type="submit">${editing ? "Sačuvaj izmenu" : "Sačuvaj unos"}</button>
        </div>
      </form>
    </details>`;
    })()}

    <section class="section">
      <div class="section-header">
        <div>
          <h2>Ostale mere</h2>
        </div>
      </div>
      <div class="stats-grid stats-grid--glance">
        ${measurementFields
          .filter((field) => !["weightKg", "upperWaistCm", "lowerWaistCm"].includes(field.id))
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
      ${renderHelpNote("Puna linija je stvarna težina. <strong>Isprekidana</strong> je tempo — gde bi trebalo da budeš pri zadatom tempu (npr. −0,5 kg/ned), računato od prvog merenja; oznaka kaže koliko si „ispred/iza plana“. <strong>Tačkasta</strong> linija je tvoja ciljna težina (postavljaš je u Ciljevima), a ispod grafika piše procena kad ćeš je dostići. Pojavljuje se kad popuniš profil i imaš bar dva merenja.")}
      <div class="chart-grid">
        ${chartFields.map((field) => renderTrendCard(field)).join("")}
      </div>
    </section>
    ` : ""}

    ${view === "zdravlje" ? `
    ${renderLabSection()}

    ${renderBodyCompositionSection()}
    ` : ""}

    ${view === "slike" ? `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Progress slike</h2>
          <p>Ubaci sliku sa telefona i ostavi kratku napomenu tipa front, side ili back.</p>
        </div>
      </div>
      <details class="form-collapse">
        <summary>
          <span class="form-collapse-title">Dodaj sliku</span>
          <span class="form-collapse-icon" aria-hidden="true">+</span>
        </summary>
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
          <div class="footer-note">Slika se smanjuje i čuva <strong>samo na ovom uređaju</strong> (sada u trajnijem skladištu, bez ograničenja kao ranije) — ne ide u cloud i ne sinhronizuje se na druge uređaje. Da je preneseš na drugi telefon ili sačuvaš za svaki slučaj, izvezi backup (Ciljevi → Izvezi backup) — slike su uključene u njega.</div>
        </div>
        <button class="solid-button secondary-button" type="submit">Dodaj sliku</button>
      </form>
      </details>
      <div class="compare-block progress-compare-block">
        <div class="section-header">
          <div>
            <h2>Uporedo</h2>
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
                            ${escapeHtml(getPhotoLabel(photo))}
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
                            ${escapeHtml(getPhotoLabel(photo))}
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
                      ${[compare.leftPhoto, compare.rightPhoto]
                        .map((photo, index) => {
                          const weight = getMeasurementWeightForDate(photo.date);
                          return `
                            <article class="photo-card compare-card">
                              ${renderProgressPhotoImg(photo, `${index === 0 ? "Leva" : "Desna"} progress slika ${photo.date}`)}
                              <div class="photo-card-body">
                                <strong>${new Date(photo.date).toLocaleDateString("sr-RS")}</strong>
                                <div class="pill-row">
                                  <span class="pill strong">${escapeHtml(getPhotoTagLabel(photo.tag))}</span>
                                  ${weight !== null ? `<span class="pill note">${weight} kg</span>` : ""}
                                </div>
                                ${photo.note ? `<div class="footer-note">${escapeHtml(photo.note)}</div>` : ""}
                              </div>
                            </article>
                          `;
                        })
                        .join("")}
                    </div>
                    ${renderCompareDelta(compare.leftPhoto, compare.rightPhoto)}
                  `
                  : `<div class="empty">Za tag "${escapeHtml(activeCompareTag)}" dodaj bar dve slike ili izaberi druge dve razlicite slike.</div>`
              }
            `
            : `<div class="empty">Dodaj bar dve slike da bi radio side by side prikaz.</div>`
        }
      </div>
      <div class="photo-session-list">
        ${
          photos.length
            ? groupPhotosByDate(photos)
                .map((session) => {
                  const weight = getMeasurementWeightForDate(session.date);
                  return `
                    <article class="photo-session">
                      <div class="food-card-top">
                        <strong>${formatDateValueLabel(session.date) || new Date(session.date).toLocaleDateString("sr-RS")}</strong>
                        ${weight !== null ? `<span class="pill note strong">${weight} kg</span>` : ""}
                      </div>
                      <div class="photo-session-row">
                        ${session.photos
                          .map(
                            (photo) => `
                              <figure class="photo-session-item">
                                ${renderProgressPhotoImg(photo, `Progress slika ${photo.date} (${getPhotoTagLabel(photo.tag)})`)}
                                <figcaption>
                                  <span class="pill strong">${escapeHtml(getPhotoTagLabel(photo.tag))}</span>
                                  <button class="danger-button" data-action="delete-photo" data-photo-id="${photo.id}">Obriši</button>
                                </figcaption>
                                ${photo.note ? `<div class="footer-note">${escapeHtml(photo.note)}</div>` : ""}
                              </figure>
                            `
                          )
                          .join("")}
                      </div>
                    </article>
                  `;
                })
                .join("")
            : `<div class="empty">Još nema progress slika. Ubaci prvu da imaš vizuelni trag napretka.</div>`
        }
      </div>
    </section>
    ` : ""}

    ${view === "merenja" ? `
    <details class="section form-collapse form-collapse--view">
      <summary>
        <span class="form-collapse-title">Istorija unosa</span>
        <span class="form-collapse-icon form-collapse-icon--chevron" aria-hidden="true">${renderChevronIcon(false)}</span>
      </summary>
      <div class="stack">
        ${
          history.length
            ? history
                .map(
                  (entry) => {
                    const entryPhotos = getPhotosForDate(photos, entry.date);
                    return `
                    <article class="food-card">
                      <div class="food-card-top">
                        <h3>${new Date(entry.date).toLocaleDateString("sr-RS")}</h3>
                        <div class="record-row-actions">
                          ${renderEditRecordButton("edit-measurement", "data-measurement-id", entry.id, `Izmeni merenje od ${new Date(entry.date).toLocaleDateString("sr-RS")}`)}
                          <button class="danger-button" data-action="delete-measurement" data-measurement-id="${entry.id}">
                            Obriši
                          </button>
                        </div>
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
                        ${getMeasurementCaloriePill(entry)}
                        ${entryPhotos.length ? `<span class="pill">${getPhotoCountLabel(entryPhotos.length)}</span>` : ""}
                      </div>
                      ${
                        entryPhotos.length
                          ? `<div class="measurement-thumbs">${entryPhotos
                              .map(
                                (photo) => `
                                  <figure class="measurement-thumb">
                                    ${renderProgressPhotoImg(photo, `Progress slika ${photo.date} (${getPhotoTagLabel(photo.tag)})`)}
                                    <figcaption>${escapeHtml(getPhotoTagLabel(photo.tag))}</figcaption>
                                  </figure>
                                `
                              )
                              .join("")}</div>`
                          : ""
                      }
                    </article>
                  `;
                  }
                )
                .join("")
            : `<div class="empty">Dodaj prvo merenje pa će ovde ostati istorija.</div>`
        }
      </div>
    </details>
    ` : ""}
  `;
}

// Count the calorie-ring number up from 0 to its value on tab entry — a
// premium hero moment that pairs with the ring fill. One-shot, self-cancels
// if a re-render replaces the element, and respects reduced-motion.
function animateRingCountUp() {
  const el = document.querySelector(".cal-ring-value");
  if (!el) {
    return;
  }
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const target = parseInt(String(el.textContent).replace(/\D/g, ""), 10);
  if (!Number.isFinite(target) || target <= 0) {
    return;
  }
  const duration = 750;
  let startTs = null;
  const step = (ts) => {
    if (!el.isConnected) {
      return;
    }
    if (startTs === null) {
      startTs = ts;
    }
    const progress = Math.min((ts - startTs) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = String(Math.round(target * eased));
    if (progress < 1) {
      window.requestAnimationFrame(step);
    } else {
      el.textContent = String(target);
    }
  };
  window.requestAnimationFrame(step);
}

// Count the daily-overview macro numbers up from 0 too, in step with the ring.
function animateMacroCountUps() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  document.querySelectorAll(".plan-summary-layout .macro-value").forEach((el) => {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) {
      return;
    }
    const raw = String(node.textContent).trim();
    const target = parseFloat(raw);
    if (!Number.isFinite(target) || target <= 0) {
      return;
    }
    const decimals = raw.includes(".") ? (raw.split(".")[1] || "").length : 0;
    const duration = 750;
    let startTs = null;
    const step = (ts) => {
      if (!node.isConnected) {
        return;
      }
      if (startTs === null) {
        startTs = ts;
      }
      const progress = Math.min((ts - startTs) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      node.textContent = (target * eased).toFixed(decimals);
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        node.textContent = decimals ? target.toFixed(decimals) : String(target);
      }
    };
    window.requestAnimationFrame(step);
  });
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

  if (shouldShowOnboarding()) {
    document.body.classList.remove("plan-compact");
    state.navMenuOpen = false;
    if (!state.onboarding) {
      state.onboarding = {
        sex: store.profile.sex || "",
        age: store.profile.age || "",
        heightCm: store.profile.heightCm || "",
        weightKg: store.profile.weightKg || "",
        activityLevel: store.profile.activityLevel || "moderate",
        targetMode: store.goals.targetMode || "lose",
        paceLevel: store.goals.paceLevel || "umereno",
      };
    }
    syncBodyScrollLock();
    document.querySelector("#app").innerHTML = renderOnboarding();
    return;
  }

  const entries = getPlanEntriesForDay(state.selectedWeekday, state.selectedWeekTrack);
  const totals = getDayTotals(entries);
  const heroMarkup = state.activeTab === "plan" ? renderHero(entries, totals) : "";
  // Plan and Foods bring their own compact in-tab header, so skip the global
  // workspace hero for them (the floating menu-fab provides the nav menu).
  const workspaceHeaderMarkup = state.activeTab === "plan" ? "" : renderWorkspaceHeader();
  const groupSegNavMarkup = renderGroupSegNav();
  // Only the active tab is ever inserted into the DOM, so build just that one
  // instead of rebuilding all 8 sections (charts, food lists, etc.) on every
  // tap/keystroke. The render*Tab fns are pure (no state side effects).
  const sectionRenderers = {
    plan: () => renderPlanTab(entries),
    recipes: renderRecipesTab,
    nutrition: renderNutritionTab,
    foods: renderFoodsTab,
    training: renderTrainingTab,
    running: renderRunningTab,
    routine: renderRoutineTab,
    progress: renderProgressTab,
    goals: renderGoalsTab,
  };
  const activeSection = (sectionRenderers[state.activeTab] || sectionRenderers.plan)();

  // Snapshot scroll + focused field before we blow away and rebuild the DOM,
  // so a toggle/keystroke doesn't bounce the user to the top or drop the field.
  const preservedScrollY = window.scrollY;
  const activeEl = document.activeElement;
  let preservedFocus = null;
  if (activeEl && activeEl.id && activeEl !== document.body) {
    let selStart = null;
    let selEnd = null;
    try {
      if (typeof activeEl.selectionStart === "number") {
        selStart = activeEl.selectionStart;
        selEnd = activeEl.selectionEnd;
      }
    } catch (error) {
      /* number/email inputs throw on selectionStart access — ignore */
    }
    preservedFocus = { id: activeEl.id, start: selStart, end: selEnd };
  }

  document.querySelector("#app").innerHTML = `
    <div class="app-frame app-frame--${state.activeTab} ${state.sidebarCollapsed ? "is-sidebar-collapsed" : ""}">
      <button class="menu-fab" type="button" data-action="toggle-nav-menu" aria-expanded="${state.navMenuOpen}" aria-controls="app-menu" aria-label="Otvori meni">
        <span class="menu-fab-icon" aria-hidden="true">${renderMenuToggleIcon(state.navMenuOpen)}</span>
        <span class="menu-fab-label">Meni</span>
      </button>

      ${state.activeTab === "foods" ? renderFoodsAddFab() : ""}

      ${renderTabBar()}
      ${renderMoreSheet()}

      ${state.navMenuOpen ? '<button class="menu-overlay" type="button" data-action="close-nav-menu" aria-label="Zatvori meni"></button>' : ""}

      <aside id="app-menu" class="mobile-menu app-sidebar ${state.navMenuOpen ? "is-open" : ""} ${state.sidebarCollapsed ? "is-collapsed" : ""}" aria-label="Glavna navigacija">
        <div class="mobile-menu-top">
          <div class="app-sidebar-brand">
            <div class="hero-picker-label">Navigacija</div>
            <strong>Fit Tracker</strong>
          </div>
          <div class="app-sidebar-top-actions">
            <button class="ghost-button sidebar-toggle" type="button" data-action="toggle-sidebar-collapse" aria-label="${state.sidebarCollapsed ? "Raširi navigaciju" : "Skupi navigaciju"}" aria-pressed="${state.sidebarCollapsed}">
              ${state.sidebarCollapsed ? renderSideChevronIcon(false) : renderSideChevronIcon(true)}
            </button>
            <button class="ghost-button menu-close" type="button" data-action="close-nav-menu" aria-label="Zatvori meni">
              ${renderMenuToggleIcon(true)}
            </button>
          </div>
        </div>
        <div class="mobile-menu-list">
          ${NAV_GROUPS.map(
            (group) => `
              <button class="menu-tab-button ${group.tabs.includes(state.activeTab) ? "is-active" : ""}" data-action="switch-tab" data-tab="${getGroupTargetTab(group)}" title="${group.label}" aria-label="${group.label}">
                <span class="icon">${renderTabIcon(group.icon)}</span>
                <span class="menu-tab-label">${group.label}</span>
              </button>
            `
          ).join("")}
        </div>
        <div class="mobile-menu-footer">
          ${(() => {
            const email = String(state.authUser?.email || "").trim();
            if (!email) {
              return "";
            }
            const demo = isDemoAccount();
            const name = demo ? "Demo nalog" : String(store.profile?.name || "").trim() || email.split("@")[0];
            const initial = (name || email).charAt(0).toUpperCase();
            return `
              <button class="app-sidebar-account ${state.activeTab === "goals" && state.goalsView === "nalog" ? "is-active" : ""}" type="button" data-action="open-account" aria-label="Nalog i podešavanja · ${escapeHtml(state.syncStatus)}" title="Nalog · ${escapeHtml(state.syncStatus)}">
                <span class="app-sidebar-account-avatar" aria-hidden="true">${escapeHtml(initial)}<span class="app-sidebar-account-dot is-${getSyncStatusTone()}"></span></span>
                <span class="app-sidebar-account-copy">
                  <span class="app-sidebar-account-name">${escapeHtml(name)}${demo ? `<span class="more-sheet-user-badge">DEMO</span>` : ""}</span>
                  <span class="app-sidebar-account-email">${escapeHtml(email)}</span>
                </span>
                <span class="app-sidebar-account-chevron" aria-hidden="true">${renderSideChevronIcon(false)}</span>
              </button>`;
          })()}
          <button class="ghost-button theme-toggle button-with-icon" type="button" data-action="toggle-theme" aria-label="Promeni temu">
            <span class="theme-toggle-face to-dark">
              <svg class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
              <span class="button-label">Tamna tema</span>
            </span>
            <span class="theme-toggle-face to-light">
              <svg class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
              <span class="button-label">Svetla tema</span>
            </span>
          </button>
        </div>
      </aside>

      <main class="shell shell-with-menu app-main ${state.activeTab === "plan" ? "is-plan-shell" : ""} ${state.activeTab === "foods" ? "is-foods-shell" : ""} ${state.tabEnter ? "is-entering" : ""}">
        ${workspaceHeaderMarkup}
        ${groupSegNavMarkup}
        ${heroMarkup}
        ${activeSection}
      </main>

      ${
        state.pendingUndo
          ? `
            <div class="undo-banner" role="status" aria-live="polite">
              <div>
                <strong>${escapeHtml(state.pendingUndo.message)}</strong>
                <div class="footer-note" style="margin-top:4px;">Jedan tap da poništiš.</div>
              </div>
              <div class="undo-banner-actions">
                ${
                  state.pendingUndo.extra
                    ? `<button class="solid-button button-with-icon" data-action="${state.pendingUndo.extra.action}" data-meal-label="${escapeHtml(state.pendingUndo.extra.mealLabel || "")}" data-weekday="${escapeHtml(state.pendingUndo.extra.weekday || "")}">${renderButtonContent(state.pendingUndo.extra.label, state.pendingUndo.extra.icon || "apply")}</button>`
                    : ""
                }
                <button class="ghost-button button-with-icon" data-action="undo-pending">${renderButtonContent("Vrati", "undo")}</button>
              </div>
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
                <div class="footer-note" style="margin-top:4px;">Osveži app da povučeš poslednje izmene.</div>
              </div>
              <button class="solid-button secondary-button button-with-icon" data-action="apply-app-update">${renderButtonContent("Osveži", "refresh")}</button>
            </div>
          `
          : ""
      }

      ${
        !state.isOnline
          ? `
            <div class="offline-banner" role="status" aria-live="polite">
              <span class="offline-banner-dot" aria-hidden="true"></span>
              <div>
                <strong>Nema interneta</strong>
                <div class="footer-note" style="margin-top:2px;">Radiš normalno — sve se čuva na uređaju i sinhronizuje čim se vratiš online.</div>
              </div>
            </div>
          `
          : ""
      }

      ${
        state.syncConflict
          ? `
            <div class="sync-conflict-banner" role="alertdialog" aria-live="assertive" aria-label="Konflikt sinhronizacije">
              <div class="sync-conflict-copy">
                <strong>Podaci su izmenjeni na drugom uređaju.</strong>
                <div class="footer-note" style="margin-top:4px;">Da ne pregazimo ništa slučajno — koju verziju da zadržim? Tvoje lokalne izmene su sačuvane dok ne izabereš.</div>
              </div>
              <div class="sync-conflict-actions">
                <button class="solid-button secondary-button button-with-icon" data-action="resolve-sync-conflict" data-mode="keep-local">${renderButtonContent("Zadrži moje", "save")}</button>
                <button class="ghost-button button-with-icon" data-action="resolve-sync-conflict" data-mode="use-cloud">${renderButtonContent("Učitaj sa drugog uređaja", "refresh")}</button>
              </div>
            </div>
          `
          : ""
      }

      ${renderRecipeApplyDialog()}
      ${renderFoodEditorDialog()}
      ${renderQuickEntryDialog()}
      ${renderBarcodeScanner()}
    </div>
  `;

  // The entrance stagger is a one-shot: consume the flag so routine
  // re-renders (toggles, typing) don't replay the animation. It ships in
  // the initial HTML (no flash), then the class is stripped once the
  // animation is done so its `fill: both` stops pinning `transform`
  // (which would otherwise block the scroll-to-hide header).
  const didEnter = state.tabEnter;
  state.tabEnter = false;
  if (didEnter) {
    window.setTimeout(() => {
      document.querySelector(".app-main.is-entering")?.classList.remove("is-entering");
    }, 850);
    window.requestAnimationFrame(animateRingCountUp);
    window.requestAnimationFrame(animateMacroCountUps);
  }

  // Put the user back where they were (before the scroll-dependent syncs below
  // run). On a tab switch start at the top of the new tab; otherwise restore the
  // prior scroll position and re-focus the field they were in, so typing or
  // toggling a checkbox doesn't bounce to the top or drop focus.
  if (didEnter) {
    window.scrollTo(0, 0);
    // A new tab starts at the top — drop the scroll-driven header states left
    // over from the previous tab, otherwise the hidden (translated) header keeps
    // a blank header-sized gap above the content until the next scroll event.
    state.isPlanHeroCompact = false;
    document.body.classList.remove("plan-compact", "app-header-hidden");
    lastHeaderScrollY = 0;
  } else {
    if (preservedFocus) {
      const focusEl = document.getElementById(preservedFocus.id);
      if (focusEl) {
        focusEl.focus({ preventScroll: true });
        if (preservedFocus.start != null && typeof focusEl.setSelectionRange === "function") {
          try {
            focusEl.setSelectionRange(preservedFocus.start, preservedFocus.end);
          } catch (error) {
            /* some input types don't support setSelectionRange — ignore */
          }
        }
      }
    }
    window.scrollTo(0, preservedScrollY);
  }

  syncBodyScrollLock();
  updateHeroScrollState();
  syncRequiredLabelMarkers();
  syncValidationState();
  syncEntryPreview();
  if (state.activeTab === "foods" && state.foodSearch) {
    filterFoodsListInline(state.foodSearch);
    updateExternalFoodResults(state.foodSearch);
  }
  if (state.activeTab === "recipes" && state.recipeSearch) {
    filterRecipeCardsInline(state.recipeSearch);
  }
  paintRestTimers();
  syncDialogFocus();
  // The "just added" highlight is one-shot — consume it so it doesn't replay
  // on the next routine re-render.
  state.lastAddedEntryId = "";
}

async function exportData() {
  // Photo blobs live in IndexedDB. Pull any that aren't currently stitched into
  // memory so the backup always carries full images, never just metadata.
  const snapshot = getSerializableStoreSnapshot();
  const idbMap = await idbAllPhotos();
  if (idbMap && Array.isArray(snapshot.progressPhotos)) {
    snapshot.progressPhotos = snapshot.progressPhotos.map((photo) =>
      photo && !photo.previewUrl && idbMap.has(photo.id)
        ? { ...photo, previewUrl: idbMap.get(photo.id) }
        : photo
    );
  }
  if (idbMap && Array.isArray(snapshot.favoriteMeals)) {
    snapshot.favoriteMeals = snapshot.favoriteMeals.map((favorite) =>
      favorite && !favorite.imageUrl && idbMap.has(getRecipeImageKey(favorite.id))
        ? { ...favorite, imageUrl: idbMap.get(getRecipeImageKey(favorite.id)) }
        : favorite
    );
  }
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fit-tracker-backup-${getLocalDateInputValue()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function getLabelControl(label) {
  if (!(label instanceof HTMLLabelElement)) {
    return null;
  }

  const forId = String(label.getAttribute("for") || "").trim();
  if (forId) {
    return document.getElementById(forId);
  }

  const nestedControl = label.querySelector("input, select, textarea");
  if (nestedControl) {
    return nestedControl;
  }

  return label.closest(".field")?.querySelector("input, select, textarea") || null;
}

function syncRequiredLabelMarkers(root = document) {
  root.querySelectorAll("label").forEach((label) => {
    const control = getLabelControl(label);
    const isRequired = Boolean(control?.required);
    label.classList.toggle("required-label", isRequired);
    if (isRequired) {
      label.setAttribute("data-required-marker", "*");
    } else {
      label.removeAttribute("data-required-marker");
    }
  });
}

function updateValidationState(control, { reveal = false } = {}) {
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) {
    return;
  }

  const field = control.closest(".field");
  const wrapperLabel = control.closest("label");
  const shouldReveal = reveal || control.dataset.touched === "true" || control.form?.dataset.validationShown === "true";
  // Use the validity property (pure read) — NOT checkValidity(), which fires an
  // `invalid` event. Our `invalid` listener calls back into this function, so
  // checkValidity() here would recurse infinitely on an empty required field.
  const isInvalid = shouldReveal && !control.validity.valid;

  control.classList.toggle("is-invalid", isInvalid);
  field?.classList.toggle("is-invalid", isInvalid);
  if (wrapperLabel && !field) {
    wrapperLabel.classList.toggle("is-invalid", isInvalid);
  }
}

function syncValidationState(root = document, options = {}) {
  root.querySelectorAll("input, select, textarea").forEach((control) => updateValidationState(control, options));
}

function handleInvalidField(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
    return;
  }

  if (target.form) {
    target.form.dataset.validationShown = "true";
  }
  target.dataset.touched = "true";
  updateValidationState(target, { reveal: true });
}

function handleValidationInteraction(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
    return;
  }

  target.dataset.touched = "true";
  updateValidationState(target, { reveal: true });
}

function syncEntryPreview() {
  const foodIdInput = document.querySelector("#foodId");
  const gramsInput = document.querySelector("#grams");
  const preview = document.querySelector("#entry-preview");

  if (!foodIdInput || !gramsInput || !preview) {
    return;
  }

  const food = getFoodById(foodIdInput.value);
  const grams = toNumber(gramsInput.value);
  preview.innerHTML = renderEntryPreviewInner(food, grams);
}

async function handleDocumentClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    // The whole meal header is the disclosure, not just the chevron.
    const header = event.target instanceof Element ? event.target.closest(".meal-card-header") : null;
    const card = header?.closest(".meal-card");
    const toggle = card?.querySelector(".meal-collapse-toggle");
    if (header && card && toggle instanceof HTMLElement && !card.classList.contains("is-editing") && !event.target.closest("button, input, label, a")) {
      toggle.click();
    }
    return;
  }

  const action = actionTarget.dataset.action;

  if (action === "switch-tab") {
    const nextTab = actionTarget.dataset.tab;
    if (nextTab !== state.activeTab) {
      state.tabEnter = true;
    }
    state.activeTab = nextTab;
    state.lastTabInGroup = state.lastTabInGroup || {};
    state.lastTabInGroup[getNavGroupForTab(nextTab).id] = nextTab;
    state.editingMealLabel = "";
    state.navMenuOpen = false;
    // Reset transient Namirnice UI so returning to it always starts clean —
    // otherwise a stale search re-applies on render and shows the empty state.
    state.foodSearch = "";
    state.foodMenuOpenId = "";
    state.foodFiltersOpen = false;
    resetFoodEditing();
    resetRoutineEditing();
    if (state.activeTab === "foods") {
      schedulePreloadBarcodeReader();
    }
    // Otvaranje Trčanja je tap (user gesture) — pokušaj tihog uvoza iz clipboard-a
    // ako je dozvola već data; inače korisnik koristi dugme „Popuni sa sata”.
    if (state.activeTab === "running") {
      maybeAutoImportRunFromClipboard();
    }
    window.location.hash = state.activeTab;
    render();
    window.requestAnimationFrame(() => scrollPageTop("auto"));
    return;
  }

  if (action === "open-account") {
    if (state.activeTab !== "goals") {
      state.tabEnter = true;
    }
    state.activeTab = "goals";
    state.goalsView = "nalog";
    state.navMenuOpen = false;
    window.location.hash = "goals";
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

  if (action === "toggle-sidebar-collapse") {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    render();
    return;
  }

  if (action === "toggle-plan-quick") {
    state.planQuickExpanded = !state.planQuickExpanded;
    render();
    return;
  }

  if (action === "toggle-recipes-builder") {
    state.recipesBuilderExpanded = !state.recipesBuilderExpanded;
    render();
    return;
  }

  if (action === "toggle-plan-summary") {
    state.planSummaryExpanded = !state.planSummaryExpanded;
    render();
    return;
  }

  if (action === "toggle-plan-supplements") {
    state.planSupplementsExpanded = !state.planSupplementsExpanded;
    render();
    return;
  }

  if (action === "close-nav-menu") {
    state.navMenuOpen = false;
    render();
    return;
  }

  if (action === "resolve-sync-conflict") {
    const mode = String(actionTarget.dataset.mode || "");
    state.syncConflict = null;
    if (mode === "use-cloud") {
      // Discard local pending edits and reload the other device's version.
      if (state.authUser) {
        writeSyncMeta(state.authUser.uid, { dirty: false });
        await hydrateStoreFromCloud(state.authUser);
        await reconcilePhotos();
      }
      render();
    } else if (mode === "keep-local") {
      // Overwrite the cloud with this device's version (bypasses the rev check).
      const saved = await saveCloudStateNow({ force: true, overwrite: true });
      showFeedbackToast(
        saved
          ? { title: "Sačuvano", detail: "Tvoja verzija je upisana u cloud.", tone: "success" }
          : { title: "Nije sačuvano", detail: "Pokušaj ponovo za koji trenutak.", tone: "error" }
      );
      render();
    }
    return;
  }

  if (action === "apply-app-update") {
    const waiting = serviceWorkerRegistration?.waiting;
    if (!waiting) {
      reloadForUpdate();
      return;
    }
    showFeedbackToast({ title: "Ažuriram…", detail: "Učitavam novu verziju.", tone: "info", duration: 4000 });
    // Reload as soon as the new worker takes over. iOS standalone PWAs don't
    // always fire controllerchange, so we also watch the worker's own state
    // and keep a hard fallback so the app never just hangs.
    waiting.addEventListener("statechange", () => {
      if (waiting.state === "activated") {
        reloadForUpdate();
      }
    });
    waiting.postMessage({ type: "SKIP_WAITING" });
    window.setTimeout(reloadForUpdate, 2500);
    return;
  }

  if (action === "force-refresh") {
    state.navMenuOpen = false;
    showFeedbackToast({
      title: "Osvežavam…",
      detail: "Povlačim najnoviju verziju aplikacije.",
      tone: "info",
      duration: 4000,
    });
    (async () => {
      try {
        if (serviceWorkerRegistration) {
          await serviceWorkerRegistration.update().catch(() => {});
          // A newer version is already installed and waiting — activate it.
          // The controllerchange listener then reloads into the new version.
          if (serviceWorkerRegistration.waiting) {
            serviceWorkerRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
            return;
          }
        }
        // No new worker, but the cached assets may be stale. Drop the cache so
        // the reload re-fetches the latest files from the network. Skip this
        // when offline so we don't wipe the only working copy.
        if (navigator.onLine !== false && window.caches?.keys) {
          const keys = await caches.keys();
          await Promise.all(keys.map((key) => caches.delete(key)));
        }
      } catch (error) {
        // Ignore — fall through to a plain reload.
      }
      window.location.reload();
    })();
    return;
  }

  if (action === "set-onboarding-sex") {
    if (state.onboarding) {
      state.onboarding.sex = actionTarget.dataset.sex || "";
      render();
    }
    return;
  }

  if (action === "set-onboarding-mode") {
    if (state.onboarding) {
      state.onboarding.targetMode = actionTarget.dataset.mode || "lose";
      render();
    }
    return;
  }

  if (action === "set-onboarding-activity") {
    if (state.onboarding) {
      state.onboarding.activityLevel = actionTarget.dataset.activity || "moderate";
      render();
    }
    return;
  }

  if (action === "set-onboarding-pace") {
    if (state.onboarding) {
      state.onboarding.paceLevel = actionTarget.dataset.pace || "umereno";
      render();
    }
    return;
  }

  if (action === "set-insights-period") {
    const period = parseInt(actionTarget.dataset.period, 10);
    if ([30, 60, 90].includes(period)) {
      state.insightsPeriod = period;
      render();
    }
    return;
  }

  if (action === "set-progress-view") {
    const view = actionTarget.dataset.view;
    if (["pregled", "merenja", "zdravlje", "slike"].includes(view)) {
      state.progressView = view;
      render();
    }
    return;
  }

  if (action === "set-goals-view") {
    const view = actionTarget.dataset.view;
    if (["cilj", "nedeljno", "nalog"].includes(view)) {
      state.goalsView = view;
      render();
    }
    return;
  }

  if (action === "skip-onboarding") {
    store.onboarded = true;
    state.onboarding = null;
    persist();
    render();
    return;
  }

  if (action === "finish-onboarding") {
    const ob = state.onboarding || {};
    const profile = {
      ...store.profile,
      sex: ob.sex || "",
      age: toNumber(ob.age),
      heightCm: toNumber(ob.heightCm),
      weightKg: toNumber(ob.weightKg),
      activityLevel: ob.activityLevel || "moderate",
    };
    const rec = getGoalRecommendation(profile, { targetMode: ob.targetMode || "lose", paceLevel: ob.paceLevel || "umereno" });
    store.profile = profile;
    store.goals.targetMode = ob.targetMode || "lose";
    store.goals.paceLevel = ob.paceLevel || "umereno";
    if (rec) {
      store.goals.calories = rec.targetCalories;
      store.goals.protein = rec.protein;
      store.goals.carbs = rec.carbs;
      store.goals.fat = rec.fat;
      store.goals.basisWeightKg = toNumber(profile.weightKg) || null;
    }
    store.goals.waterMl = suggestWaterMl(profile.weightKg);
    store.onboarded = true;
    state.onboarding = null;
    state.activeTab = "plan";
    state.tabEnter = true;
    persist();
    render();
    showFeedbackToast({
      title: "Spremno! 🎉",
      detail: rec ? `Dnevni cilj: ${rec.targetCalories} kcal. Dodaj prvi obrok.` : "Cilj možeš da postaviš u tabu Ciljevi.",
      tone: "success",
      duration: 3600,
    });
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

  if (action === "select-week-track") {
    state.selectedWeekTrack = normalizeWeekTrack(actionTarget.dataset.weekTrack);
    state.editingMealLabel = "";
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

  if (action === "toggle-food-filters") {
    state.foodFiltersOpen = !state.foodFiltersOpen;
    render();
    return;
  }

  if (action === "toggle-food-menu") {
    const id = String(actionTarget.dataset.foodId || "");
    state.foodMenuOpenId = state.foodMenuOpenId === id ? "" : id;
    render();
    return;
  }

  if (action === "set-recipe-meal-filter") {
    state.recipeMealFilter = actionTarget.dataset.filter || "Sve";
    render();
    return;
  }

  if (action === "set-recipe-nutrition-filter") {
    state.recipeNutritionFilter = actionTarget.dataset.filter || "Sve";
    render();
    return;
  }

  if (action === "clear-favorite-image") {
    state.favoriteDraft.imageUrl = "";
    const imageInput = document.querySelector("#favorite-image");
    if (imageInput instanceof HTMLInputElement) {
      imageInput.value = "";
    }
    render();
    return;
  }

  if (action === "set-food-nutrition-filter") {
    state.foodNutritionFilter = actionTarget.dataset.filter || "Sve";
    render();
    return;
  }

  if (action === "set-food-catalog-view") {
    state.foodCatalogView = actionTarget.dataset.view === "thumbnails" ? "thumbnails" : "list";
    render();
    return;
  }

  if (action === "open-food-editor-dialog") {
    rememberDialogTrigger(actionTarget);
    openFoodEditorDialog("");
    render();
    return;
  }

  if (action === "close-food-editor-dialog") {
    closeFoodEditorDialog();
    render();
    restoreFocusAfterDialog();
    return;
  }

  if (action === "open-scanner") {
    state.scannerReturnTo = String(actionTarget.dataset.scanReturn || "");
    state.scannerOpen = true;
    state.scannerStatus = "Tražim kameru…";
    render();
    window.requestAnimationFrame(() => {
      startBarcodeScan();
    });
    return;
  }

  if (action === "close-scanner") {
    stopBarcodeScan();
    state.scannerOpen = false;
    state.scannerReturnTo = "";
    render();
    return;
  }

  if (action === "scan-manual") {
    stopBarcodeScan();
    state.scannerOpen = false;
    openFoodEditorDialog("");
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#food-name")?.focus();
    });
    return;
  }

  // No render() in these two — the live camera stream is attached directly
  // to the #barcode-video element, and a re-render would recreate it (and
  // drop the feed) since ZXing owns that element outside the state model.
  if (action === "focus-scanner") {
    focusScannerAt(actionTarget, event.clientX, event.clientY);
    return;
  }

  if (action === "toggle-scanner-torch") {
    const track = getScannerVideoTrack();
    if (!track) {
      return;
    }
    const next = !state.scannerTorchOn;
    track
      .applyConstraints({ advanced: [{ torch: next }] })
      .then(() => {
        state.scannerTorchOn = next;
        actionTarget.classList.toggle("is-active", next);
      })
      .catch((error) => console.warn("Torch toggle failed", error));
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

    // Snapshot before the reset: a long streak is the single most painful
    // thing to lose here, and it was the one destructive action with no way back.
    const previousStreak = {
      bestStreakDays: habit.bestStreakDays,
      resetCount: habit.resetCount,
      lastResetAt: habit.lastResetAt,
      streakStartDate: habit.streakStartDate,
      updatedAt: habit.updatedAt,
    };
    habit.bestStreakDays = Math.max(Math.max(0, toNumber(habit.bestStreakDays)), currentStreakDays);
    habit.resetCount = Math.max(0, toNumber(habit.resetCount)) + 1;
    habit.lastResetAt = getTodayDateValue();
    habit.streakStartDate = getTodayDateValue();
    habit.updatedAt = new Date().toISOString();
    persist();
    queuePendingUndo(`Streak za „${habit.name}" je resetovan.`, () => {
      const target = store.habits.find((entry) => entry.id === habit.id);
      if (target) {
        Object.assign(target, previousStreak);
        persist();
      }
    });
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
    const habitId = actionTarget.dataset.habitId;
    const prevHabits = store.habits;
    if (!prevHabits.some((entry) => entry.id === habitId)) {
      return;
    }
    store.habits = store.habits.filter((entry) => entry.id !== habitId);
    if (state.editingHabitId === habitId) {
      state.editingHabitId = "";
    }
    persist();
    queuePendingUndo("Navika obrisana.", () => {
      store.habits = prevHabits;
      persist();
    });
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

  if (action === "toggle-training-template-done") {
    const template = getTrainingForDay(state.selectedWeekday).find((item) => item.id === actionTarget.dataset.templateId);
    if (template) {
      const completion = getTrainingTemplateCompletionCount(template, state.selectedWeekday);
      const nextDone = completion.completedCount !== completion.totalCount;
      setTrainingTemplateCompletion(state.selectedWeekday, template, nextDone);
      announce(
        nextDone
          ? `Trening „${template.name}“ je označen kao odrađen.`
          : `Trening „${template.name}“ više nije označen kao odrađen.`
      );
      render();
    }
    return;
  }

  if (action === "toggle-rest-timer") {
    const key = actionTarget.dataset.restKey || "";
    if (restTimer && restTimer.key === key) {
      stopRestTimer();
    } else {
      startRestTimer(key);
    }
    return;
  }

  if (action === "toggle-training-exercise") {
    const templateId = String(actionTarget.dataset.templateId || "").trim();
    const exerciseId = String(actionTarget.dataset.exerciseId || "").trim();
    if (!templateId || !exerciseId) {
      return;
    }

    toggleTrainingExerciseCompletion(state.selectedWeekday, templateId, exerciseId);
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

    const prevTasks = store.dayTasks;
    store.dayTasks = store.dayTasks.filter((entry) => entry.id !== actionTarget.dataset.taskId);
    if (state.editingTaskId === actionTarget.dataset.taskId) {
      state.editingTaskId = "";
    }
    persist();
    queuePendingUndo("Task obrisan.", () => {
      store.dayTasks = prevTasks;
      persist();
    });
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

    const prevSupplements = store.supplements;
    store.supplements = store.supplements.filter((entry) => entry.id !== actionTarget.dataset.supplementId);
    if (state.editingSupplementId === actionTarget.dataset.supplementId) {
      state.editingSupplementId = "";
    }
    persist();
    queuePendingUndo("Suplement obrisan.", () => {
      store.supplements = prevSupplements;
      persist();
    });
    render();
    return;
  }

  if (action === "clear-completed-tasks") {
    const hasCompleted = store.dayTasks.some(
      (task) => task.weekday === state.selectedWeekday && normalizeWeekTrack(task.weekTrack) === state.selectedWeekTrack && task.done
    );
    if (!hasCompleted) {
      return;
    }
    const confirmed = window.confirm(`Obriši sve završene taskove za ${weekdayAccusative(state.selectedWeekday)}?`);
    if (!confirmed) {
      return;
    }
    const prevDayTasks = store.dayTasks;
    store.dayTasks = store.dayTasks.filter(
      (task) => !(task.weekday === state.selectedWeekday && normalizeWeekTrack(task.weekTrack) === state.selectedWeekTrack && task.done)
    );
    const removedCount = prevDayTasks.length - store.dayTasks.length;
    if (state.editingTaskId && !store.dayTasks.some((task) => task.id === state.editingTaskId)) {
      state.editingTaskId = "";
    }
    persist();
    queuePendingUndo(
      `Obrisano ${removedCount} ${srPlural(removedCount, "završen task", "završena taska", "završenih taskova")}.`,
      () => {
        store.dayTasks = prevDayTasks;
        persist();
      }
    );
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
        weekTrack: state.selectedWeekTrack,
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
      const confirmed = window.confirm(`Da li želiš da zameniš ceo ${weekdayLabel(state.selectedWeekday)} dnevnim planom "${plan.title}"?`);
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
          ? `${result.appliedCount} ${srPlural(result.appliedCount, "stavka", "stavke", "stavki")} je ubačeno u ${weekdayLabel(state.selectedWeekday)}, a ${result.skippedMeals} obroka je ostalo samo kao hint jer nema dovoljno podataka za automatsko prebacivanje.`
          : `${result.appliedCount} ${srPlural(result.appliedCount, "stavka", "stavke", "stavki")} je ubačeno u ${weekdayLabel(state.selectedWeekday)}.`,
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
    openFoodEditorDialog(foodId);
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#food-name")?.focus();
    });
    return;
  }

  if (action === "cancel-edit-food") {
    closeFoodEditorDialog();
    render();
    return;
  }

  if (action === "delete-food") {
    const foodId = String(actionTarget.dataset.foodId || "").trim();
    const food = foodId ? getFoodById(foodId) : null;
    if (!food) {
      return;
    }

    // Deleting a food cascades (plan entries, recipe items, favorite refs), so
    // snapshot the affected collections for a clean one-tap undo.
    const undoSnapshot = {
      foods: JSON.parse(JSON.stringify(store.foods)),
      weeklyPlanEntries: JSON.parse(JSON.stringify(store.weeklyPlanEntries)),
      favoriteMeals: JSON.parse(JSON.stringify(store.favoriteMeals)),
      favoriteFoods: JSON.parse(JSON.stringify(store.favoriteFoods)),
    };

    const result = deleteFoodFromCollections(store, foodId);
    hideCatalogFood(foodId);
    if (state.editingFoodId === foodId) {
      resetFoodEditing();
    }
    state.foodSearch = state.foodSearch && normalizeLookupValue(food.name).includes(normalizeLookupValue(state.foodSearch)) ? "" : state.foodSearch;
    persist();

    const detailParts = [];
    if (result.removedPlanEntries) {
      detailParts.push(`${result.removedPlanEntries} iz plana`);
    }
    if (result.removedRecipeItems) {
      detailParts.push(`${result.removedRecipeItems} iz recepata`);
    }
    if (result.removedRecipes) {
      detailParts.push(`${result.removedRecipes} praznih recepata`);
    }
    const cascadeNote = detailParts.length ? ` (uklonjeno i ${detailParts.join(", ")})` : "";

    queuePendingUndo(`Namirnica obrisana${cascadeNote}.`, () => {
      store.foods = undoSnapshot.foods;
      store.weeklyPlanEntries = undoSnapshot.weeklyPlanEntries;
      store.favoriteMeals = undoSnapshot.favoriteMeals;
      store.favoriteFoods = undoSnapshot.favoriteFoods;
      persist();
    });
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

  if (action === "prefill-exercise-progress") {
    state.trainingProgressPrefill = String(actionTarget.dataset.exerciseName || "").trim();
    state.trainingProgressOpen = true;
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#training-progress-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#progress-weight")?.focus();
    });
    return;
  }

  if (action === "start-add-to-meal") {
    const mealLabel = String(actionTarget.dataset.mealLabel || "").trim();
    if (isMealCompletedForWeekday(state.selectedWeekday, mealLabel)) {
      return;
    }
    schedulePreloadBarcodeReader();
    resetPlanDraft();
    state.editingMealLabel = mealLabel || "";
    state.prepMealLabel = "";
    expandMealForWeekday(state.selectedWeekday, mealLabel);
    state.planDraft.mealLabel = mealLabel || defaultMeals[0];
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#plan-entry-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#food-search-input")?.focus();
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
    state.prepMealLabel = "";
    expandMealForWeekday(state.selectedWeekday, mealLabel);
    state.planDraft.mealLabel = mealLabel || defaultMeals[0];
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#plan-entry-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#food-search-input")?.focus();
    });
    return;
  }

  if (action === "finish-edit-meal") {
    state.editingMealLabel = "";
    resetPlanDraft();
    render();
    return;
  }

  if (action === "open-meal-prep") {
    const mealLabel = String(actionTarget.dataset.mealLabel || "").trim();
    if (!mealLabel) {
      return;
    }
    if (isMealCompletedForWeekday(state.selectedWeekday, mealLabel)) {
      showFeedbackToast({ title: "Obrok je zaključan", detail: "Skini čekiranje pa onda pripremaj unapred.", tone: "warning" });
      return;
    }
    // Toggle the panel; each open starts in the quick "next N days" mode.
    state.prepMealLabel = state.prepMealLabel === mealLabel ? "" : mealLabel;
    state.prepMode = "next";
    state.prepDays = 2;
    state.prepPickDays = [];
    state.editingMealLabel = "";
    render();
    // If we just opened it, scroll the panel into view (matches add/edit-meal),
    // so it never opens off-screen below the fold on a phone.
    if (state.prepMealLabel === mealLabel) {
      window.requestAnimationFrame(() => {
        document.querySelector(".meal-prep-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    return;
  }

  if (action === "close-meal-prep") {
    state.prepMealLabel = "";
    render();
    return;
  }

  if (action === "set-meal-prep-days") {
    state.prepMode = "next";
    state.prepDays = Math.max(2, roundValue(toNumber(actionTarget.dataset.days) || 2, 0));
    render();
    return;
  }

  if (action === "set-meal-prep-mode") {
    state.prepMode = String(actionTarget.dataset.mode || "next") === "pick" ? "pick" : "next";
    if (state.prepMode === "pick") {
      state.prepPickDays = [];
    }
    render();
    return;
  }

  if (action === "toggle-meal-prep-day") {
    const weekday = String(actionTarget.dataset.weekday || "").trim();
    const weekTrack = normalizeWeekTrack(actionTarget.dataset.weekTrack);
    if (!weekday || !WEEKDAYS.includes(weekday) || (weekday === state.selectedWeekday && weekTrack === state.selectedWeekTrack)) {
      return;
    }
    state.prepMode = "pick";
    const picked = state.prepPickDays || [];
    const exists = picked.some((pick) => pick.weekday === weekday && pick.weekTrack === weekTrack);
    state.prepPickDays = exists
      ? picked.filter((pick) => !(pick.weekday === weekday && pick.weekTrack === weekTrack))
      : [...picked, { weekday, weekTrack }];
    render();
    return;
  }

  if (action === "confirm-meal-prep") {
    const mealLabel = String(actionTarget.dataset.mealLabel || "").trim();
    if (!mealLabel) {
      return;
    }
    const plan = getMealPrepPlan(mealLabel);
    if (!plan.sourceEntries.length || !plan.targetDays.length) {
      return;
    }
    const normalizedMealLabel = normalizeMealLabel(mealLabel);
    const appliedDays = [];
    const lockedDays = [];
    plan.targetDays.forEach((day) => {
      // Don't overwrite a meal the user already ticked off as eaten.
      if (isMealCompletedForWeekday(day.weekday, normalizedMealLabel, day.weekTrack)) {
        lockedDays.push(day);
        return;
      }
      store.weeklyPlanEntries = store.weeklyPlanEntries.filter(
        (entry) =>
          !(
            entry.weekday === day.weekday &&
            normalizeWeekTrack(entry.weekTrack) === day.weekTrack &&
            normalizeMealLabel(entry.mealLabel) === normalizedMealLabel
          )
      );
      plan.sourceEntries.forEach((entry) => {
        store.weeklyPlanEntries.push({
          id: uid("plan"),
          weekday: day.weekday,
          weekTrack: day.weekTrack,
          mealLabel: normalizedMealLabel,
          foodId: entry.foodId,
          foodName: entry.foodName,
          grams: entry.grams,
          done: false,
        });
      });
      appliedDays.push(day);
    });

    state.prepMealLabel = "";

    if (!appliedDays.length) {
      showFeedbackToast({
        title: "Ništa nije prebačeno",
        detail: "Izabrani dani su već zaključani (čekirani).",
        tone: "warning",
      });
      render();
      return;
    }

    persist();
    const allApplied = appliedDays.length === plan.targetDays.length;
    const cookList = allApplied
      ? plan.cookItems.map((item) => `${item.name} ${formatShoppingAmount(item.unit, item.totalGrams)}`).join(", ")
      : "";
    const detail = `${
      cookList ? `Skuvaj: ${cookList}.` : `Prekopirano na: ${appliedDays.map((day) => formatWeekTrackDayLabel(day, plan.sourceWeekTrack)).join(", ")}.`
    }${lockedDays.length ? ` ${lockedDays.length} zaključanih dana preskočeno.` : ""}`;
    showFeedbackToast({ title: `Pripremljeno za ${appliedDays.length + 1} dana`, detail, tone: "success" });
    render();
    return;
  }

  if (action === "edit-entry") {
    const entryId = actionTarget.dataset.entryId;
    const entry = getPlanEntriesForDay(state.selectedWeekday, state.selectedWeekTrack).find((item) => item.id === entryId);
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

  if (action === "dismiss-reminders") {
    store.ui = store.ui || {};
    store.ui.plan = store.ui.plan || {};
    store.ui.plan.remindersDismissedDate = getTodayDateValue();
    if (!(store.measurements || []).length) {
      // The "first measurement" nag came back every single day; a dismissal
      // means "not now" — give it a week before asking again.
      const snooze = new Date();
      snooze.setDate(snooze.getDate() + 7);
      store.ui.plan.measurementNagSnoozedUntil = getLocalDateInputValue(snooze);
    }
    persist();
    render();
    return;
  }

  if (action === "toggle-plan-shopping") {
    state.shoppingExpanded = !state.shoppingExpanded;
    render();
    return;
  }

  if (action === "toggle-shopping-item") {
    const id = String(actionTarget.dataset.foodId || "");
    if (!id) {
      return;
    }
    store.shoppingChecked = store.shoppingChecked || {};
    if (store.shoppingChecked[id]) {
      delete store.shoppingChecked[id];
    } else {
      store.shoppingChecked[id] = true;
    }
    persist();
    render();
    return;
  }

  if (action === "mark-shopping-staple" || action === "unmark-shopping-staple") {
    const id = String(actionTarget.dataset.foodId || "");
    if (!id) {
      return;
    }
    store.shoppingStaples = store.shoppingStaples || {};
    if (action === "mark-shopping-staple") {
      store.shoppingStaples[id] = true;
    } else {
      delete store.shoppingStaples[id];
    }
    persist();
    render();
    return;
  }

  if (action === "clear-shopping-checks") {
    store.shoppingChecked = {};
    persist();
    render();
    return;
  }

  if (action === "copy-shopping-list") {
    const text = buildShoppingListText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => showFeedbackToast({ title: "Lista je kopirana", detail: "Nalepi je gde želiš.", tone: "success" }))
        .catch(() => showFeedbackToast({ title: "Kopiranje nije uspelo", detail: "Pokušaj ručno.", tone: "error" }));
    } else {
      showFeedbackToast({ title: "Kopiranje nije podržano", detail: "Browser ne dozvoljava automatsko kopiranje.", tone: "error" });
    }
    return;
  }

  if (action === "share-shopping-list") {
    const text = buildShoppingListText();
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      navigator
        .share({ title: "Lista za kupovinu", text })
        .catch((error) => {
          // AbortError = user dismissed the share sheet; not worth a toast.
          if (error && error.name !== "AbortError") {
            showFeedbackToast({ title: "Slanje nije uspelo", detail: "Probaj „Kopiraj listu”.", tone: "error" });
          }
        });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => showFeedbackToast({ title: "Lista je kopirana", detail: "Deljenje nije podržano, pa je lista kopirana.", tone: "success" }))
        .catch(() => showFeedbackToast({ title: "Slanje nije uspelo", detail: "Probaj „Kopiraj listu”.", tone: "error" }));
    }
    return;
  }

  if (action === "share-progress") {
    shareProgressCard();
    return;
  }

  if (action === "add-water") {
    const delta = toNumber(actionTarget.dataset.ml);
    if (!delta) {
      return;
    }
    const today = getTodayDateValue();
    store.waterByDate = store.waterByDate && typeof store.waterByDate === "object" ? store.waterByDate : {};
    const next = Math.max(0, Math.round((toNumber(store.waterByDate[today]) || 0) + delta));
    store.waterByDate[today] = next;
    persist();
    render();
    return;
  }

  if (action === "add-coffee") {
    const delta = toNumber(actionTarget.dataset.cups);
    if (!delta) {
      return;
    }
    const today = getTodayDateValue();
    store.coffeeByDate = store.coffeeByDate && typeof store.coffeeByDate === "object" ? store.coffeeByDate : {};
    const next = Math.max(0, Math.round((toNumber(store.coffeeByDate[today]) || 0) + delta));
    // Nula se briše, a ne upisuje: ovaj objekat ide u cloud i backup svakog dana.
    if (next > 0) {
      store.coffeeByDate[today] = next;
    } else {
      delete store.coffeeByDate[today];
    }
    persist();
    render();
    return;
  }

  if (action === "add-steps") {
    const delta = toNumber(actionTarget.dataset.steps);
    if (!delta) {
      return;
    }
    const today = getTodayDateValue();
    store.stepsByDate = store.stepsByDate && typeof store.stepsByDate === "object" ? store.stepsByDate : {};
    const next = Math.max(0, Math.round((toNumber(store.stepsByDate[today]) || 0) + delta));
    store.stepsByDate[today] = next;
    persist();
    render();
    return;
  }

  if (action === "toggle-steps-edit") {
    state.stepsEditOpen = !state.stepsEditOpen;
    render();
    if (state.stepsEditOpen) {
      window.requestAnimationFrame(() => {
        const input = document.querySelector("#steps-input");
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      });
    }
    return;
  }

  if (action === "set-steps") {
    const input = document.querySelector("#steps-input");
    const value = Math.max(0, Math.round(toNumber(input?.value)));
    const today = getTodayDateValue();
    store.stepsByDate = store.stepsByDate && typeof store.stepsByDate === "object" ? store.stepsByDate : {};
    store.stepsByDate[today] = value;
    state.stepsEditOpen = false;
    persist();
    showFeedbackToast({ title: "Koraci sačuvani", detail: `${value.toLocaleString("sr-RS")} koraka za danas.`, tone: "success" });
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

  if (action === "clear-plan-food-search") {
    state.planDraft.foodId = "";
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#food-search-input")?.focus();
    });
    return;
  }

  if (action === "set-plan-draft-grams") {
    const grams = toNumber(actionTarget.dataset.grams);
    const food = getFoodById(state.planDraft.foodId);
    if (!grams || !food) {
      return;
    }
    // While editing an existing entry, a preset just fills the field —
    // saving still goes through the explicit "Sačuvaj izmene" tap.
    if (state.editingEntryId) {
      state.planDraft.grams = String(grams);
      const amountField = document.querySelector("#amount-field");
      if (amountField) {
        amountField.innerHTML = renderAmountFieldInner(food);
      }
      syncEntryPreview();
      return;
    }
    // Otherwise a preset is a full decision (food + a round amount), so it
    // commits immediately — picking one used to still require a separate
    // tap on "Dodaj namirnicu" below, which read as clicking add twice for
    // the same action.
    if (!commitPlanDraftEntry(food, grams)) {
      return;
    }
    resetPlanDraft();
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#food-search-input")?.focus();
    });
    return;
  }

  if (action === "set-plan-amount-unit") {
    const unit = String(actionTarget.dataset.unit || "g");
    if (!AMOUNT_UNIT_FACTORS[unit] || unit === state.planDraft.amountUnit) {
      return;
    }
    state.planDraft.amountUnit = unit;
    const food = getFoodById(state.planDraft.foodId);
    const amountField = document.querySelector("#amount-field");
    if (amountField) {
      amountField.innerHTML = renderAmountFieldInner(food);
    }
    syncEntryPreview();
    syncCompanionSuggestions();
    window.requestAnimationFrame(() => {
      document.querySelector("#amount-input")?.focus();
    });
    return;
  }

  if (action === "set-favorite-amount-unit") {
    const unit = String(actionTarget.dataset.unit || "g");
    if (!AMOUNT_UNIT_FACTORS[unit] || unit === state.favoriteDraft.amountUnit) {
      return;
    }
    state.favoriteDraft.amountUnit = unit;
    const food = getFoodById(state.favoriteDraft.foodId);
    const amountField = document.querySelector("#favorite-amount-field");
    if (amountField) {
      amountField.innerHTML = renderFavoriteAmountFieldInner(food);
    }
    window.requestAnimationFrame(() => {
      document.querySelector("#favorite-amount-input")?.focus();
    });
    return;
  }

  if (action === "nudge-plan-draft-grams") {
    const direction = toNumber(actionTarget.dataset.direction) || 1;
    const food = getFoodById(state.planDraft.foodId);
    const isPiece = getFoodServingUnit(food) === "piece";
    const unit = isPiece ? "g" : state.planDraft.amountUnit || "g";
    const step = isPiece || unit === "g" ? (isPiece ? 1 : 10) : 1;
    const visibleInput = document.querySelector(isPiece ? "#grams" : "#amount-input");
    const current = toNumber(visibleInput?.value) || 0;
    const minValue = isPiece || unit === "g" ? 1 : 0.5;
    const roundDigits = isPiece || unit === "g" ? 0 : 2;
    const next = Math.max(minValue, roundValue(current + direction * step, roundDigits));
    if (visibleInput instanceof HTMLInputElement) {
      visibleInput.value = next;
    }
    state.planDraft.grams = String(roundValue(isPiece ? next : convertAmountUnitToGrams(next, unit), 0));
    if (!isPiece) {
      const hiddenGrams = document.querySelector("#grams");
      if (hiddenGrams instanceof HTMLInputElement) {
        hiddenGrams.value = state.planDraft.grams;
      }
    }
    syncEntryPreview();
    syncCompanionSuggestions();
    return;
  }

  if (action === "add-companion-suggestion") {
    const foodId = actionTarget.dataset.foodId;
    const grams = toNumber(actionTarget.dataset.grams);
    const food = getFoodById(foodId);
    if (!commitPlanDraftEntry(food, grams)) {
      return;
    }
    render();
    return;
  }

  if (action === "quick-add-food") {
    const foodId = actionTarget.dataset.foodId;
    const mealLabel = normalizeMealLabel(String(actionTarget.dataset.mealLabel || "").trim());
    const food = getFoodById(foodId);
    const grams = quickAddGramsFor(food, store.foodUsage && store.foodUsage[foodId]);
    const fromComposer = Boolean(actionTarget.closest("#plan-entry-form"));
    if (!commitPlanDraftEntry(food, grams, mealLabel)) {
      return;
    }
    render();
    if (!fromComposer && state.activeTab !== "plan") {
      // Added from Namirnice: the meal it landed in is on another tab, so the
      // glowing new row there is invisible — say where it went.
      const targetLabel = normalizeMealLabel(mealLabel || state.planDraft.mealLabel || defaultMeals[0]);
      showFeedbackToast({
        title: `Dodato u ${getMealDisplayParts(targetLabel).title || targetLabel}`,
        detail: `${food.name} · ${formatFoodAmount(food, grams)} · ${weekdayLabel(state.selectedWeekday)}`,
        tone: "success",
      });
    }
    if (fromComposer) {
      window.requestAnimationFrame(() => {
        document.querySelector("#food-search-input")?.focus();
      });
    }
    return;
  }

  if (action === "save-meal-as-favorite") {
    const mealLabel = actionTarget.dataset.mealLabel;
    if (isMealCompletedForWeekday(state.selectedWeekday, mealLabel)) {
      return;
    }
    const mealEntries = getPlanEntriesForDay(state.selectedWeekday, state.selectedWeekTrack)
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
    // Kompozitor je skupljen po difoltu (`recipesBuilderExpanded: false`), a
    // njegovo telo je `display: none` — bez ovoga se draft učita u formu koja
    // se ne vidi, pa scrollIntoView i focus ispod ne rade ništa i klik na
    // olovku izgleda kao da se nije desio.
    state.recipesBuilderExpanded = true;
    setFavoriteDraftFromRecipe(favorite);
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#favorite-meal-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#favorite-name")?.focus();
    });
    return;
  }

  if (action === "open-recipe-apply-dialog") {
    const favorite = store.favoriteMeals.find((entry) => entry.id === actionTarget.dataset.favoriteId);
    if (!favorite) {
      return;
    }
    rememberDialogTrigger(actionTarget);
    openRecipeApplyDialog(favorite);
    render();
    return;
  }

  if (action === "close-recipe-apply-dialog") {
    closeRecipeApplyDialog();
    render();
    restoreFocusAfterDialog();
    return;
  }

  if (action === "toggle-recipe-expanded") {
    const favoriteId = String(actionTarget.dataset.favoriteId || "").trim();
    if (!favoriteId) {
      return;
    }
    toggleRecipeExpanded(favoriteId);
    persist();
    render();
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
    // Isti razlog kao kod izmene celog recepta — bez ovoga je forma skrivena.
    state.recipesBuilderExpanded = true;
    setFavoriteDraftFromItem(favorite, item);
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#favorite-meal-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("#favorite-name")?.focus();
    });
    return;
  }

  if (action === "cancel-edit-favorite-item") {
    state.editingFavoriteItem = { favoriteId: state.editingFavoriteItem.favoriteId, itemId: "", itemIndex: -1 };
    state.favoriteDraft.foodId = "";
    state.favoriteDraft.grams = "";
    state.favoriteDraft.amountUnit = "g";
    render();
    return;
  }

  if (action === "remove-draft-favorite-item") {
    const itemId = String(actionTarget.dataset.itemId || "").trim();
    if (!itemId) {
      return;
    }

    state.favoriteDraft.items = (state.favoriteDraft.items || []).filter((item) => item.id !== itemId);
    if (state.editingFavoriteItem.itemId === itemId) {
      state.editingFavoriteItem = { favoriteId: state.editingFavoriteItem.favoriteId, itemId: "", itemIndex: -1 };
      state.favoriteDraft.foodId = "";
      state.favoriteDraft.grams = "";
      state.favoriteDraft.amountUnit = "g";
    }
    render();
    return;
  }

  if (action === "apply-draft-favorite-item-suggestion") {
    const itemId = String(actionTarget.dataset.itemId || "").trim();
    const foodId = String(actionTarget.dataset.foodId || "").trim();
    const food = getFoodById(foodId);
    if (!itemId || !food) {
      return;
    }

    state.favoriteDraft.items = (state.favoriteDraft.items || []).map((item) =>
      item.id === itemId
        ? {
            ...item,
            foodId: food.id,
            foodName: food.name,
          }
        : item
    );
    render();
    return;
  }

  if (action === "cancel-edit-favorite-meal") {
    resetFavoriteDraft();
    render();
    return;
  }

  if (action === "save-favorite-meal-draft") {
    const draftPreview = getFavoriteDraftPreview();
    const hasPendingItem = state.favoriteDraft.foodId && toNumber(state.favoriteDraft.grams) > 0;
    const nextItems = buildFavoriteItemsPayload(hasPendingItem);

    if (!draftPreview.favoriteName || !draftPreview.mealLabel) {
      showFeedbackToast({ title: "Fali naziv ili tip obroka", detail: "Upiši naziv i tip obroka pre čuvanja recepta.", tone: "warning" });
      return;
    }

    if (!nextItems.length) {
      showFeedbackToast({ title: "Recept još nije spreman", detail: "Dodaj bar jedan sastojak pre čuvanja recepta.", tone: "warning" });
      return;
    }

    const hasUnmatchedItems = nextItems.some((item) => !item.foodId || !toNumber(item.grams));
    if (hasUnmatchedItems) {
      showFeedbackToast({ title: "Poveži sastojke", detail: "Poveži svaku stavku sa namirnicom iz baze i proveri gramažu pre čuvanja.", tone: "warning" });
      return;
    }

    const saved = saveFavoriteMealDraft({
      favoriteName: state.favoriteDraft.favoriteName,
      mealLabel: state.favoriteDraft.mealLabel,
      description: state.favoriteDraft.description,
      imageUrl: state.favoriteDraft.imageUrl,
      servings: state.favoriteDraft.servings,
      prepTimeMinutes: state.favoriteDraft.prepTimeMinutes,
      instructions: state.favoriteDraft.instructions,
      items: nextItems,
    });
    if (!saved) {
      return;
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
      weekTrack: state.selectedWeekTrack,
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

    // Removing the last ingredient removes the whole recipe, so the snapshot
    // has to cover both the item list and the recipe list.
    const prevFavoriteMeals = store.favoriteMeals;
    const prevItems = favorite.items;
    favorite.items = favorite.items.filter((_, index) => index !== itemIndex);
    const removedRecipe = !favorite.items.length;
    if (removedRecipe) {
      store.favoriteMeals = store.favoriteMeals.filter((entry) => entry.id !== favorite.id);
    }
    if (
      state.editingFavoriteItem.favoriteId === favorite.id &&
      state.editingFavoriteItem.itemIndex === itemIndex
    ) {
      resetFavoriteDraft();
    }
    persist();
    queuePendingUndo(
      removedRecipe ? `Recept „${favorite.name}" je obrisan (ostao je bez sastojaka).` : "Sastojak obrisan iz recepta.",
      () => {
        favorite.items = prevItems;
        store.favoriteMeals = prevFavoriteMeals;
        persist();
      }
    );
    render();
    return;
  }

  if (action === "delete-favorite-meal") {
    const favoriteId = actionTarget.dataset.favoriteId;
    const prevFavoriteMeals = store.favoriteMeals;
    if (!prevFavoriteMeals.some((entry) => entry.id === favoriteId)) {
      return;
    }
    store.favoriteMeals = store.favoriteMeals.filter((entry) => entry.id !== favoriteId);
    if (state.editingFavoriteItem.favoriteId === favoriteId) {
      resetFavoriteDraft();
    }
    // The in-memory record (kept for undo) still carries its base64, so an undo
    // re-persists it to localStorage and the next reconcile re-migrates it.
    idbDeletePhoto(getRecipeImageKey(favoriteId));
    persist();
    queuePendingUndo("Recept obrisan.", () => {
      store.favoriteMeals = prevFavoriteMeals;
      persist();
    });
    render();
    return;
  }

  if (action === "delete-entry") {
    const entryId = actionTarget.dataset.entryId;
    const entry = getPlanEntriesForDay(state.selectedWeekday, state.selectedWeekTrack).find((item) => item.id === entryId);
    if (entry && isMealCompletedForWeekday(state.selectedWeekday, entry.mealLabel)) {
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
      queuePendingUndo("Stavka obrisana.", () => {
        const safeIndex = removedIndex >= 0 ? removedIndex : store.weeklyPlanEntries.length;
        store.weeklyPlanEntries.splice(safeIndex, 0, removedEntry);
        persist();
      });
    }
    render();
    return;
  }

  if (action === "delete-day-plan") {
    const weekday = state.selectedWeekday;
    const weekTrack = state.selectedWeekTrack;
    const dayEntries = store.weeklyPlanEntries.filter(
      (entry) => entry.weekday === weekday && normalizeWeekTrack(entry.weekTrack) === weekTrack
    );
    if (!dayEntries.length) {
      return;
    }
    const removableIds = new Set(
      dayEntries.filter((entry) => !isMealCompletedForWeekday(weekday, entry.mealLabel, weekTrack)).map((entry) => entry.id)
    );
    if (!removableIds.size) {
      showFeedbackToast({ title: "Ništa nije obrisano", detail: "Svi obroci ovog dana su zaključani (čekirani).", tone: "warning" });
      return;
    }
    const previousEntries = store.weeklyPlanEntries;
    const removedCount = removableIds.size;
    const lockedCount = dayEntries.length - removedCount;
    store.weeklyPlanEntries = store.weeklyPlanEntries.filter((entry) => !removableIds.has(entry.id));
    persist();
    queuePendingUndo(
      `Obrisano ${removedCount} ${srPlural(removedCount, "stavka", "stavke", "stavki")} za ${weekdayAccusative(weekday)}.${
        lockedCount ? ` ${lockedCount} zaključanih preskočeno.` : ""
      }`,
      () => {
        store.weeklyPlanEntries = previousEntries;
        persist();
      }
    );
    render();
    return;
  }

  if (action === "toggle-bulk-delete-panel") {
    state.bulkDeletePanelOpen = !state.bulkDeletePanelOpen;
    state.bulkDeletePickDays = [];
    render();
    return;
  }

  if (action === "toggle-bulk-delete-day") {
    const weekday = String(actionTarget.dataset.weekday || "").trim();
    const weekTrack = normalizeWeekTrack(actionTarget.dataset.weekTrack);
    if (!weekday || !WEEKDAYS.includes(weekday)) {
      return;
    }
    const picked = state.bulkDeletePickDays || [];
    const exists = picked.some((pair) => pair.weekday === weekday && pair.weekTrack === weekTrack);
    state.bulkDeletePickDays = exists
      ? picked.filter((pair) => !(pair.weekday === weekday && pair.weekTrack === weekTrack))
      : [...picked, { weekday, weekTrack }];
    render();
    return;
  }

  if (action === "confirm-bulk-delete-days") {
    const pairs = state.bulkDeletePickDays || [];
    if (!pairs.length) {
      return;
    }
    const targetEntries = store.weeklyPlanEntries.filter((entry) =>
      pairs.some((pair) => pair.weekday === entry.weekday && normalizeWeekTrack(entry.weekTrack) === pair.weekTrack)
    );
    if (!targetEntries.length) {
      showFeedbackToast({ title: "Nema šta da se obriše", detail: "Izabrani dani su već prazni.", tone: "warning" });
      return;
    }
    const removableIds = new Set(
      targetEntries
        .filter((entry) => !isMealCompletedForWeekday(entry.weekday, entry.mealLabel, normalizeWeekTrack(entry.weekTrack)))
        .map((entry) => entry.id)
    );
    if (!removableIds.size) {
      showFeedbackToast({ title: "Ništa nije obrisano", detail: "Svi obroci izabranih dana su zaključani (čekirani).", tone: "warning" });
      return;
    }
    const previousEntries = store.weeklyPlanEntries;
    const removedCount = removableIds.size;
    const lockedCount = targetEntries.length - removedCount;
    store.weeklyPlanEntries = store.weeklyPlanEntries.filter((entry) => !removableIds.has(entry.id));
    state.bulkDeletePanelOpen = false;
    state.bulkDeletePickDays = [];
    persist();
    queuePendingUndo(
      `Obrisano ${removedCount} ${srPlural(removedCount, "stavka", "stavke", "stavki")} sa ${pairs.length} dana.${
        lockedCount ? ` ${lockedCount} zaključanih preskočeno.` : ""
      }`,
      () => {
        store.weeklyPlanEntries = previousEntries;
        persist();
      }
    );
    render();
    return;
  }

  if (action === "delete-all-plan-meals") {
    if (!store.weeklyPlanEntries.length) {
      return;
    }
    const confirmed = window.confirm("Obriši sve obroke iz celog plana (Ova nedelja i Sledeća nedelja)? Čekirani (pojedeni) obroci ostaju.");
    if (!confirmed) {
      return;
    }
    const removableIds = new Set(
      store.weeklyPlanEntries
        .filter((entry) => !isMealCompletedForWeekday(entry.weekday, entry.mealLabel, normalizeWeekTrack(entry.weekTrack)))
        .map((entry) => entry.id)
    );
    if (!removableIds.size) {
      showFeedbackToast({ title: "Ništa nije obrisano", detail: "Svi obroci u planu su zaključani (čekirani).", tone: "warning" });
      return;
    }
    const previousEntries = store.weeklyPlanEntries;
    const removedCount = removableIds.size;
    const lockedCount = store.weeklyPlanEntries.length - removedCount;
    store.weeklyPlanEntries = store.weeklyPlanEntries.filter((entry) => !removableIds.has(entry.id));
    state.bulkDeletePanelOpen = false;
    state.bulkDeletePickDays = [];
    persist();
    queuePendingUndo(
      `Obrisano ${removedCount} ${srPlural(removedCount, "stavka", "stavke", "stavki")} iz celog plana.${
        lockedCount ? ` ${lockedCount} zaključanih preskočeno.` : ""
      }`,
      () => {
        store.weeklyPlanEntries = previousEntries;
        persist();
      }
    );
    render();
    return;
  }

  if (action === "undo-pending") {
    if (!state.pendingUndo) {
      return;
    }
    const { restore } = state.pendingUndo;
    clearPendingUndo();
    if (typeof restore === "function") {
      restore();
    }
    render();
    return;
  }

  if (action === "delete-training-log") {
    const logId = actionTarget.dataset.logId;
    const prevLogs = store.trainingLogs;
    if (!prevLogs.some((log) => log.id === logId)) {
      return;
    }
    store.trainingLogs = store.trainingLogs.filter((log) => log.id !== logId);
    persist();
    queuePendingUndo("Beleška obrisana.", () => {
      store.trainingLogs = prevLogs;
      persist();
    });
    render();
    return;
  }

  if (action === "edit-run") {
    const runId = String(actionTarget.dataset.runId || "").trim();
    if (!getEditingRecord(store.runs, runId)) {
      return;
    }
    // Uvezeni draft i izmena pune istu formu, pa draft mora da se skloni —
    // inače bi posle „Odustani“ iskočili tuđi podaci.
    state.runImportDraft = null;
    state.editingRunId = runId;
    render();
    window.requestAnimationFrame(() => {
      const input = document.querySelector("#run-distance");
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
      document.querySelector("#run-form")?.scrollIntoView({ block: "center" });
    });
    return;
  }

  if (action === "cancel-edit-run") {
    state.editingRunId = "";
    render();
    return;
  }

  if (action === "delete-run") {
    state.editingRunId = "";
    const runId = String(actionTarget.dataset.runId || "");
    const run = (store.runs || []).find((entry) => entry.id === runId);
    if (!run) {
      return;
    }
    const snapshot = JSON.parse(JSON.stringify(store.runs));
    store.runs = store.runs.filter((entry) => entry.id !== runId);
    persist();
    queuePendingUndo("Trčanje obrisano.", () => {
      store.runs = snapshot;
      persist();
    });
    render();
    return;
  }

  if (action === "import-run-clipboard") {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
      showFeedbackToast({
        title: "Nije podržano",
        detail: "Ovaj browser ne dozvoljava čitanje clipboard-a. Prekucaj brojke ručno.",
        tone: "error",
        duration: 3400,
      });
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      applyRunClipboardText(text, { silentOnMiss: false });
    } catch (error) {
      showFeedbackToast({
        title: "Nema pristupa clipboard-u",
        detail: "Kad iskoči dozvola za lepljenje, prihvati je pa probaj opet.",
        tone: "error",
        duration: 3400,
      });
    }
    return;
  }

  if (action === "import-activity-clipboard") {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
      showFeedbackToast({
        title: "Nije podržano",
        detail: "Ovaj browser ne dozvoljava čitanje clipboard-a.",
        tone: "error",
        duration: 3400,
      });
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      applyActivityClipboardText(text, { silentOnMiss: false });
    } catch (error) {
      showFeedbackToast({
        title: "Nema pristupa clipboard-u",
        detail: "Kad iskoči dozvola za lepljenje, prihvati je pa probaj opet.",
        tone: "error",
        duration: 3400,
      });
    }
    return;
  }

  if (action === "launch-run-shortcut" || action === "launch-activity-shortcut") {
    const key = action === "launch-run-shortcut" ? "run" : "activity";
    store.shortcutNames = store.shortcutNames || { run: "", activity: "" };
    let name = getShortcutName(key);
    if (!name) {
      const label = key === "run" ? "trčanje" : "dnevnu aktivnost";
      const entered = window.prompt(
        `Kako se TAČNO zove tvoja prečica za ${label}? (isto kao u Shortcuts app-u)`,
        ""
      );
      name = String(entered || "").trim();
      if (!name) {
        return;
      }
      store.shortcutNames[key] = name;
      persist();
    }
    launchShortcut(name);
    return;
  }

  if (action === "rename-run-shortcut" || action === "rename-activity-shortcut") {
    const key = action === "rename-run-shortcut" ? "run" : "activity";
    const entered = window.prompt("Ime prečice u Shortcuts app-u:", getShortcutName(key));
    if (entered === null) {
      return;
    }
    store.shortcutNames = store.shortcutNames || { run: "", activity: "" };
    store.shortcutNames[key] = String(entered).trim();
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
      weekTrack: state.selectedWeekTrack,
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

    const prevFavoriteTrainings = store.favoriteTrainings;
    store.favoriteTrainings = store.favoriteTrainings.filter(
      (entry) => entry.id !== actionTarget.dataset.favoriteTrainingId
    );
    persist();
    queuePendingUndo("Omiljeni trening obrisan.", () => {
      store.favoriteTrainings = prevFavoriteTrainings;
      persist();
    });
    render();
    return;
  }

  if (action === "delete-training-progress") {
    const prevProgressLogs = store.trainingProgressLogs;
    if (!prevProgressLogs.some((log) => log.id === actionTarget.dataset.progressId)) {
      return;
    }
    store.trainingProgressLogs = store.trainingProgressLogs.filter((log) => log.id !== actionTarget.dataset.progressId);
    persist();
    queuePendingUndo("Unos opterećenja obrisan.", () => {
      store.trainingProgressLogs = prevProgressLogs;
      persist();
    });
    render();
    return;
  }

  if (action === "edit-measurement") {
    const measurementId = String(actionTarget.dataset.measurementId || "").trim();
    if (!getEditingRecord(store.measurements, measurementId)) {
      return;
    }
    state.editingMeasurementId = measurementId;
    render();
    window.requestAnimationFrame(() => {
      const input = document.querySelector("#measurement-weightKg");
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
      document.querySelector("#measurement-form")?.scrollIntoView({ block: "center" });
    });
    return;
  }

  if (action === "cancel-edit-measurement") {
    state.editingMeasurementId = "";
    render();
    return;
  }

  if (action === "delete-measurement") {
    state.editingMeasurementId = "";
    const measurementId = actionTarget.dataset.measurementId;
    const prevMeasurements = store.measurements;
    if (!prevMeasurements.some((entry) => entry.id === measurementId)) {
      return;
    }
    store.measurements = store.measurements.filter((entry) => entry.id !== measurementId);
    persist();
    queuePendingUndo("Merenje obrisano.", () => {
      store.measurements = prevMeasurements;
      persist();
    });
    render();
    return;
  }

  if (action === "edit-lab-result") {
    const labId = String(actionTarget.dataset.id || "").trim();
    if (!getEditingRecord(store.labResults, labId)) {
      return;
    }
    state.editingLabId = labId;
    render();
    window.requestAnimationFrame(() => {
      const input = document.querySelector("#lab-value");
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
      document.querySelector("#lab-form")?.scrollIntoView({ block: "center" });
    });
    return;
  }

  if (action === "cancel-edit-lab-result") {
    state.editingLabId = "";
    render();
    return;
  }

  if (action === "delete-lab-result") {
    state.editingLabId = "";
    const id = actionTarget.dataset.id;
    const prevLabResults = store.labResults;
    if (!prevLabResults.some((entry) => entry.id === id)) {
      return;
    }
    store.labResults = store.labResults.filter((entry) => entry.id !== id);
    persist();
    queuePendingUndo("Analiza obrisana.", () => {
      store.labResults = prevLabResults;
      persist();
    });
    render();
    return;
  }

  if (action === "edit-body-comp") {
    const bodyCompId = String(actionTarget.dataset.id || "").trim();
    if (!getEditingRecord(store.bodyComposition, bodyCompId)) {
      return;
    }
    state.editingBodyCompId = bodyCompId;
    render();
    window.requestAnimationFrame(() => {
      document.querySelector("#body-comp-form")?.scrollIntoView({ block: "center" });
      const input = document.querySelector("#bc-date");
      if (input instanceof HTMLInputElement) {
        input.focus();
      }
    });
    return;
  }

  if (action === "cancel-edit-body-comp") {
    state.editingBodyCompId = "";
    render();
    return;
  }

  if (action === "delete-body-comp") {
    state.editingBodyCompId = "";
    const id = actionTarget.dataset.id;
    const prevBodyComposition = store.bodyComposition;
    if (!prevBodyComposition.some((entry) => entry.id === id)) {
      return;
    }
    store.bodyComposition = store.bodyComposition.filter((entry) => entry.id !== id);
    persist();
    queuePendingUndo("Unos obrisan.", () => {
      store.bodyComposition = prevBodyComposition;
      persist();
    });
    render();
    return;
  }

  if (action === "delete-photo") {
    const photoId = actionTarget.dataset.photoId;
    const prevPhotos = store.progressPhotos;
    const removed = prevPhotos.find((photo) => photo.id === photoId);
    if (!removed) {
      return;
    }
    store.progressPhotos = store.progressPhotos.filter((photo) => photo.id !== photoId);
    persist();
    // Drop the blob from IndexedDB. Restore re-writes it if the user undoes —
    // removed.previewUrl is still in memory, and the put is queued after this
    // delete so it wins.
    idbDeletePhoto(photoId);
    queuePendingUndo("Slika obrisana.", () => {
      store.progressPhotos = prevPhotos;
      if (removed.previewUrl) {
        idbPutPhotos([removed]);
      }
      persist();
    });
    render();
    return;
  }

  if (action === "apply-goal-calibration") {
    const result = applyGoalCalibration();
    render();
    if (result) {
      showFeedbackToast({
        title: "Cilj je kalibrisan",
        detail: `${result.previous} → ${result.next} kcal dnevno. Makroi su preračunati.`,
        tone: "success",
      });
    }
    return;
  }

  if (action === "dismiss-goal-calibration") {
    dismissGoalCalibration();
    render();
    showFeedbackToast({ title: "Odloženo", detail: `Nova provera za ${CALIBRATION_COOLDOWN_DAYS} dana.`, tone: "info" });
    return;
  }

  if (action === "open-goal-calibration") {
    if (state.activeTab !== "goals") {
      state.tabEnter = true;
    }
    state.activeTab = "goals";
    state.goalsView = "cilj";
    state.navMenuOpen = false;
    window.location.hash = "goals";
    render();
    window.requestAnimationFrame(() => {
      document.querySelector(".calibration-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return;
  }

  if (action === "apply-adaptive-goal") {
    const measurements = [...(store.measurements || [])]
      .filter((m) => toNumber(m.weightKg) > 0)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    if (!measurements.length) {
      return;
    }
    const currentWeight = toNumber(measurements[0].weightKg);
    store.profile.weightKg = currentWeight;
    const rec = getGoalRecommendation(store.profile, store.goals);
    if (rec) {
      store.goals.calories = rec.targetCalories;
      store.goals.protein = rec.protein;
      store.goals.carbs = rec.carbs;
      store.goals.fat = rec.fat;
      store.goals.basisWeightKg = currentWeight;
    }
    persist();
    render();
    showFeedbackToast({
      title: "Cilj je ažuriran",
      detail: rec ? `Novi dnevni cilj: ${rec.targetCalories} kcal.` : "",
      tone: "success",
    });
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
          paceLevel: String(document.querySelector("#goal-pace")?.value || store.goals.paceLevel || "umereno").trim(),
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
        const waterInput = document.querySelector("#goal-water");
        if (waterInput) {
          waterInput.value = String(suggestWaterMl(profileDraft.weightKg) / 1000);
        }
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
        await exportData();
      },
      {
        busyLabel: "Spremam...",
        successTitle: "Backup je spreman",
        successDetail: "JSON backup je preuzet na uređaj.",
      }
    );
    return;
  }

  if (action === "reset-demo-data") {
    if (!isDemoAccount()) {
      return;
    }
    const confirmed = window.confirm(
      "Vrati demo nalog na fabrička podešavanja?\n\nOvo briše SVE izmene na demo nalogu i vraća početni plan, namirnice, trening i obroke. Ne može da se poništi."
    );
    if (!confirmed) {
      return;
    }
    try {
      await runButtonAction(actionTarget, () => resetDemoToFactory(), {
        busyLabel: "Vraćam...",
        successTitle: "Demo je resetovan",
        successDetail: "Nalog je vraćen na početni plan, namirnice i trening.",
        errorTitle: "Reset nije uspeo",
        errorDetail: "Promene su sačuvane lokalno; cloud sync probaj ponovo za koji trenutak.",
      });
    } finally {
      render();
    }
    return;
  }

  if (action === "delete-all-data") {
    if (isDemoAccount()) {
      return;
    }
    const confirmed = window.confirm(
      `Obriši plan, trening, rutinu, dnevnik, merenja i slike na nalogu ${state.authUser?.email || ""}?\n\nNamirnice, recepti, profil i ciljevi (kalorije/makroi) ostaju netaknuti. Ne može da se poništi. Ako želiš da nešto sačuvaš, otkaži pa prvo izvezi backup.`
    );
    if (!confirmed) {
      return;
    }
    try {
      await runButtonAction(actionTarget, () => resetRealAccountToBlank(), {
        busyLabel: "Brišem...",
        successTitle: "Podaci su obrisani",
        successDetail: "Plan, trening, rutina i istorija su obrisani. Namirnice, recepti, profil i ciljevi su ostali.",
        errorTitle: "Brisanje nije uspelo",
        errorDetail: "Promene su sačuvane lokalno; cloud sync probaj ponovo za koji trenutak.",
      });
    } finally {
      render();
    }
    return;
  }

  if (action === "reset-password") {
    const emailInput = document.querySelector("#auth-email");
    const email = emailInput instanceof HTMLInputElement ? emailInput.value.trim() : "";
    if (!email) {
      state.authError = "Unesi email iznad, pa klikni Zaboravljena lozinka.";
      render();
      return;
    }
    state.authError = "";
    sendPasswordResetEmail(firebaseAuth, email)
      .then(() => {
        showFeedbackToast({
          title: "Proveri email",
          detail: "Poslali smo link za resetovanje lozinke (pogledaj i spam folder).",
          tone: "success",
          duration: 4000,
        });
      })
      .catch((error) => {
        console.error("Password reset failed", error);
        state.authError = getAuthErrorMessage(error);
        render();
      });
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

  if (action === "toggle-quick-weight") {
    state.quickWeightOpen = !state.quickWeightOpen;
    render();
    if (state.quickWeightOpen) {
      window.requestAnimationFrame(() => document.querySelector("#quick-weight")?.focus());
    }
    return;
  }

  if (action === "open-quick-entry") {
    rememberDialogTrigger(actionTarget);
    state.quickEntryOpen = true;
    state.quickEntryText = "";
    state.quickEntryOverrides = {};
    render();
    return;
  }

  if (action === "close-quick-entry") {
    state.quickEntryOpen = false;
    render();
    restoreFocusAfterDialog();
    return;
  }

  if (action === "remove-quick-entry-row") {
    const index = Number(actionTarget.dataset.index);
    state.quickEntryOverrides[index] = { ...(state.quickEntryOverrides[index] || {}), removed: true };
    render();
    return;
  }

  if (action === "commit-quick-entry") {
    const rows = getQuickEntryRows().filter((row) => !row.removed && row.food && row.amount > 0);
    const addedIds = [];
    let blockedMeals = 0;
    rows.forEach((row) => {
      if (isMealCompletedForWeekday(state.selectedWeekday, row.mealLabel)) {
        blockedMeals += 1;
        return;
      }
      if (commitPlanDraftEntry(row.food, row.amount, row.mealLabel)) {
        addedIds.push(state.lastAddedEntryId);
      }
    });
    state.quickEntryOpen = false;
    state.quickEntryText = "";
    state.quickEntryOverrides = {};
    if (addedIds.length) {
      queuePendingUndo(
        `Dodato ${addedIds.length} ${srPlural(addedIds.length, "stavka", "stavke", "stavki")} iz brzog unosa.${blockedMeals ? " Zatvoreni obroci su preskočeni." : ""}`,
        () => {
          store.weeklyPlanEntries = store.weeklyPlanEntries.filter((entry) => !addedIds.includes(entry.id));
          persist();
        }
      );
    } else if (blockedMeals) {
      announce("Ti obroci su već označeni kao pojedeni, pa nije dodato ništa.");
    }
    render();
    return;
  }

  if (action === "pick-goal-option") {
    const name = actionTarget.dataset.choiceName || "";
    const value = actionTarget.dataset.choiceValue || "";
    const group = actionTarget.closest(".choice-chips");
    const hidden = document.querySelector(`[data-choice-input="${name}"]`);
    if (!group || !hidden) {
      return;
    }
    // Deliberately no render(): the goals form holds other unsaved edits.
    hidden.value = value;
    group.querySelectorAll(".choice-chip").forEach((chip) => {
      const on = chip === actionTarget;
      chip.classList.toggle("is-active", on);
      chip.setAttribute("aria-checked", String(on));
    });
    // The pace chips state kg/week, which depends on whether you are cutting
    // or bulking — so they have to follow a change of goal.
    if (name === "targetMode") {
      document.querySelectorAll('[data-choice-name="paceLevel"]').forEach((chip) => {
        const hintEl = chip.querySelector(".choice-chip-hint");
        const hint = paceHintFor(chip.dataset.choiceValue, value);
        if (hintEl) {
          hintEl.textContent = hint;
          hintEl.hidden = !hint;
        }
      });
    }
    return;
  }

  if (action === "jump-measurement") {
    state.activeTab = "progress";
    state.progressView = "merenja";
    state.lastTabInGroup = state.lastTabInGroup || {};
    state.lastTabInGroup.progress = "progress";
    state.navMenuOpen = false;
    window.location.hash = "progress";
    render();
    window.requestAnimationFrame(() => {
      const form = document.querySelector("#measurement-form");
      const details = form?.closest("details");
      if (details) {
        details.open = true;
      }
      form?.scrollIntoView({ behavior: "smooth", block: "start" });
      // #progress-weight je kilaža u treningu; merenju treba njegovo polje.
      document.querySelector("#measurement-weightKg")?.focus();
    });
    return;
  }

  if (action === "copy-meal-from-previous-day") {
    const mealLabel = normalizeMealLabel(String(actionTarget.dataset.mealLabel || ""));
    const previous = getPreviousPlanDay(state.selectedWeekday, state.selectedWeekTrack);
    const source = getPlanEntriesForDay(previous.weekday, previous.weekTrack).filter((entry) => normalizeMealLabel(entry.mealLabel) === mealLabel);
    if (!mealLabel || !source.length || isMealCompletedForWeekday(state.selectedWeekday, mealLabel)) {
      return;
    }
    const copiedIds = [];
    source.forEach((entry) => {
      const id = uid("plan");
      copiedIds.push(id);
      store.weeklyPlanEntries.push({
        ...entry,
        id,
        weekday: state.selectedWeekday,
        weekTrack: state.selectedWeekTrack,
        mealLabel,
        done: false,
      });
    });
    expandMealForWeekday(state.selectedWeekday, mealLabel);
    persist();
    queuePendingUndo(`Kopirano od juče u ${getMealDisplayParts(mealLabel).title || mealLabel}: ${copiedIds.length} ${srPlural(copiedIds.length, "stavka", "stavke", "stavki")}.`, () => {
      store.weeklyPlanEntries = store.weeklyPlanEntries.filter((entry) => !copiedIds.includes(entry.id));
      persist();
    });
    render();
    return;
  }

  if (action === "pick-plan-food") {
    const food = getFoodById(String(actionTarget.dataset.foodId || ""));
    const input = document.querySelector("#food-search-input");
    if (!food || !(input instanceof HTMLInputElement)) {
      return;
    }
    input.value = food.name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const list = document.querySelector("#food-suggest");
    if (list) {
      list.hidden = true;
    }
    window.requestAnimationFrame(() => {
      const amount = document.querySelector("#amount-input") || document.querySelector("#grams");
      if (amount instanceof HTMLInputElement && amount.type !== "hidden") {
        amount.focus();
        amount.select();
      }
    });
    return;
  }

  if (action === "clear-recipe-search") {
    state.recipeSearch = "";
    render();
    window.requestAnimationFrame(() => document.querySelector("#recipe-search")?.focus());
    return;
  }

  if (action === "clear-food-search") {
    state.foodSearch = "";
    render();
    window.requestAnimationFrame(() => document.querySelector("#food-search")?.focus());
    return;
  }

  if (action === "add-catalog-food") {
    const food = restoreCatalogFood(String(actionTarget.dataset.catalogId || ""));
    if (!food) {
      return;
    }
    persist();
    render();
    showFeedbackToast({ title: "Dodato u tvoje namirnice", detail: `"${food.name}" je sada u tvojoj bazi.` });
    return;
  }

  if (action === "add-shared-food") {
    const barcode = String(actionTarget.dataset.barcode || "");
    const row = (sharedFoodsIndex || []).find((item) => item.barcode === barcode);
    const food = addSharedFoodToStore(row);
    if (!food) {
      return;
    }
    persist();
    render();
    showFeedbackToast({ title: "Dodato u tvoje namirnice", detail: `"${food.name}" (na 100 g) je sada u tvojoj bazi.` });
    return;
  }

  if (action === "toggle-shared-foods") {
    store.preferences = store.preferences && typeof store.preferences === "object" ? store.preferences : {};
    store.preferences.sharedFoods = actionTarget instanceof HTMLInputElement ? actionTarget.checked : !store.preferences.sharedFoods;
    persist();
    render();
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

    const wasEditingEntry = Boolean(state.editingEntryId);
    if (wasEditingEntry) {
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
      expandMealForWeekday(state.selectedWeekday, mealLabel);
      persist();
    } else if (!commitPlanDraftEntry(food, grams, mealLabel)) {
      return;
    }
    resetPlanDraft();
    event.target.reset();
    render();
    // Fresh adds (not edits) keep the composer open for the next item, so
    // refocus the search field — logging several foods in a row shouldn't
    // need a re-tap between each one.
    if (!wasEditingEntry) {
      window.requestAnimationFrame(() => {
        document.querySelector("#food-search-input")?.focus();
      });
    }
    return;
  }

  if (event.target.id === "duplicate-day-form") {
    const targetWeekday = String(formData.get("targetWeekday") || "").trim();
    const targetWeekTrack = normalizeWeekTrack(formData.get("targetWeekTrack"));
    const mode = String(formData.get("mode") || "append").trim();
    if (!targetWeekday || (targetWeekday === state.selectedWeekday && targetWeekTrack === state.selectedWeekTrack)) {
      return;
    }

    const sourceWeekTrack = state.selectedWeekTrack;
    const sourceEntries = store.weeklyPlanEntries.filter(
      (entry) => entry.weekday === state.selectedWeekday && normalizeWeekTrack(entry.weekTrack) === sourceWeekTrack
    );
    if (!sourceEntries.length) {
      return;
    }

    const targetHasEntries = store.weeklyPlanEntries.some(
      (entry) => entry.weekday === targetWeekday && normalizeWeekTrack(entry.weekTrack) === targetWeekTrack
    );
    if (mode === "replace" && targetHasEntries) {
      const confirmed = window.confirm(
        `Da li želiš da zameniš sve stavke za ${weekdayAccusative(targetWeekday)} (${getWeekTrackLabel(targetWeekTrack).toLowerCase()})?`
      );
      if (!confirmed) {
        return;
      }
      store.weeklyPlanEntries = store.weeklyPlanEntries.filter(
        (entry) => !(entry.weekday === targetWeekday && normalizeWeekTrack(entry.weekTrack) === targetWeekTrack)
      );
    }

    sourceEntries.forEach((entry) => {
      store.weeklyPlanEntries.push({
        ...entry,
        id: uid("plan"),
        weekday: targetWeekday,
        weekTrack: targetWeekTrack,
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
    // Captured before reset/close clears it; only per-100g values go to the shared DB.
    const scannedBarcode = state.scannedBarcode;
    const servingUnit = String(formData.get("servingUnit") || "grams").trim() === "piece" ? "piece" : "grams";
    const nextFoodBase = {
      name,
      servingUnit,
      servingBaseGrams: servingUnit === "piece" ? 1 : 100,
      kcal: toNumber(formData.get("kcal")),
      protein: toNumber(formData.get("protein")),
      carbs: toNumber(formData.get("carbs")),
      fat: toNumber(formData.get("fat")),
    };
    const nextFood = {
      ...nextFoodBase,
      category: getRecommendedFoodCategory(nextFoodBase),
      ...(scannedBarcode ? { barcode: String(scannedBarcode) } : {}),
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
      const createdFood = {
        id: uid("food"),
        ...nextFood,
      };
      store.foods.push(createdFood);
      // Scanned from the Plan composer: the new product becomes the composer's food.
      if (state.scannerReturnTo === "composer" && state.editingMealLabel) {
        state.planDraft.foodId = createdFood.id;
        state.planDraft.amountUnit = "g";
        state.planDraft.grams = String(getFoodServingBaseValue(createdFood));
      }
    }
    state.scannerReturnTo = "";

    if (scannedBarcode && servingUnit === "grams") {
      saveSharedFood(scannedBarcode, nextFood);
    }

    persist();
    event.target.reset();
    closeFoodEditorDialog();
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
            category: getRecommendedFoodCategory({
              ...entry,
              kcal,
              protein,
              carbs,
              fat,
            }),
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

    if (state.editingHabitId && !store.habits.some((habit) => habit.id === state.editingHabitId)) {
      state.editingHabitId = "";
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

    if (state.editingTaskId && !store.dayTasks.some((task) => task.id === state.editingTaskId)) {
      state.editingTaskId = "";
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
        weekTrack: state.selectedWeekTrack,
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

    if (state.editingSupplementId && !store.supplements.some((supplement) => supplement.id === state.editingSupplementId)) {
      state.editingSupplementId = "";
    }
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
    const foodSearch = String(formData.get("foodSearch") || "").trim();
    const resolvedFood = resolveFoodFromQuery(foodSearch);
    const foodId = String(formData.get("foodId") || resolvedFood?.id || "").trim();
    const grams = toNumber(formData.get("grams"));
    const food = getFoodById(foodId);
    if (!favoriteName || !mealLabel || !food || !grams) {
      return;
    }

    const nextDraftItem = {
      id: state.editingFavoriteItem.itemId || uid("favorite-item"),
      foodId: food.id,
      foodName: food.name,
      displayName: food.name,
      grams: String(roundValue(grams, 0)),
    };

    if (state.editingFavoriteItem.itemId) {
      state.favoriteDraft.items = (state.favoriteDraft.items || []).map((item) =>
        item.id === state.editingFavoriteItem.itemId ? nextDraftItem : item
      );
      state.editingFavoriteItem = { favoriteId: state.editingFavoriteItem.favoriteId, itemId: "", itemIndex: -1 };
    } else {
      state.favoriteDraft.items = [...(state.favoriteDraft.items || []), nextDraftItem];
    }

    state.favoriteDraft.foodId = "";
    state.favoriteDraft.grams = "";
    state.favoriteDraft.amountUnit = "g";
    render();
    return;
  }

  if (event.target.id === "recipe-apply-form") {
    const favoriteId = String(formData.get("favoriteId") || "").trim();
    const weekday = String(formData.get("weekday") || state.selectedWeekday).trim();
    const weekTrack = normalizeWeekTrack(formData.get("weekTrack") ?? state.selectedWeekTrack);
    const mealLabel = normalizeMealLabel(String(formData.get("mealLabel") || "").trim());
    const favorite = store.favoriteMeals.find((entry) => entry.id === favoriteId);
    if (!favorite || !weekday || !mealLabel) {
      return;
    }

    if (!applyFavoriteMealToDay(favorite, { weekday, weekTrack, mealLabel })) {
      return;
    }

    closeRecipeApplyDialog();
    persist();
    render();
    showFeedbackToast({
      title: "Recept je dodat u plan",
      detail:
        favorite.servings > 1
          ? `"${favorite.name}" je dodat u ${weekday} pod ${mealLabel} kao 1 porcija.`
          : `"${favorite.name}" je dodat u ${weekday} pod ${mealLabel}.`,
    });
    return;
  }

  if (event.target.id === "training-form") {
    const weekday = String(formData.get("weekday") || state.selectedWeekday).trim();
    const weekTrack = normalizeWeekTrack(formData.get("weekTrack") ?? state.selectedWeekTrack);
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
      weekTrack,
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
    state.trainingProgressPrefill = "";
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
        const weekday = state.selectedWeekday;
        const burnKcal = Math.max(0, toNumber(formData.get("burnKcal")));
        store.trainingBurnByWeekday[weekday] = burnKcal;
        // Polja po sekcijama postoje samo na danima sa planom; na ostalima
        // formData nema te ključeve i postojeći unos ostaje netaknut.
        if (TRAINING_BURN_SECTIONS.some((section) => formData.has(`section-${section.id}`))) {
          const bucket = {};
          TRAINING_BURN_SECTIONS.forEach((section) => {
            const kcal = Math.min(5000, Math.max(0, Math.round(toNumber(formData.get(`section-${section.id}`)))));
            if (kcal > 0) {
              bucket[section.id] = kcal;
            }
          });
          store.trainingSectionBurnByWeekday = store.trainingSectionBurnByWeekday || {};
          // Prazan dan se briše, ne čuva kao {} — ovaj objekat ide u cloud i backup.
          if (Object.keys(bucket).length) {
            store.trainingSectionBurnByWeekday[weekday] = bucket;
          } else {
            delete store.trainingSectionBurnByWeekday[weekday];
          }
        }
        persist();
        render();
      },
      {
        busyLabel: "Čuvam...",
        successTitle: "Potrošnja je sačuvana",
        successDetail: `Kalorije treninga za ${weekdayAccusative(state.selectedWeekday)} su ažurirane.`,
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

  if (event.target.id === "run-form") {
    const date = String(formData.get("date") || "").trim();
    const distanceKm = toNumber(formData.get("distanceKm"));
    const minutes = Math.max(0, Math.floor(toNumber(formData.get("minutes"))));
    const seconds = Math.max(0, Math.floor(toNumber(formData.get("seconds"))));
    const durationSec = minutes * 60 + seconds;
    const typeRaw = String(formData.get("type") || "lagano").trim();
    const avgHr = toNumber(formData.get("avgHr"));
    const maxHr = toNumber(formData.get("maxHr"));
    const note = String(formData.get("note") || "").trim();

    if (!date || !(distanceKm > 0) || !(durationSec > 0)) {
      window.alert("Unesi bar datum, distancu (km) i vreme trčanja.");
      return;
    }

    const editingRun = getEditingRecord(store.runs, state.editingRunId);
    const record = {
      id: editingRun ? editingRun.id : uid("run"),
      date,
      distanceKm,
      durationSec,
      type: RUN_TYPES.some((type) => type.id === typeRaw) ? typeRaw : "lagano",
      avgHr: avgHr > 0 ? Math.round(avgHr) : null,
      maxHr: maxHr > 0 ? Math.round(maxHr) : null,
      note,
      // createdAt je vreme unosa, ne trčanja — izmena ga ne prepisuje, jer se
      // po njemu razrešava red kad dva trčanja dele isti datum.
      createdAt: editingRun ? editingRun.createdAt : new Date().toISOString(),
    };
    if (editingRun) {
      replaceRecordInPlace(store.runs, editingRun.id, record);
    } else {
      store.runs.unshift(record);
    }
    state.editingRunId = "";
    state.runImportDraft = null;
    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "quick-weight-form") {
    const weightKg = toNumber(String(formData.get("weightKg") || "").replace(",", "."));
    if (!(weightKg > 0)) {
      return;
    }
    store.measurements = Array.isArray(store.measurements) ? store.measurements : [];
    const measurement = { id: uid("measurement"), date: getTodayDateValue(), weightKg: roundValue(weightKg, 1) };
    store.measurements.push(measurement);
    state.quickWeightOpen = false;
    persist();
    queuePendingUndo(`Težina sačuvana: ${roundValue(weightKg, 1)} kg (danas).`, () => {
      store.measurements = store.measurements.filter((entry) => entry.id !== measurement.id);
      persist();
    });
    render();
    return;
  }

  if (event.target.id === "measurement-form") {
    const date = String(formData.get("date") || "").trim();
    if (!date) {
      return;
    }

    const editing = getEditingRecord(store.measurements, state.editingMeasurementId);
    const measurement = editing
      ? { ...editing, date }
      : {
          id: uid("measurement"),
          date,
          // Cilj se zamrzava ovde, na dan unosa — kasnija promena cilja u Ciljevima
          // ne sme da prepravi šta je pisalo u trenutku merenja.
          calorieGoal: getCalorieGoalForDate(date),
        };
    // Zamrznuti cilj prati datum: izmena težine ga ne dira, a premeštanje unosa
    // na drugi dan mora, jer je tog dana važio drugi cilj.
    if (editing && normalizeDateValue(editing.date) !== normalizeDateValue(date)) {
      measurement.calorieGoal = getCalorieGoalForDate(date);
    }

    measurementFields.forEach((field) => {
      const raw = formData.get(field.id);
      if (field.type === "number") {
        const value = raw === "" || raw == null ? null : toNumber(raw);
        if (value !== null) {
          measurement[field.id] = value;
        } else {
          // Ispražnjeno polje pri izmeni mora da skine meru, ne da je ostavi.
          delete measurement[field.id];
        }
        return;
      }

      const value = String(raw || "").trim();
      if (value) {
        measurement[field.id] = value;
      } else {
        delete measurement[field.id];
      }
    });

    if (!(toNumber(measurement.weightKg) > 0)) {
      window.alert("Unesi težinu — ona je srž merenja, ostalo je opciono.");
      return;
    }

    // Slike iz forme nose datum merenja; spajaju se po datumu, bez tvrde veze,
    // pa brisanje merenja ne ostavlja siročiće i naknadno dodata slika sa istim
    // datumom sama upadne u istu sesiju.
    const pickedPhotos = PHOTO_TAGS.map((tag) => ({
      tag,
      file: event.target.querySelector(`#measurement-photo-${tag}`)?.files?.[0] || null,
    })).filter((slot) => slot.file);

    const photoRecords = [];
    for (const slot of pickedPhotos) {
      try {
        const optimized = await createOptimizedPhoto(slot.file);
        photoRecords.push({
          id: uid("photo"),
          date,
          tag: slot.tag,
          note: "",
          previewUrl: optimized.previewUrl,
          width: optimized.width,
          height: optimized.height,
        });
      } catch (error) {
        console.error("Photo optimize failed", error);
        window.alert(`Sliku „${PHOTO_TAG_LABELS[slot.tag]}“ nisam uspeo da obradim — merenje se čuva bez nje.`);
      }
    }

    if (photoRecords.length) {
      await idbPutPhotos(photoRecords);
      store.progressPhotos.unshift(...photoRecords);
    }

    const previousProfileWeight = store.profile.weightKg;
    const previousRecord = editing ? { ...editing } : null;
    if (editing) {
      replaceRecordInPlace(store.measurements, editing.id, measurement);
    } else {
      store.measurements.unshift(measurement);
    }
    // Profil nosi trenutnu težinu, pa ga sme da pomeri samo najnovije merenje —
    // ispravka unosa od prošlog meseca ne sme da prepiše današnju kilažu.
    const isLatestMeasurement = !store.measurements.some(
      (entry) => entry.id !== measurement.id && normalizeDateValue(entry.date) > normalizeDateValue(measurement.date)
    );
    if (isLatestMeasurement) {
      store.profile.weightKg = measurement.weightKg;
    }

    const saved = persist(() => {
      if (previousRecord) {
        replaceRecordInPlace(store.measurements, previousRecord.id, previousRecord);
      } else {
        store.measurements = store.measurements.filter((entry) => entry.id !== measurement.id);
      }
      const rolledBackIds = new Set(photoRecords.map((photo) => photo.id));
      store.progressPhotos = store.progressPhotos.filter((photo) => !rolledBackIds.has(photo.id));
      store.profile.weightKg = previousProfileWeight;
    });

    if (!saved) {
      // Lokalni snimak je vraćen unazad — skloni i blobove iz IndexedDB.
      photoRecords.forEach((photo) => idbDeletePhoto(photo.id));
      return;
    }

    state.editingMeasurementId = "";
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "lab-form") {
    const marker = String(formData.get("marker") || "").trim();
    const valueRaw = formData.get("value");
    const date = String(formData.get("date") || "").trim();
    if (!marker || valueRaw === "" || valueRaw == null || !date) {
      return;
    }
    // Curated markers bring a unit + orientational reference range; a custom
    // marker is tracked without a range (no status, just the trend).
    const curated = LAB_MARKERS.find((m) => m.name.toLowerCase() === marker.toLowerCase());
    const editingLab = getEditingRecord(store.labResults, state.editingLabId);
    // Opseg i jedinica se pri izmeni računaju ponovo iz markera: ako je marker
    // promenjen, stari opseg bi ostao i status bi se ocenjivao po tuđoj skali.
    const record = {
      id: editingLab ? editingLab.id : uid("lab"),
      marker: curated ? curated.name : marker,
      value: toNumber(valueRaw),
      unit: curated ? curated.unit : "",
      refLow: curated && curated.low != null ? curated.low : null,
      refHigh: curated && curated.high != null ? curated.high : null,
      date,
    };
    if (editingLab) {
      replaceRecordInPlace(store.labResults, editingLab.id, record);
    } else {
      store.labResults.unshift(record);
    }
    state.editingLabId = "";
    persist();
    event.target.reset();
    render();
    return;
  }

  if (event.target.id === "body-comp-form") {
    const date = String(formData.get("date") || "").trim();
    if (!date) {
      return;
    }
    const values = {};
    BODY_METRICS.forEach((m) => {
      const raw = formData.get(m.key);
      if (raw == null) {
        return;
      }
      const str = String(raw).trim().replace(",", ".");
      if (str === "") {
        return;
      }
      const num = Number(str);
      if (!Number.isNaN(num)) {
        values[m.key] = num;
      }
    });
    if (!Object.keys(values).length) {
      window.alert("Popuni bar jednu vrednost sa analize.");
      return;
    }
    const editingBodyComp = getEditingRecord(store.bodyComposition, state.editingBodyCompId);
    // `values` se gradi od nule iz forme, pa ispražnjeno polje pri izmeni skida
    // tu metriku umesto da ostavi staru vrednost.
    if (editingBodyComp) {
      replaceRecordInPlace(store.bodyComposition, editingBodyComp.id, { ...editingBodyComp, date, values });
    } else {
      store.bodyComposition.unshift({ id: uid("bc"), date, values });
    }
    state.editingBodyCompId = "";
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

    // Persist the blob to IndexedDB first; on success persistLocal drops it from
    // the localStorage snapshot. If IDB fails, the id stays out of photoIdsInIdb
    // and the blob is kept in localStorage as a fallback so nothing is lost.
    await idbPutPhotos([record]);
    store.progressPhotos.unshift(record);
    const saved = persist(() => {
      store.progressPhotos = store.progressPhotos.filter((photo) => photo.id !== record.id);
    });

    if (saved) {
      event.target.reset();
      render();
    } else {
      // Local save rolled the record back out of the store — drop the IDB blob too.
      idbDeletePhoto(record.id);
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
        store.goals.paceLevel = String(formData.get("paceLevel") || "umereno").trim();
        store.goals.calories = toNumber(formData.get("calories"));
        store.goals.targetWeightKg = toNumber(formData.get("targetWeightKg")) || null;
        store.goals.basisWeightKg = toNumber(formData.get("weightKg")) || store.goals.basisWeightKg || null;
        store.goals.protein = toNumber(formData.get("protein"));
        store.goals.carbs = toNumber(formData.get("carbs"));
        store.goals.fat = toNumber(formData.get("fat"));
        const waterL = toNumber(formData.get("waterL"));
        store.goals.waterMl = waterL > 0 ? Math.round(waterL * 1000) : suggestWaterMl(store.profile.weightKg);
        const stepsGoal = toNumber(formData.get("stepsGoal"));
        store.goals.stepsGoal = stepsGoal > 0 ? Math.round(stepsGoal) : 10000;
        // Nula je ispravna vrednost (red onda samo broji šoljice), pa se ne
        // sme pretvoriti u default — zato provera na prazno polje, ne na `> 0`.
        const coffeeKcalRaw = String(formData.get("coffeeKcal") || "").trim();
        store.goals.coffeeKcal = coffeeKcalRaw === ""
          ? COFFEE_KCAL_DEFAULT
          : Math.min(500, Math.max(0, Math.round(toNumber(coffeeKcalRaw))));
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

  // Menjanje datuma merenja prepisuje samo natpis sa ciljem — bez render(), da
  // se već popunjena forma ne resetuje ispod prstiju.
  if (target instanceof HTMLInputElement && target.id === "measurement-date") {
    const note = document.querySelector("#measurement-calorie-goal");
    if (note) {
      note.innerHTML = renderMeasurementGoalNote(target.value);
    }
    return;
  }

  if (target instanceof HTMLTextAreaElement && target.id === "quick-entry-input") {
    state.quickEntryText = target.value;
    state.quickEntryOverrides = {};
    const caret = target.selectionStart;
    render();
    // render() rebuilds the textarea, so put the caret back where it was.
    window.requestAnimationFrame(() => {
      const next = document.querySelector("#quick-entry-input");
      if (next) {
        next.focus();
        try {
          next.setSelectionRange(caret, caret);
        } catch (error) {
          /* older browsers: focus alone is enough */
        }
      }
    });
    return;
  }

  if (
    target instanceof HTMLInputElement &&
    ["goal-calories", "goal-protein", "goal-carbs", "goal-fat"].includes(target.id)
  ) {
    const holder = document.querySelector('[data-role="macro-check"]');
    if (holder) {
      const read = (id) => toNumber(document.querySelector(`#${id}`)?.value);
      holder.innerHTML = renderGoalMacroCheck({
        calories: read("goal-calories"),
        protein: read("goal-protein"),
        carbs: read("goal-carbs"),
        fat: read("goal-fat"),
      });
    }
    return;
  }

  if (target instanceof HTMLSelectElement && target.dataset.action === "set-quick-entry-food") {
    const index = Number(target.dataset.index);
    state.quickEntryOverrides[index] = { ...(state.quickEntryOverrides[index] || {}), foodId: target.value, amount: undefined };
    render();
    return;
  }

  if (target instanceof HTMLSelectElement && target.dataset.action === "set-quick-entry-meal") {
    const index = Number(target.dataset.index);
    state.quickEntryOverrides[index] = { ...(state.quickEntryOverrides[index] || {}), mealLabel: target.value };
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.dataset.action === "set-quick-entry-amount") {
    const index = Number(target.dataset.index);
    state.quickEntryOverrides[index] = { ...(state.quickEntryOverrides[index] || {}), amount: target.value };
    const rows = getQuickEntryRows();
    const row = rows[index];
    const totalsEl = target.closest(".quick-entry-row")?.querySelector(".quick-entry-row-totals");
    if (row && totalsEl) {
      totalsEl.textContent = `${roundValue(row.totals.kcal, 0)} kcal · P ${roundValue(row.totals.protein, 0)} · UH ${roundValue(row.totals.carbs, 0)} · M ${roundValue(row.totals.fat, 0)} g`;
    }
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "recipe-search") {
    state.recipeSearch = target.value;
    target.parentElement?.querySelector(".foods-search-clear")?.classList.toggle("is-hidden", !target.value);
    filterRecipeCardsInline(target.value);
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "food-search") {
    state.foodSearch = target.value;
    target.parentElement?.querySelector(".foods-search-clear")?.classList.toggle("is-hidden", !target.value);
    filterFoodsListInline(target.value);
    updateExternalFoodResults(target.value);
    return;
  }

  if (state.onboarding && (target.id === "ob-age" || target.id === "ob-height" || target.id === "ob-weight")) {
    if (target.id === "ob-age") state.onboarding.age = target.value;
    if (target.id === "ob-height") state.onboarding.heightCm = target.value;
    if (target.id === "ob-weight") state.onboarding.weightKg = target.value;
    syncOnboardingPreview();
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

  if (target instanceof HTMLInputElement && target.id === "favorite-image") {
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-servings") {
    state.favoriteDraft.servings = target.value;
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
    syncCompanionSuggestions();
    return;
  }

  // Only rendered for non-piece foods, showing the amount in whichever unit
  // (g/kašičica/kašika) is currently toggled — #grams stays the real-gram
  // hidden field the rest of the composer (preview, submit) reads from.
  if (target instanceof HTMLInputElement && target.id === "amount-input") {
    const unit = state.planDraft.amountUnit || "g";
    const grams = convertAmountUnitToGrams(target.value, unit);
    state.planDraft.grams = grams ? String(roundValue(grams, 0)) : "";
    const hiddenGrams = document.querySelector("#grams");
    if (hiddenGrams instanceof HTMLInputElement) {
      hiddenGrams.value = state.planDraft.grams;
    }
    syncEntryPreview();
    syncCompanionSuggestions();
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-grams") {
    state.favoriteDraft.grams = target.value;
    // Stavka koja se upravo sastavlja stoji u pregledu kao „nova stavka“, pa i
    // njena kilaža mora da pomeri brojke — isti razlog kao red iznad.
    syncRecipeDraftPreview();
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-food-search") {
    const previousFoodId = state.favoriteDraft.foodId;
    const selectedFood = resolveFoodFromQuery(target.value);
    state.favoriteDraft.foodId = selectedFood?.id || "";
    if (state.favoriteDraft.foodId !== previousFoodId) {
      state.favoriteDraft.amountUnit = "g";
    }
    if (selectedFood && !state.favoriteDraft.grams) {
      state.favoriteDraft.grams = String(getFoodServingBaseValue(selectedFood));
    }

    const hiddenInput = document.querySelector("#favorite-food-id");
    if (hiddenInput instanceof HTMLInputElement) {
      hiddenInput.value = state.favoriteDraft.foodId;
    }

    const amountField = document.querySelector("#favorite-amount-field");
    if (amountField) {
      amountField.innerHTML = renderFavoriteAmountFieldInner(selectedFood);
    }
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "favorite-amount-input") {
    const unit = state.favoriteDraft.amountUnit || "g";
    const grams = convertAmountUnitToGrams(target.value, unit);
    state.favoriteDraft.grams = grams ? String(roundValue(grams, 0)) : "";
    const hiddenGrams = document.querySelector("#favorite-grams");
    if (hiddenGrams instanceof HTMLInputElement) {
      hiddenGrams.value = state.favoriteDraft.grams;
    }
    return;
  }

  if (target instanceof HTMLTextAreaElement && target.id === "favorite-instructions") {
    state.favoriteDraft.instructions = target.value;
    return;
  }

  if (target instanceof HTMLSelectElement && target.id === "amount-unit-select") {
    const unit = String(target.value || "g");
    if (!AMOUNT_UNIT_FACTORS[unit] || unit === state.planDraft.amountUnit) {
      return;
    }
    state.planDraft.amountUnit = unit;
    const amountField = document.querySelector("#amount-field");
    if (amountField) {
      amountField.innerHTML = renderAmountFieldInner(getFoodById(state.planDraft.foodId));
    }
    syncEntryPreview();
    syncCompanionSuggestions();
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "food-search-input") {
    const previousFoodId = state.planDraft.foodId;
    // While typing, only an exact name counts as "picked" — picking from the
    // list (or Enter) fills the exact name. A fuzzy best-guess here made the
    // amount block pop in and out mid-word and could disagree with the list.
    const selectedFood = findFoodByExactName(target.value) || null;
    updateFoodSuggestions(target.value, selectedFood);
    state.planDraft.foodId = selectedFood?.id || "";
    if (state.planDraft.foodId !== previousFoodId) {
      // Switching food resets the unit — a spoon choice made for honey
      // shouldn't silently carry over to chicken breast.
      state.planDraft.amountUnit = "g";
    }

    const hiddenInput = document.querySelector("#foodId");
    if (hiddenInput instanceof HTMLInputElement) {
      hiddenInput.value = state.planDraft.foodId;
    }

    const matchContainer = document.querySelector("#food-match");
    if (matchContainer) {
      matchContainer.innerHTML = renderFoodMatchInner(selectedFood);
    }
    target.form?.classList.toggle("has-food", Boolean(selectedFood));

    if (selectedFood && !state.planDraft.grams) {
      state.planDraft.grams = String(quickAddGramsFor(selectedFood, store.foodUsage && store.foodUsage[selectedFood.id]));
    }

    // Piece vs. gram-based foods (and the spoon toggle, which only applies
    // to the latter) need different fields entirely, not just new label
    // text, so the whole amount field regenerates rather than patching
    // individual pieces of it.
    const amountField = document.querySelector("#amount-field");
    if (amountField) {
      amountField.innerHTML = renderAmountFieldInner(selectedFood);
    }

    syncEntryPreview();
    syncCompanionSuggestions();
    return;
  }

  if (target instanceof HTMLSelectElement && target.dataset.recipeDraftItemFoodId) {
    const itemId = String(target.dataset.recipeDraftItemFoodId || "").trim();
    const food = getFoodById(target.value);
    state.favoriteDraft.items = (state.favoriteDraft.items || []).map((item) =>
      item.id === itemId
        ? {
            ...item,
            foodId: target.value,
            foodName: food?.name || item.foodName,
          }
        : item
    );
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.dataset.recipeDraftItemGrams) {
    const itemId = String(target.dataset.recipeDraftItemGrams || "").trim();
    state.favoriteDraft.items = (state.favoriteDraft.items || []).map((item) =>
      item.id === itemId
        ? {
            ...item,
            grams: target.value,
          }
        : item
    );
    syncRecipeDraftPreview();
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
    const file = target.files[0];
    try {
      const parsed = JSON.parse(await file.text());
      if (!looksLikeBackupSnapshot(parsed)) {
        showFeedbackToast({
          title: "Ovo nije Fit Tracker backup",
          detail: "Fajl je JSON, ali nema podatke koje app izvozi (namirnice, plan, ciljeve...). Ništa nije promenjeno.",
          tone: "error",
          duration: 4200,
        });
        target.value = "";
        return;
      }
      const confirmed = window.confirm(
        `Uvezi backup "${file.name}"?\n\nOvo ZAMENJUJE sve trenutne podatke na nalogu ${state.authUser?.email || ""} sadržajem fajla i upisuje ih u cloud. Ne može da se poništi — ako nisi siguran, otkaži pa prvo izvezi trenutni backup.`
      );
      if (!confirmed) {
        target.value = "";
        return;
      }
      replaceStore(parsed);
      // Move any imported photo blobs into IndexedDB before persist, so they
      // don't bloat (or overflow) the localStorage snapshot.
      await reconcilePhotos();
      persist();
      render();
      showFeedbackToast({ title: "Backup je uspešno uvezen", detail: "Podaci iz fajla su sada učitani u app." });
    } catch (error) {
      showFeedbackToast({ title: "Backup nije validan", detail: "Izabrani fajl nije ispravan JSON backup.", tone: "error" });
    }
    target.value = "";
    return;
  }

  if (target.id === "favorite-image") {
    const file = target.files[0];
    if (!file) {
      return;
    }

    createOptimizedPhoto(file)
      .then((optimized) => {
        state.favoriteDraft.imageUrl = optimized.previewUrl;
        render();
      })
      .catch(() => {
        showFeedbackToast({
          title: "Slika nije učitana",
          detail: "Probaj ponovo sa drugim JPG ili PNG fajlom.",
          tone: "error",
        });
      })
      .finally(() => {
        target.value = "";
      });
    return;
  }

  if (target.id !== "nutrition-import-files") {
    return;
  }

  const files = [...target.files];
  state.nutritionImportPending = true;
  state.nutritionImportStatus =
    files.length === 1 ? `Obrađujem "${files[0].name}"...` : `Obrađujem ${files.length} ${srPlural(files.length, "dokument", "dokumenta", "dokumenata")}...`;
  render();

  try {
    const result = await importNutritionFiles(files);
    persist();
    showFeedbackToast({
      title: result.importedDocuments.length ? "Dokumenti su uvezeni" : "Import je završen",
      detail: `${result.importedDocuments.length} dok. · ${result.totalRecommendations} preporuka · ${result.totalRecipes} recepata · ${result.totalFoods} namirnica${
        result.errors.length ? ` · ${result.errors.length} ${srPlural(result.errors.length, "greška", "greške", "grešaka")}` : ""
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
// <details> toggles don't bubble; capture on document so a manual open/close of
// the progress section survives the next render instead of snapping back.
document.addEventListener(
  "toggle",
  (event) => {
    if (event.target && event.target.id === "training-progress-details") {
      state.trainingProgressOpen = event.target.open;
    }
  },
  true
);
document.addEventListener("input", handleValidationInteraction, true);
document.addEventListener("change", handleValidationInteraction, true);
document.addEventListener("invalid", handleInvalidField, true);
document.addEventListener("change", handleImport);

// If the app was left open across a day/week boundary (installed PWAs stay
// resident for days), re-point the selected day + week track at today and roll
// the week over (clear last week's completion marks) the next time it returns
// to the foreground. Without the re-point, a Sunday-night → Monday-morning
// return left the user checking off "sledeća nedelja" until a reload.
let lastForegroundDateValue = getTodayDateValue();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushPendingCloudSave();
    return;
  }
  if (document.visibilityState !== "visible" || !state.authUser || !state.authReady) {
    return;
  }
  retryCloudSync();
  let changed = false;
  const today = getTodayDateValue();
  if (today !== lastForegroundDateValue) {
    lastForegroundDateValue = today;
    state.selectedWeekday = getTodayWeekday();
    state.selectedWeekTrack = getCurrentWeekTrack();
    changed = true;
  }
  if (ensureCurrentWeek()) {
    persist();
    changed = true;
  }
  if (changed) {
    render();
  }
});
window.addEventListener("pagehide", flushPendingCloudSave);

// Swipe right on a meal card's header (touch devices) to toggle "pojedeno" —
// the same checkbox the tap uses, so all bookkeeping stays in one place.
(() => {
  if (typeof window === "undefined" || !("ontouchstart" in window)) {
    return;
  }
  const SWIPE_ENGAGE = 12;
  const SWIPE_COMMIT = 72;
  const SWIPE_MAX = 96;
  let swipe = null;
  const clear = (animate) => {
    if (!swipe) {
      return;
    }
    const { card, header } = swipe;
    card.classList.remove("is-swiping");
    header.style.transform = "";
    card.style.setProperty("--swipe-x", "0px");
    card.style.setProperty("--swipe-o", "0");
    if (!animate) {
      card.classList.add("is-swipe-reset");
      window.requestAnimationFrame(() => card.classList.remove("is-swipe-reset"));
    }
    swipe = null;
  };
  document.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) {
        return;
      }
      const header = event.target instanceof Element ? event.target.closest(".meal-card-header") : null;
      const card = header?.closest(".meal-card");
      const checkbox = card?.querySelector(".meal-toggle-checkbox");
      if (!header || !card || !(checkbox instanceof HTMLInputElement) || card.classList.contains("is-editing")) {
        return;
      }
      if (event.target instanceof Element && event.target.closest("button, input, label, a")) {
        return;
      }
      const touch = event.touches[0];
      swipe = { card, header, checkbox, startX: touch.clientX, startY: touch.clientY, engaged: false, cancelled: false, dx: 0 };
      const reveal = card.querySelector(".meal-swipe-reveal");
      if (reveal) {
        reveal.style.height = `${header.offsetHeight}px`;
        reveal.textContent = checkbox.checked ? "Vrati" : "Pojedeno";
      }
    },
    { passive: true }
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!swipe || swipe.cancelled) {
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - swipe.startX;
      const dy = touch.clientY - swipe.startY;
      if (!swipe.engaged) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          swipe.cancelled = true;
          return;
        }
        if (dx > SWIPE_ENGAGE && Math.abs(dx) > Math.abs(dy)) {
          swipe.engaged = true;
          swipe.card.classList.add("is-swiping");
        } else {
          return;
        }
      }
      const shift = Math.max(0, Math.min(SWIPE_MAX, dx));
      swipe.dx = shift;
      swipe.header.style.transform = `translateX(${shift}px)`;
      swipe.card.style.setProperty("--swipe-x", `${shift}px`);
      swipe.card.style.setProperty("--swipe-o", String(Math.min(1, shift / SWIPE_COMMIT)));
      swipe.card.classList.toggle("is-swipe-ready", shift >= SWIPE_COMMIT);
    },
    { passive: true }
  );
  const finish = () => {
    if (!swipe) {
      return;
    }
    const commit = swipe.engaged && swipe.dx >= SWIPE_COMMIT;
    const { checkbox, card } = swipe;
    card.classList.remove("is-swipe-ready");
    clear(true);
    if (commit) {
      checkbox.click();
    }
  };
  document.addEventListener("touchend", finish, { passive: true });
  document.addEventListener("touchcancel", () => clear(false), { passive: true });
})();

// Plan composer suggestions: arrows move, Enter picks, Escape closes; the list
// hides when focus leaves the field (a tap on an item keeps the field focused).
document.addEventListener("keydown", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.id !== "food-search-input") {
    return;
  }
  const list = document.querySelector("#food-suggest");
  if (!list || list.hidden) {
    return;
  }
  const items = [...list.querySelectorAll(".food-suggest-item")];
  if (!items.length) {
    return;
  }
  const activeIndex = items.findIndex((item) => item.classList.contains("is-active"));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = event.key === "ArrowDown" ? Math.min(items.length - 1, activeIndex + 1) : Math.max(0, activeIndex - 1);
    items.forEach((item, index) => {
      item.classList.toggle("is-active", index === next);
      item.setAttribute("aria-selected", String(index === next));
    });
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    (items[activeIndex] || items[0]).click();
    return;
  }
  if (event.key === "Escape") {
    event.stopImmediatePropagation();
    list.hidden = true;
  }
});
document.addEventListener("mousedown", (event) => {
  if (event.target instanceof Element && event.target.closest(".food-suggest-item, .food-suggest-add")) {
    event.preventDefault();
  }
});
document.addEventListener("focusin", (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.id === "food-search-input") {
    updateFoodSuggestions(input.value, input.value ? resolveFoodFromQuery(input.value) : null);
  }
});
document.addEventListener("focusout", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.id !== "food-search-input") {
    return;
  }
  window.setTimeout(() => {
    const list = document.querySelector("#food-suggest");
    if (list && !list.contains(document.activeElement) && document.activeElement !== input) {
      list.hidden = true;
    }
  }, 120);
});

// ---------------------------------------------------------------------------
// Modal focus. Every dialog carried role="dialog" aria-modal="true" but nothing
// enforced it: opening one left focus on <body>, and Tab walked straight out
// into the ~180 focusable elements of the page behind. These three pieces make
// aria-modal true in practice — focus moves in, Tab cycles inside, and closing
// hands focus back to whatever opened it.
// ---------------------------------------------------------------------------
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

// Same precedence the Escape handler uses, so "top-most" means one thing.
function getOpenDialogElement() {
  const selector = state.scannerOpen
    ? ".scanner-dialog"
    : state.quickEntryOpen
      ? ".quick-entry-dialog"
      : state.foodEditorOpen
        ? ".food-editor-dialog"
        : state.recipeApplyDialog && state.recipeApplyDialog.favoriteId
          ? ".recipe-apply-dialog"
          : "";
  return selector ? document.querySelector(selector) : null;
}

function getDialogFocusables(dialog) {
  return [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

// Remembered as a selector, not a node: render() replaces the DOM wholesale, so
// the element that opened the dialog is gone by the time it closes.
let dialogReturnFocusSelector = "";

function rememberDialogTrigger(actionTarget) {
  const action = actionTarget && actionTarget.dataset ? actionTarget.dataset.action : "";
  dialogReturnFocusSelector = action ? `[data-action="${action}"]` : "";
}

function restoreFocusAfterDialog() {
  if (!dialogReturnFocusSelector) {
    return;
  }
  // The same action often has two triggers — a phone FAB and a desktop button —
  // and only one of them is on screen. Focusing the hidden one silently does
  // nothing and leaves focus on <body>.
  const target = [...document.querySelectorAll(dialogReturnFocusSelector)].find((el) => el.offsetParent !== null);
  dialogReturnFocusSelector = "";
  if (target) {
    target.focus();
  }
}

// Called at the end of render(): if a dialog is open and focus is not inside
// it, pull focus in — preferring the first text field, which is what the user
// came to type into. Focus is set synchronously on purpose: the first version
// deferred it to requestAnimationFrame and the callback did not reliably run,
// so the dialog opened with focus still on <body>. The DOM is already in place
// by the end of render(), so there is nothing to wait for.
function syncDialogFocus() {
  const dialog = getOpenDialogElement();
  if (!dialog) {
    return;
  }
  if (dialog.contains(document.activeElement)) {
    return;
  }
  const focusables = getDialogFocusables(dialog);
  const preferred =
    focusables.find((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || focusables[0];
  if (preferred) {
    preferred.focus();
  } else {
    dialog.setAttribute("tabindex", "-1");
    dialog.focus();
  }
}

// Tab cycles inside the open dialog instead of escaping behind it.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") {
    return;
  }
  const dialog = getOpenDialogElement();
  if (!dialog) {
    return;
  }
  const focusables = getDialogFocusables(dialog);
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
});

// Escape closes the top-most open overlay, reusing its existing close handler
// (so e.g. the scanner camera is properly stopped).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  const closeSelector = state.scannerOpen
    ? '[data-action="close-scanner"]'
    : state.quickEntryOpen
      ? '[data-action="close-quick-entry"]'
      : state.foodEditorOpen
      ? '[data-action="close-food-editor-dialog"]'
      : state.recipeApplyDialog && state.recipeApplyDialog.favoriteId
        ? '[data-action="close-recipe-apply-dialog"]'
        : state.navMenuOpen
          ? '[data-action="close-nav-menu"]'
          : null;
  if (!closeSelector) {
    return;
  }
  const closeButton = document.querySelector(closeSelector);
  if (closeButton) {
    event.preventDefault();
    closeButton.click();
  }
});

window.addEventListener("hashchange", () => {
  // Prečica koja "Open URL"-uje dok je app već otvoren stigne kao hashchange.
  if (consumeImportFromUrl()) {
    render();
    return;
  }
  const nextTab = getInitialTab();
  if (nextTab !== state.activeTab) {
    if (state.scannerOpen) {
      stopBarcodeScan();
      state.scannerOpen = false;
    }
    state.activeTab = nextTab;
    state.navMenuOpen = false;
    resetFoodEditing();
    resetRoutineEditing();
    render();
  }
});

// Live connection status → offline banner. Transitions are rare, so a full
// re-render here is fine.
function handleConnectionChange() {
  const online = navigator.onLine !== false;
  if (online !== state.isOnline) {
    state.isOnline = online;
    render();
  }
  if (online) {
    retryCloudSync();
  }
}
window.addEventListener("online", handleConnectionChange);
window.addEventListener("offline", handleConnectionChange);

window.addEventListener("scroll", updateHeroScrollState, { passive: true });

// The barcode scanner lib (ZXing, ~hundreds of KB from a CDN) is never loaded on
// launch: it warms up 1.5 s after a scan button is on screen (see
// schedulePreloadBarcodeReader) so the first tap still opens the camera inside
// the user gesture on iOS.

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
  // Cloud hydrate rebuilds progressPhotos from the (now blob-free) localStorage
  // snapshot, so stitch the IDB blobs back on / migrate any that aren't there yet.
  await reconcilePhotos();
  if (isDemoAccount() && mirrorSingleTrackPlan(store)) {
    persist();
  }
  if (ensureCurrentWeek()) {
    persist();
  }
  state.authReady = true;
  // Cold-start preko deep-linka iz Prečice (#import-run / #import-activity).
  consumeImportFromUrl();
  render();
});

render();
// Migrate legacy photos out of the localStorage blob into IndexedDB and stitch
// stored blobs back onto loaded records (covers the signed-out / local-only case;
// the signed-in case is handled after cloud hydrate above).
reconcilePhotos();

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
      reloadForUpdate();
    });
  });
}
