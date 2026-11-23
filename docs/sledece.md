# Sledeće (plan dogovoren 23. 11. 2026)

## 1. Grupe i nedeljna lista (sutra)

Cilj: podstrek među prijateljima, bez nagrađivanja nezdravog mršavljenja.

- **Zatvorene grupe sa pozivnim kodom** (ekipa, teretana, firma), ne globalna lista.
- **Učešće samo ako se korisnik sam uključi** (podrazumevano isključeno). Prikazuje se nadimak, nikad email ni kilogrami.
- **Nedeljna lista po doslednosti:** dani na kalorijskom cilju (0–7) + urađeni od planiranih treninga.
- Kasnije: napredak ka sopstvenom cilju u % (radi i za mršavljenje, masu i održavanje), nizovi (upisani dani, km trčanja).
- **Ne rangirati po izgubljenim kilogramima.** Tempo brži od ~1 % telesne težine nedeljno ne donosi više bodova.
- Tehnički: zajednička Firestore kolekcija, pravila da svako upisuje samo svoj rezultat; bodove idealno računa server (Firebase funkcija → Blaze plan, isto kao podsetnici).

## 2. Otvoreno

- Podsetnici: Firebase Blaze (ili postojeći Telegram podsetnici).
- Redizajn ostalih ekrana (Trening, Hrana, Napredak) u stilu nove Danas.
- Vežba disanja: pravi snimci udaha i izdaha ako sintetisani zvuk ne zvuči prirodno.
