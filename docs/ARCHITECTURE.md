# Mimari — ictt-sentinel

**Tarih kesimi:** 2026-08-30 · **Durum:** tasarım (kod yazılmadı)

---

## 1. Yüksek seviye akış

```
        Versioned manifest + policy + fingerprints
                          |
                          v
Webhook ------------> Event intake <------ RPC A / RPC B / archive RPC
 (yalnız hız ipucu)       |                     (truth path)
                          v
              Reorg-aware append-only ledger
                          |
              Message lifecycle state machine
                          |
           Pinned-block state reconciler / adapters
                          |
              Deterministic invariant engine
                          |
              Evidence bundle + verdict
                    /            \
          local CLI/CI      hosted control plane
                                  | Slack / PagerDuty / SIEM
```

Dört katman, dört ayrı sorumluluk:

| Katman | Sorumluluk | Belirleyici kural |
|---|---|---|
| **VERİ** | Webhook hız yolu + multi-RPC truth path | Webhook canonical fact yazamaz |
| **LEDGER** | Reorg-aware replay, message state machine | Append-only; orphan silinmez, işaretlenir |
| **KURAL** | Versioned adapters, pinned reconciliation | Tanınmayan sürüm → UNKNOWN |
| **KANIT** | Verdict + evidence bundle | Aynı pinned blok → aynı hash |

## 2. Güven sınırı

### Agent neyi görür

- RPC'lere **salt-okunur** erişir. Signing key yoktur.
- Query-only allowlist kullanır; generic `request(method, params)` yüzeyi **yoktur**.
- Secret değerini değil, manifest'teki **env adını** bilir; değer runtime'da secret
  provider'dan çözülür.

### Hosted plane neyi görmez

- Ham private-L1 logunu almak **zorunda değildir**. Minimum evidence metadata veya operatörce
  seçilen veri gönderilir.
- Agent → hosted yalnız **signed-ingestion token** ile konuşur; chain signing key yoktur.

### Nöbetçinin engelleyemedikleri — açıkça beyan

Nöbetçi şunları **önleyemez**; yalnız gözleyebilir ya da UNKNOWN üretebilir:

- Ortak upstream kullanan RPC'lerin birlikte yanlış cevap vermesi
- Warp/validator güvenliğinin kırılması
- Admin / minter / proxy yetkisinin kötüye kullanımı

**Protokol güvenliğinin yerine geçmez.** Evidence "tamper-proof" diye değil, **yeniden
üretilebilir ve audit-paylaşılabilir** diye sunulur.

## 3. Veri kaynakları önceliği

| # | Kaynak | Rol | Hüküm gücü |
|---|---|---|---|
| 1 | Sözleşme state call + finalized RPC log replay | **Hüküm kaynağı** | Canonical |
| 2 | İkinci bağımsız RPC (farklı provider family) | Witness / uyuşmazlık tespiti | Canonical'i doğrular |
| 3 | Webhook | Düşük gecikmeli tetik | **Hiçbiri** — yalnız hız |
| 4 | Metrics API | Aktivite ve operasyon bağlamı | Teminat kanıtı **değil** |
| 5 | Data API | Metadata ve keşif | Keşif |
| 6 | P-Chain / validator görünümü | Quorum bağlamı | Ekonomik invariant'tan **ayrı** |

**Quorum tanımı:** Provider quorum = bağımsız **providerGroup** sayısı, URL sayısı değil.
Aynı upstream'i paylaşan iki URL **tek witness** sayılır. Çoklu RPC quorum'u kriptografik proof
veya Byzantine güvence olarak sunulamaz.

## 4. Truth anchor ve finality

Bkz. `docs/adr/0002-accepted-quorum-truth.md`.

- Tüm karşılaştırmalı state okumaları **explicit block number + block hash**'e pinlenir.
  İki zincirin `latest` cevabını kıyaslamak hatadır.
- Avalanche'ta **kabul (acceptance) finaldir**. Ethereum tarzı confirmation depth kullanılmaz.
  C-Chain `allow-unfinalized-queries` varsayılanı `false`'tur; `latest` kabul edilmiş bloktur.
