---
description: Bir milestone promptunu sözleşmeye uygun yürüt ve GATE raporuyla dur
---

Bu repository milestone promptlarıyla yürütülür. `$ARGUMENTS` ile verilen milestone için:

## 1. Ön koşul

- Çalışma dizininin proje kökü olduğunu doğrula.
- `git status --short` ve `git diff` ile **baseline'ı kaydet**.
- `CLAUDE.md` ve milestone'un adı geçen kaynaklarını oku.
- Bir önceki `docs/milestones/NN.md` raporunda `GATE: PASS` yoksa **hiçbir dosya oluşturma**;
  blocker'ı raporla ve dur.
- `docs/PROTOCOL_SOURCE_LOCK.md` §10 gereği ACP-194/Helicon durumunu yeniden kontrol et.

## 2. Kapsam

- Write scope = **yalnız** o milestone'un açıkça saydığı teslimler + onları bağlayan
  en dar config/test/doc değişikliği.
- Başka milestone'a ait dosya gerekiyorsa kapsamı **büyütme** → `GATE: BLOCKED`.
- Mevcut kullanıcı değişikliklerini koru; overwrite / otomatik rollback / toplu rewrite **yok**.

## 3. Yasaklar

- `git add/commit/push/pull/fetch/merge/rebase/checkout/switch/reset/restore/clean/stash`,
  branch, tag, PR, release, publish, deploy — kullanıcı **o an açıkça istemedikçe** yasak.
- `sudo`, global install, `curl | sh`, uzaktan kod çalıştıran `npx/pnpx`, force flag,
  destructive delete yasak.
- Subagent, background task, watch mode, uzun yaşayan server başlatma yok.
- Test silme/skip, strictness düşürme, `|| true`, sessiz fallback, sahte mock yasak.

## 4. Doğrulama

Önce hedefli kontroller, sonra repository'de mevcutsa cumulative `pnpm run verify`.
**Gerçekten çalıştır.** Çalıştırılmayan veya skipped test PASS sayılamaz.
`git diff --check` ve scope dışı değişiklik kontrolü yap.

## 5. Rapor

`docs/milestones/NN.md` dosyasına yaz ve terminalde şu alanları sırayla ver:

`MILESTONE`, `GATE`, `BASELINE`, `CHANGED`, `VERIFICATION` (exact command/exit),
`ACCEPTANCE` (tek tek PASS/FAIL), `DECISIONS`, `OPEN_RISKS`, `SAFETY`, `BLOCKER`,
`NEXT`, `STOPPED: yes`.

Yalnız `GATE: PASS` veya `GATE: BLOCKED` geçerlidir. **Sonraki milestone'a başlama.**
