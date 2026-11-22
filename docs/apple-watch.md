# Apple Watch → Fit Tracker (automatski, npr. na svakih pola sata)

iPhone Prečica (Shortcuts) sama pročita Apple Health (koraci, aktivne kcal,
san, težina) i pošalje ih GitHub-u, koliko god često podesiš. GitHub ih
upiše u tvoj nalog, a aplikacija ih preuzme čim je otvoriš (i na 5 min dok
je otvorena). Jednom dnevno uveče stigne i Telegram poruka, npr. „⌚ Sat →
Fit Tracker (22.11.): 8.432 koraka, 523 kcal aktivnosti, 7,3 h sna“.

Podaci sa sata idu u poseban dokument, pa slanje na pola sata ne smeta dok
koristiš aplikaciju (nema „Izmene sa drugog uređaja“).

Šta gde ide u aplikaciji:
- **koraci** → Danas, Koraci
- **aktivne kcal (Move)** → kalorije treninga za taj dan, ulazi u neto. Ako
  za taj dan upišeš kalorije po sekcijama u Treningu, važi taj zbir.
- **san** → Danas, San (sati)
- **težina** → merenje tog dana, ako ga već nisi upisao ručno

## 1. GitHub: dodaj posao „Sat (Apple Health)“ (jednom)

Fajl `.github/workflows/health-sync.yml` dodaj preko GitHub sajta, isto kao
za Telegram: **Add file → Upload files**, u folder `.github/workflows`.
Tajne već postoje (iste kao za Telegram bota).

Proba: **Actions → Sat (Apple Health) → Run workflow**. Za minut na Telegram
stiže poruka sa probnim brojevima (1.234 koraka, 321 kcal, 7,5 h sna). Ti
brojevi se upišu za danas, a prvo pravo slanje sa sata ih pregazi.

## 2. GitHub token za Prečicu (jednom)

github.com → slika gore desno → **Settings → Developer settings →
Personal access tokens → Fine-grained tokens → Generate new token**:
- Token name: `Fit Tracker sat`
- Expiration: 1 godina (posle napraviš novi)
- Repository access: **Only select repositories → fitness-tracker**
- Permissions → Repository permissions → **Contents: Read and write**
  (GitHub to traži za ovakvo pokretanje)

**Generate token**, pa ga kopiraj. Token stavljaš **samo** u Prečicu (korak
3). Ne šalji ga nikome i ne stavljaj u kod: njime može da se menja ceo repo.

## 3. Prečica na iPhone-u

**Shortcuts → + (nova prečica)**, ime npr. „Sat u Fit Tracker“. Dodaj redom:

1. **Find Health Samples** → Type: **Steps**, Start Date: **is today**.
   Pa **Calculate Statistics** → **Sum** (od Health Samples).
2. **Find Health Samples** → Type: **Active Energy**, Start Date: **is
   today**. Pa **Calculate Statistics** → **Sum**.
3. (san, opciono) **Find Health Samples** → Type: **Sleep Analysis**, Start
   Date: **is in the last 1 days**, Value: **is not In Bed** (i ako ima,
   **is not Awake**). Pa **Get Details of Health Samples → Duration**, pa
   **Calculate Statistics → Sum**. Sati, minuti ili sekunde, skripta sama
   prepozna.
4. (težina, opciono) **Find Health Samples** → Type: **Weight**, Sort by:
   **Start Date**, Order: **Latest First**, Limit: **1**.
5. **Get Contents of URL**:
   - URL: `https://api.github.com/repos/DjordjeNovcic/fitness-tracker/dispatches`
   - Method: **POST**
   - Headers:
     - `Authorization` = `Bearer ` + tvoj token (reč Bearer, razmak, token)
     - `Accept` = `application/vnd.github+json`
   - Request Body: **JSON**
     - `event_type` (Text) = `health`
     - `client_payload` (Dictionary):
       - `steps` = rezultat koraka 1 (Statistics)
       - `move` = rezultat koraka 2
       - `sleep` = rezultat koraka 3
       - `weight` = rezultat koraka 4

   Vrednosti biraš tapom na polje → **Select Variable**. Polja koja nemaš
   samo izostavi.

Pokreni prečicu jednom ručno (▶). Za minut-dva stiže poruka na Telegram.
Ako ne stigne, pogledaj **Actions → Sat (Apple Health)** na GitHub-u: tamo
piše šta je stiglo i šta fali.

## 4. Neka radi sama (npr. na svakih pola sata)

iPhone nema okidač „na svakih 30 min“, samo „u određeno vreme“. Zato se
pravi jedna automatizacija po vremenu, sve sa istom prečicom:

Shortcuts → **Automation → + → Time of Day** → npr. **08:00**, **Daily** →
**Run Immediately** (isključi „Notify When Run“) → izaberi „Sat u Fit
Tracker“. Ponovi za 08:30, 09:00 … 23:00.

Pola sata od 8 do 23h je 31 automatizacija (desetak minuta kliktanja,
jednom). Ako ti je to mnogo, na sat je 16, a na dva sata 8. Svako slanje
samo prepiše podatke tog dana, ne pravi duplikate. Poslednje slanje uveče
(posle 21h) je ono koje javi na Telegram.

Dodatni okidači koji pomažu (opciono): **App → Fit Tracker (Safari) → Is
Opened**, pa su podaci sveži čim otvoriš aplikaciju; ili **Apple Watch
Workout → Ends**, pa kalorije treninga stignu odmah posle treninga.

## Kad je aplikacija otvorena

Podaci sa sata se preuzmu pri otvaranju, pri povratku u aplikaciju i na
svakih 5 minuta dok je otvorena. Kad se vratiš u aplikaciju, sama povuče i
novije izmene sa drugog uređaja (telefon/drugi tab), ako na ovom nisi
ništa menjao.

## Gašenje

Obriši automatizaciju u Shortcuts, ili na GitHub-u: Actions → Sat (Apple
Health) → ⋯ → **Disable workflow**. Token možeš i da obrišeš (GitHub →
Settings → Developer settings).
