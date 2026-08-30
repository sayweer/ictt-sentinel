---
description: Repository kalite ve güvenlik kapılarını gerçekten çalıştır, sonucu dürüstçe raporla
---

Mevcut kapıları **gerçekten çalıştır**. Çıktı uydurma, exit code'u olduğu gibi raporla.

## 1. Config kapısı (her zaman mevcut)

```
pnpm run verify:config
```

Bu kapı şunları denetler: tüm JSON dosyalarının parse edilmesi; `.claude/settings.json`
güvenlik invariant'ları (bypass kapalı, geniş allow yok, `$schema` doğru); `.env.example` ile
gerçek env deny kurallarının **çakışmaması**; workspace glob ↔ paket adı tutarlılığı;
canonical naming (`@ictt-sentinel/*`, `ictt-sentinel`, `ICTT_SENTINEL_`); katman
bağımlılık yönü ve döngüsüzlük.

## 2. Toolchain kapıları (Milestone 02'den itibaren)

Aşağıdakiler **repository'de tanımlıysa** çalıştır; yoksa "mevcut değil" diye raporla,
uydurma:

```
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run verify
```

## 3. Git hijyeni

```
git diff --check
git status --short
```

Scope dışı değişiklik var mı kontrol et.

## 4. Raporlama kuralları

- Her komut için **exact command + exit code** ver.
- Bir kapı **yoksa** "tanımlı değil" yaz; geçti sayma.
- Bir kapı **başarısızsa** çıktıyı göster; `|| true`, skip veya strictness düşürerek geçme.
- Kısmi başarıyı tam başarı gibi sunma.
