# Test Stratejisi

**Tarih kesimi:** 2026-08-30 · **Durum:** plan (test kodu yazılmadı)

---

## 1. Bağlayıcı ilkeler

- **Test/strictness/policy zayıflatılarak gate geçilemez.**
  Test silme, `skip`, `|| true`, sessiz fallback, yalnız yeşil görünmek için mock **yasak**.
- **Çalıştırılmayan veya skipped test PASS sayılmaz.**
- Unsupported fork/fingerprint'te sonuç **`UNKNOWN` olmalı, yanlış PASS değil.**
  Bu, test edilen bir davranıştır — bir umut değil.
- Her invariant kuralı için **en az bir pozitif ve bir negatif** fixture zorunludur.
- **En kritik metrik false negative'dir**: canonical fixture'larda hedef **sıfır**.

---

## 2. Deterministik failure fixture'ları

15 fixture; hepsi local/Fuji'de deterministik olarak yeniden üretilebilir olmalıdır.

| # | Fixture | Beklenen verdict |
|---|---|---|
| 1 | Yanlış remote home address / `blockchainID` | `CRITICAL` (`CFG-001`) |
| 2 | Tanınmayan proxy implementation veya bytecode drift | `UNKNOWN` fail-closed (`CFG-002`) |
| 3 | `collateralNeeded > 0` iken transfer beklentisi | `CRITICAL` (`CFG-005`) |
| 4 | Decimal multiplier/rounding sınırları; 6→18 ve 18→6 | `OK` (sınırda doğru) |
| 5 | İlk teminatın transferred balance'a **iki kez** eklenmesi | `CRITICAL` (çift sayım) |
| 6 | Home muhasebesi olmadan remote mint | `CRITICAL` (`ACC-001`, `MSG-001`) |
| 7 | Home send var, delivery var, **app execution fail** | `WARN`/`CRITICAL` (`MSG-002`) |
| 8 | Retry sonrası **tek** ekonomik etki | `OK` (`MSG-004`) |
| 9 | Duplicate webhook ve log | `OK` (idempotent) |
| 10 | Reorg ile orphan event rollback | `OK` (rollback doğru) |
| 11 | RPC A/B block hash ayrışması | `UNKNOWN` (`DAT-001`) |
| 12 | Pruned RPC log gap ve archive fallback | `UNKNOWN` veya recover (`DAT-002`) |
| 13 | Native upper-bound backing'i aşıyor | **`INDETERMINATE`** — kırmızı **değil** (`ACC-004`) |
| 14 | Yetkisiz native minter allowlist drift | `CRITICAL` (`CFG-006`) |
| 15 | Rate/hacim anomalisi | `WARN` — **solvency alarmına yükselmemeli** (`RSK-001`) |

### 10 günlük kapının üç fixture'ı

Ticari kapı için deterministik yakalanması **zorunlu** üç hata (`PRODUCT.md` §11):

1. **Config/minter drift** → fixture #1, #2 veya #14
2. **Unmatched mint / accounting** → fixture #6
3. **Delivered-but-execution-failed** → fixture #7

Ayrıca native için `upper-bound` / `indeterminate` demo (fixture #13).

---

## 3. Property ve differential testler

| Test | Ne kanıtlar |
|---|---|
| Contract integer scaling/rounding ↔ adapter hesabı birebirliği | `tokenMultiplier` / `multiplyOnRemote` / `+1` yuvarlama doğru uygulanıyor |
| Olay replay **sırası değişse** idempotent son state | Ledger sıra bağımsız |
| Aynı finalized snapshot + aynı rule version → **aynı evidence hash** | Reprodüksiyon sözü |
| Resmî contract getter ↔ reconstructed ledger periyodik differential | Ledger sürüklenmiyor |
| Unsupported fork'ta `UNKNOWN`, yanlış PASS **değil** | Fail-closed davranışı |
| `bigint` sınırları ve base-unit dönüşümleri | Float/`number` sızıntısı yok |

### 3.1 Özel dikkat: yuvarlama

`collateralNeeded` hesabında `multiplyOnRemote == true` ve `initialReserveImbalance`
`tokenMultiplier`'a tam bölünmüyorsa **+1** eklenir. Bu, property test'in birinci sınıf
hedefidir; off-by-one burada sessiz bir muhasebe hatasına dönüşür.

---

## 4. Chaos testleri

Local agent **buffered** çalışabilmeli; tekrar bağlanınca outbox **idempotent** göndermelidir.

- Webhook kaybı / tekrarı / sıra bozulması
- RPC timeout, `429` rate limit
- Provider **ortak arızası** (aynı upstream) → quorum düşer → `UNKNOWN`
- Chain halt
- Reorg
- Proxy upgrade (canlı fingerprint değişimi)
- Destination revert
- Receipt gecikmesi
- Hosted plane kesintisi

---

## 5. Kabul eşikleri

| Alan | Kabul eşiği |
|---|---|
| **Doğruluk** | Canonical fixture'larda **sıfır false negative** |
| **Veri güveni** | Gap / reorg / RPC ayrışması **`UNKNOWN` üretir** |
| **Gecikme** | Finality sonrası kritik ihlal **<5 dk** |
| **Yanlış alarm** | Shadow run'da deployment başına ayda **<1** aksiyon gerektiren FP |
| **Kurulum** | İlk evidence **<60 dk**; olgun quickstart **<30 dk** |
| **Tekrar üretim** | Bundle aynı pinned bloklarda **aynı sonucu** verir |
| **Güvenlik** | **Zincir signing key'i yok**; secret leakage testi geçer |
| **Operasyon** | Alert test + runbook owner zorunlu |

## 6. Güvenlik testleri

- **Secret leakage taraması**: log, evidence bundle, crash report, telemetry — secret değeri
  hiçbirinde görünmemeli
- **Yasak env taraması**: `BRIDGE_PRIVATE_KEY`, `MINTER_PRIVATE_KEY`, `PAUSER_PRIVATE_KEY`,
  `MULTISIG_SIGNER_KEY` varlığı **build hatası** üretmeli
- **RPC allowlist testi**: allowlist dışı method çağrısı reddedilmeli; yazma method'u
  allowlist'e eklenemez
- **Webhook SSRF testi**: iç ağ / link-local / metadata endpoint hedefleri engellenmeli
- **Manifest şema testi**: `confirmations` alanı **reddedilmeli** (sessizce yok sayılmamalı);
  `allowedSourceFamilies: ["teleporterV2"]` **reddedilmeli**

## 7. Doğrulama sırası (her milestone)

1. Hedefli kontroller (o milestone'un testleri)
2. Repository'de mevcutsa cumulative `pnpm run verify`
3. Git varsa `git diff --check` ve scope dışı değişiklik kontrolü

Bu sıra atlanamaz; cumulative kapı çalıştırılmadan `GATE: PASS` verilemez.

## 8. Bu milestone'da test durumu

**Milestone 00'da test çalıştırılmamıştır** — kod, dependency ve test altyapısı bilinçli
olarak kapsam dışıdır. Doğrulama, üretilen dokümanların iç tutarlılığı ve kaynak
doğrulaması ile sınırlıdır (`docs/milestones/00.md`).
