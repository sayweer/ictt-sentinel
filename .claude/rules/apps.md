# Kural — Uygulama ve Paket Sınırları

Kaynak-of-truth: `docs/ARCHITECTURE.md` ve `README.md` klasör sorumluluk tablosu.

## Katmanlar — bağımlılık yalnız içe doğru

| Katman | Paketler | Kısıt |
|---|---|---|
| 0 — saf çekirdek | `domain`, `invariant-core`, `state-machine` | Ağ, DB, `process.env`, framework, wall-clock, randomness **import edilemez** |
| 1 — saf destek | `config`, `evidence`, `testkit` | I/O yok; `config` `process.env`'i **kendisi okumaz**, girdi enjekte edilir |
| 2 — adapter (I/O sınırı) | `rpc-quorum`, `ictt-adapters`, `storage-postgres`, `replay`, `alerts` | Tüm ağ/DB/dosya erişimi burada |
| 3 — uygulama | `apps/cli`, `apps/agent`, `apps/api`, `apps/console` | Yalnız orchestration |

- Bir paket **yalnız kendinden düşük katmana** bağımlı olabilir.
- İzin verilen kenarlar her `package.json` içinde `ictt-sentinel.mayDependOn` alanında
  makine-okunur biçimde durur ve `pnpm run verify:config` ile denetlenir.
- **Apps business rule kopyalamaz.** Kural `invariant-core`'da yaşar; app onu çağırır.
- Döngüsel bağımlılık yasak.

## `packages/config` ile kök `config/` karıştırılmaz

- `packages/config` = **kod**: manifest/policy şeması ve doğrulaması (`@ictt-sentinel/config`).
- Kök `config/` = **veri**: operatörün deployment manifestleri (`config/deployments/`) ve
  policy dosyaları (`config/policies/`).

## Bu milestone'da

- Ürün davranışı, RPC adapter'ı, invariant veya veritabanı mantığı **yazılmaz**.
- Placeholder komut, sahte çalışan CLI veya mock ürün davranışı **yazılmaz**.
- `exports` alanları `./src/index.ts`'i işaret eden **taslaktır**; kaynak dosyalar sonraki
  milestone'larda gelir.
- Runtime dependency **eklenmez**.
