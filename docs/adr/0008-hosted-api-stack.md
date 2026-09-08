# ADR-0008 — Hosted evidence API stack

- **Durum:** `ACCEPTED`
- **Tarih:** 2026-09-08
- **Milestone:** 12
- **İlgili:** ADR-0001 (keyless read-only), ADR-0005 (toolchain), `docs/SECURITY.md`

## Bağlam

Milestone 12 opsiyonel bir **hosted evidence plane** istiyor: readiness, deployment okuma,
verdict/message timeline, evidence metadata/indirme ve local agent'tan **idempotent ingest**.

`docs/ARCHITECTURE.md` §6 MVP teknoloji seçiminde "Fastify API" diyor. Prompt de ilk seçenek
olarak Fastify'ı adlandırıyor.

Karşı ağırlık: bu ürün **anahtarsız bir güvenlik aracı**. Bugüne kadarki bağımlılık disiplini
kasten sert — `postgres` (0 transitive), `@noble/hashes` (0 transitive), `yaml`, `zod`. HTTP
sunucusu eklemek bu çizgiyi belirgin biçimde genişletiyor.

## Karar

**Fastify `5.12.3` exact pin ile `@ictt-sentinel/api` içinde kullanılır.**

Bu kurulum **+47 paket** getirdi (pino, avvio, find-my-way, light-my-request, fast-json-stringify,
toad-cache, rfdc, semver ve bağımlılıkları). Bu, bu repository'deki **en büyük tek
trust-boundary genişlemesidir** ve öyle kaydedilmiştir.

### Neden el yazımı `node:http` değil

Reddedilen alternatif: sıfır bağımlılıkla `node:http` üzerine kendi router/parser'ımızı yazmak.

Güvenlik açıkları tam olarak burada yaşıyor: body size limiti, `content-type` sıkı doğrulama,
header injection, chunked/keep-alive kenar durumları, route ayrıştırma. Bunları kendimiz yazmak
bağımlılık sayısını düşürür ama **saldırı yüzeyini artırır**. Denetlenmiş, yaygın kullanılan bir
sunucu bu iş için el yazımı bir taneden daha güvenlidir.

### Kurulum güvenliği

- `fastify@5.12.3` **install lifecycle script'i tanımlamıyor**. `prepublishOnly` yalnız
  yayıncıda çalışır, registry tarball kurulumunda değil. `.npmrc` zaten
  `enable-pre-post-scripts=false` ile bunu kapalı tutuyor.
- Exact pin zorunlu; `^`/`~` yok. Lockfile commit edilir.
- `scripts/verify-config.mjs` içindeki `RUNTIME_DEP_ALLOWLIST`'e gerekçesiyle eklendi.

### Test disiplini

API testleri `fastify.inject()` ile çalışır: **port dinlenmez**, uzun yaşayan server
başlatılmaz. Ortak sözleşmenin "uzun yaşayan server başlatma" yasağı bu yüzden ihlal edilmiyor
ve testler CI'da deterministik kalıyor.

## Sonuçlar

**Kabul edilen:**

- Hosted plane **local truth authority'nin yerine geçmez**. Hosted kapalıyken local
  evaluation ve evidence üretimi devam eder (M12 kabul kriteri, testli).
- Ingest **off-chain evidence mutation**'dır; chain write değildir. API'de signer, transaction
  gönderimi veya pause yüzeyi yoktur ve `check-boundaries` bunu repository genelinde denetler.
- Public unauthenticated mutation endpoint'i ve arbitrary RPC proxy **yoktur**.

**Bedeli:**

- 47 paketlik bir ağaç artık runtime trust boundary'sinde. Bir güvenlik açığı duyurusu bu
  ürünü de etkiler; `pnpm audit` ve lockfile denetimi operasyonel bir sorumluluktur.
- Bu ADR olmadan sürüm yükseltilemez (CLAUDE.md §6).

## Yeniden gözden geçirme

Fastify majör sürüm değişiminde, bir güvenlik duyurusunda veya hosted plane kapsam dışına
çıkarsa bu ADR yeniden değerlendirilir.
