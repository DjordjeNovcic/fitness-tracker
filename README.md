# fitness-tracker

Mobilna PWA aplikacija za jelovnik, kalorije i trening, napravljena iz Excel workbook-a `Jelovnik i kalorije - unapredjeno.xlsx`.

## Sta je spremno

- `Plan`: nedeljni jelovnik po danima sa automatskim racunanjem kalorija i makroa po unetoj gramazi, plus preview dana, edit stavki, omiljene namirnice, dupliranje dana i predlozi obroka/dana
- `Obroci`: poseban tab za sastavljene omiljene obroke/recepte, sa dodavanjem vise stavki, izmenom stavki i ubacivanjem celog obroka ili jedne namirnice u izabrani dan
- `Namirnice`: baza iz Excel-a sa 86 seed namirnica, filterima po `Proteini/UH/Masti` i formom za dodavanje novih na 100 g
- `Trening`: nedeljni plan po danima, unos potrosenih kcal sa Apple Watch-a, log kilaze po vezbi sa pregledom napretka i kratke beleske
- `Napredak`: tezina, obimi, trend grafikoni, istorija merenja, progress slike sa tagovima `front/side/back` i side-by-side poredjenje po istom tagu
- `Ciljevi`: tezina, makroi, kalorije, nedeljni pregled po danima, weekly plan-vs-target pregled za kalorije i makroe i JSON backup
- `PWA`: manifest i service worker za GitHub Pages / home screen instalaciju
- `Firebase`: prijava preko `Email/Password` i cloud sync kroz `Authentication + Firestore` za plan, namirnice, obroke, trening, merenja i ciljeve

## Pokretanje lokalno

1. Izvuci seed podatke iz workbook-a:

```bash
python3 scripts/extract_workbook.py
```

2. Pokreni staticki server iz root-a projekta:

```bash
python3 -m http.server 4173
```

3. Otvori [http://localhost:4173](http://localhost:4173)

## GitHub Pages

Workflow za GitHub Pages je dodat u `.github/workflows/deploy-pages.yml`.

Da bi app bila online:

1. Push-uj promene na `main`
2. Na GitHub repo-u idi na `Settings` → `Pages`
3. Pod `Build and deployment` izaberi `GitHub Actions`
4. Sacekaj da `Deploy GitHub Pages` workflow prodje

Posle toga app ce biti dostupna na GitHub Pages URL-u tvog repoa.

## Napomena

- Glavni podaci se sada cuvaju i u `Firebase Firestore`, vezani za tvoj nalog.
- `Progress slike` se za sada i dalje cuvaju lokalno u browseru/telefonu, dok ne dodamo `Firebase Storage`.
- `JSON backup` i dalje ima smisla kao dodatna sigurnost.
