# Telegram podsetnici za obroke

Kad dođe vreme obroka iz **Ciljevi → Satnica obroka**, bot ti pošalje poruku sa
stavkama tog obroka za danas (kcal, makroi, beleška, zamena tipa „ili 6 Tonus“).
Radi preko GitHub Actions (`.github/workflows/telegram-reminders.yml`), svakih
10 minuta. Server nije potreban i besplatno je.

Podsetnik ne stiže za prazan obrok ni za obrok koji je već čekiran kao pojeden.
GitHub ume da zakasni 5–20 minuta, pa podsetnik ponekad stigne malo posle
zadatog vremena. Ako želiš da stigne na vreme, upiši vreme 10–15 minuta ranije.

## Podešavanje (jednom, oko 10 minuta)

Sve tajne se upisuju u GitHub repo: **Settings → Secrets and variables →
Actions → New repository secret**. Nikad ih ne stavljaj u kod.

1. **Napravi bota.** U Telegramu otvori `@BotFather`, pošalji `/newbot`, daj
   mu ime (npr. „Fit Tracker“) i korisničko ime koje se završava na `bot`.
   Dobićeš token.
   → secret `TELEGRAM_BOT_TOKEN`
2. **Pošalji svom botu `/start`** (pronađi ga po korisničkom imenu).
3. **Saznaj svoj chat id.** U GitHubu otvori **Actions → Telegram podsetnici →
   Run workflow**. U logu koraka „Send reminders“ piše `chat id: 123456789`.
   → secret `TELEGRAM_CHAT_ID`
4. **Ključ za Firebase.** Firebase konzola → projekat `fitness-tracker-c90f7`
   → ⚙️ Project settings → **Service accounts** → **Generate new private
   key**. Preuzmeš JSON fajl, pa ceo njegov sadržaj nalepiš kao secret.
   → secret `FIREBASE_SERVICE_ACCOUNT`
   (Ovaj ključ daje pun pristup bazi. Drži ga samo u GitHub secrets, a
   preuzeti fajl posle obriši.)
5. **Tvoj uid.** Firebase konzola → **Authentication → Users**, pa kopiraj
   „User UID“ pored svog mejla.
   → secret `FIREBASE_UID`
6. **Probaj.** Actions → Telegram podsetnici → **Run workflow** (ostavi
   „Pošalji test poruku“ čekirano). Stiže „✅ Bot radi“ sa primerom podsetnika.

## Satnica i vrste podsetnika

U aplikaciji: **Ciljevi → Obaveštenja**. Tu biraš:
- **Obroci**: u vreme obroka (ili 10–60 min ranije) stiže šta je u planu.
- **Voda**: od–do, na 1–3 h; „popij vode“ stiže samo kad kasniš za ciljem.
- **Trening**: ujutru „danas imaš trening“, samo za dane sa treningom.
- **Rezime dana**: uveče pojedeno naspram cilja, makroi, voda i koraci.

Satnica obroka je na istoj stranici. Upiši vreme za svaki obrok, npr.
Doručak 08:00, Prva užina 10:30, Ručak 13:30, Druga užina 16:30, Večera 19:30.
Vreme se vidi i uz naziv obroka na Danas. Svaku vrstu podsetnika gasiš
njenim prekidačem, bez diranja GitHub-a.

## Gašenje

Isključi prekidač u aplikaciji, ili u GitHubu: Actions → Telegram podsetnici →
⋯ → **Disable workflow**.