- C-Chain block hash'i local geth alanlarından **yeniden hesaplanmaz**; node'un verdiği hash esastır.
- **ACP-194 tetikleyicisi:** Helicon aktive olursa kabul ≠ yürütme olur ve truth anchor `settled`
  bloğa kaymak zorundadır. Bu, her milestone'da yeniden kontrol edilir.

## 5. Mesaj yaşam döngüsü

```
INTENT_OBSERVED
  -> HOME_ACCOUNTED
  -> ICM_SENT
  -> DELIVERED
  -> EXECUTED_SUCCESS
     | EXECUTED_FAILED -> RETRY_PENDING -> RETRIED_SUCCESS
```

- `ReceiveCrossChainMessage` ile `MessageExecuted` **ayrı** izlenir.
- **`DELIVERED` durumunu `EXECUTED_SUCCESS` göstermek tehlikeli bir ürün hatasıdır.**
- `MessageExecutionFailed` healthy kapanmaz; retry ve nihai execution eşleşmelidir.
- Receipt gecikmesi accounting proof'u bozmayabilir; **liveness alarmı** üretir.
- Remote-to-remote multi-hop home üzerinden geçtiği için doğrudan transfer gibi modellenmez.

## 6. MVP teknoloji seçimi

**Öneri:** TypeScript monorepo, pnpm, Node.js LTS, ABI/log/state için viem veya ethers,
Fastify API, PostgreSQL, Docker Compose.

**Saf deterministic invariant çekirdeği framework bağımsız TypeScript olmalıdır.**

Gerekçe:
- CLI, worker ve API arasında type paylaşımı
- `bigint` ile exact integer muhasebe (**float/JS `number` yasak**)
- 8-12 haftalık MVP için düşük operasyon yükü

### Resmî SDK'nın yeri — sınırlı

`@avalanche-sdk/client` (`0.1.2`) ve `@avalanche-sdk/interchain` (`0.1.1-alpha.1`, 2025-10-16'dan
beri hareketsiz) **canonical hüküm yolunda kullanılmaz**. Alpha ve durgun bir paket, ekonomik
hüküm üreten yolun temeli olamaz. Truth path pinlenmiş ABI + genel EVM istemcisi üzerinden yürür;
SDK yalnız opsiyonel keşif/kolaylık katmanında kalır. (`RESEARCH_SYNTHESIS.md` V12, I05)

**İlk sürümde gereksiz:** Kafka, Kubernetes, microservice çoğaltma, yeni indexer zinciri.
Tek worker + Postgres outbox yeterlidir. Yük kanıtlanırsa ingest/replay ayrılabilir.

## 7. Monorepo yapısı

Milestone 01'de bu yapı kuruldu. Klasör sorumluluk tablosu ve katman numaraları için
**`README.md` → "Klasör sorumlulukları"** tek kaynak-of-truth'tur; burada tekrarlanmaz.

```
apps/
  cli/                 init, discover, doctor, check, replay, run, evidence
  agent/               collectors, scheduler, local daemon
  api/                 hosted evidence/control API
  console/             optional read-only evidence UI
packages/
  domain/              paylaşılan domain tipleri            (katman 0, saf)
  invariant-core/      deterministik kurallar               (katman 0, saf)
  state-machine/       intent/delivery/execution/retry      (katman 0, saf)
  config/              manifest/policy şeması + doğrulama   (katman 1)
  evidence/            bundle formatı, hash, export         (katman 1)
  testkit/             deterministik fixture'lar            (katman 1)
  rpc-quorum/          query-only allowlist, witness quorum (katman 2)
  ictt-adapters/       sürüm-pinli ICTT/Teleporter okuma    (katman 2)
  storage-postgres/    append-only ledger kalıcılığı        (katman 2)
  replay/              reorg-aware replay, checkpoint       (katman 2)
  alerts/              Slack, PagerDuty, webhook, SIEM      (katman 2)
config/
  deployments/         operatör deployment manifestleri (veri)
  policies/            policy dosyaları (veri)
infra/
  postgres/
scripts/
```

