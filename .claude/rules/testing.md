# Kural — Test ve Kapılar

Kaynak-of-truth: `docs/TEST_STRATEGY.md`.
Bu dosya çalışma anındaki kontrol listesidir; fixture listesini burada **yeniden yazma**.

## Pazarlık dışı

- **Test/strictness/policy zayıflatılarak gate geçilemez.**
- Test silme, `skip`/`only`, `|| true`, sessiz fallback, yalnız yeşil görünmek için mock **yasak**.
- **Çalıştırılmayan veya skipped test PASS sayılmaz.**
- Unsupported fork/fingerprint'te sonuç **`UNKNOWN` olmalı, yanlış PASS değil** — bu test edilen
  bir davranıştır.
- TypeScript strictness (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
  düşürülemez; `@ts-ignore`/`@ts-expect-error` gerekçesiz eklenemez.

## Her kural için

En az **bir pozitif ve bir negatif** fixture zorunludur. En kritik metrik **false negative**'dir;
canonical fixture'larda hedef **sıfır**.

## Doğrulama sırası

1. Hedefli kontroller (o milestone'un testleri)
2. Repository'de mevcutsa cumulative `pnpm run verify`
3. `git diff --check` ve scope dışı değişiklik kontrolü

Bu sıra atlanamaz; cumulative kapı gerçekten çalıştırılmadan `GATE: PASS` verilemez.

## Determinizm

- Saf çekirdekte (`domain`, `invariant-core`, `state-machine`) wall-clock ve randomness **yok**;
  testler bu yüzden zamana bağlı flake üretmemeli.
- Aynı pinned bloklar + aynı rule version → **aynı evidence hash**.
- Olay replay sırası değişse **idempotent** son state.

## Bu milestone'da

Test altyapısı henüz yoktur (Milestone 02). `pnpm run verify` mevcut değildir.
Var olan tek çalıştırılabilir kapı: `pnpm run verify:config`.