> `packages/config` (**kod**: şema/doğrulama) ile kök `config/` (**veri**: manifest/policy)
> ayrı şeylerdir ve karıştırılmaz.

Bağımlılık yalnız içe doğrudur; izin verilen kenarlar her `package.json` içinde
`ictt-sentinel.mayDependOn` alanında makine-okunur biçimde durur ve `pnpm run verify:config`
ile denetlenir.

npm scope `@ictt-sentinel/*`, CLI binary `ictt-sentinel`, env prefix `ICTT_SENTINEL_`.

## 8. CLI ve API sözleşmesi

```
ictt-sentinel init ictt
ictt-sentinel discover --home-chain ... --token-home 0x...
ictt-sentinel doctor   --manifest deployment.yaml
ictt-sentinel check    --manifest deployment.yaml --at <finality-policy>
ictt-sentinel replay   --manifest deployment.yaml --from-deployment
ictt-sentinel run      --manifest deployment.yaml
ictt-sentinel evidence export --evaluation <id>
```

`doctor` şunları kontrol eder: chain/genesis kimliği, bytecode, archive depth, finality policy
ve eksik env değerleri. `replay` sonucu **PASS / VIOLATION / UNKNOWN** olmalıdır.

Hosted API (taslak):

```
POST /v1/deployments/attest
POST /v1/evaluations
GET  /v1/deployments/{id}/status
GET  /v1/incidents/{id}/timeline
GET  /v1/evidence/{id}/bundle
POST /v1/alerts/test
```

Idempotency key, payload hash, timestamp ve replay koruması zorunludur.

## 9. Onboarding akışı

1. `ictt-sentinel init ictt`
2. RPC secret'larını yerel secret manager'a koy
3. `ictt-sentinel discover --home ... --remote ...`
4. **Manifest diff'ini operatör/auditor ile onayla** ← baseline meşruiyeti burada doğar
5. `ictt-sentinel doctor`
6. `ictt-sentinel replay --from-deployment`
7. `ictt-sentinel check --manifest deployment.yaml`
8. Evidence bundle'ı release gate'e ekle
9. İstenirse hosted plane'e ingestion token ile bağlan
10. `docker compose up -d`; alarm ve runbook tatbikatı

> `discover` taslak üretir. **Operatör doğrulamadan mevcut durum doğru baseline sayılmaz.**
> İlk değer anı yeşil dashboard değil, **kontrollü fixture'ın gerçekten yakalanmasıdır.**

## 10. Gözlenebilirlik — ürünün kendisi için

Ürün kendi veri yolunun bozulmasını **kritik bir health olayı** olarak görünür kılmalıdır:

- per-chain head/finalized lag
- replay gap ve last successful state call
- RPC witness divergence
- webhook duplication / loss / reorder
- queue age ve evaluation latency
- **rule UNKNOWN oranı**
- alert delivery / ack latency
- deployment başına actionable false-positive oranı

## 11. Wedge — neden "bir monitor daha" değil

Ürün bir **ICTT assurance compiler**'dır:

1. Deployment topolojisini ve sözleşme sürümünü **keşfeder**
2. Sürüm/token türüne göre geçerli invariant paketini **üretir**
3. Home/remote olaylarını **nedensel state machine**'de birleştirir
4. Pinned-block reconciliation ve data-quality hükmü **çalıştırır**
5. Sonucu başka güvenlik motorlarına veya kendi evidence plane'ine **verir**

Bu, Hexagate veya OZ Monitor'un alarm yürütme kabiliyetini kopyalamaz; **onların bilmediği ICTT
semantiğini taşır.** OZ Monitor bir rakip değil, olası bir execution backend'dir.

**İlk gün moat yoktur.** Kod, dashboard ve kural listesi kopyalanabilir. Moat zamanla oluşur:
sürüm bazlı doğrulanmış fingerprint registry, anonimleştirilmiş replay corpus ve false-positive
kalibrasyonu, auditor'ların kabul ettiği evidence schema, partner dağıtımı.
