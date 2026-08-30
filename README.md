# ictt-sentinel

> ICM / ICTT Teminat Yeterliliği ve Değişmezlik Nöbetçisi
> *(uzun ad yalnız açıklamadır; identifier her yerde `ictt-sentinel`'dir)*

> **Durum: scaffold / technical preview.**
> Bu repository şu an **yalnız iskelet ve dokümantasyondur**. Ürün davranışı, RPC adapter'ı,
> invariant motoru ve veritabanı mantığı **henüz yazılmamıştır**. Çalışan bir CLI yoktur.
> Neyin planlandığı ile neyin var olduğu için `docs/SUPPORT_MATRIX.md`'ye bakın —
> `IMPLEMENTED` satır sayısı bugün **0**'dır.

---

## Ne yapar

Bir ICTT deployment manifestini alır; home, remote, Teleporter ve zincir yapılandırmasını çoklu
bağımsız RPC ile **pinlenmiş bloklarda** yeniden kurar; sözleşme sürümüne uygun muhasebe ve mesaj
invariant'larını çalıştırır; her hükmü kanıt, tazelik ve varsayım bilgisiyle dışarı verir.

Her değerlendirme için **`OK` / `WARN` / `CRITICAL` / `UNKNOWN`** verir.

## Neden

Resmî Avalanche ICTT dokümantasyonu bu sorumluluğu açıkça operatöre bırakır:

> "Anyone is able to deploy and register remote contracts, which may have been modified from this
> repository. It is the responsibility of the users of the home contract to independently evaluate
> each remote for its security and correctness."

Ürün, ekosistemin kendi güven modelinde operatöre bırakılmış bu işi ürünleştirir.
Ayrıntı ve doğrulama zinciri: `docs/PRODUCT.md`, `docs/RESEARCH_SYNTHESIS.md`.

## Güvenlik: sıfır signing key

**Bu araç hiçbir koşulda imzalamaz, işlem göndermez, köprü durdurmaz.**

- Private key, mnemonic, seed, signer, wallet, keystore **tutmaz ve istemez**
- `sendTransaction` veya herhangi bir **chain-write yüzeyi yoktur**
- mint / burn / retry / pause / upgrade **çağırmaz**; auto-pause **yoktur**
- RPC erişimi **query-only allowlist** üzerindendir; generic `request(method, params)` yüzeyi yoktur

Gerekçe: `docs/adr/0001-keyless-read-only.md`. Tehdit modeli ve sınırlar: `docs/SECURITY.md`.
Açık bildirimi: kök `SECURITY.md`.

## Kimler kullanır

| Rol | Kullanım |
|---|---|
| Avalanche L1 CTO / platform lead | Launch öncesi deployment doğrulama |
| Protocol security / risk lead | Sürekli kontrol, olay kanıtı |
| Token issuer operasyon yöneticisi | Teminat açığının erken tespiti |
| Managed L1 / BaaS sağlayıcısı | Çok deployment'a paketlenmiş kontrol |
| Security engineer, SRE, SOC analyst | Günlük operasyon ve olay müdahalesi |
| Audit firması | Post-audit sürekli kontrol devri |

## Kullanım modları (planlanan)

| Mod | Ne için | Güven sınırı |
|---|---|---|
| CLI / CI preflight | Deployment ve upgrade kapısı | Tümüyle operatör ağında |
| Local Docker agent | Public/private L1 RPC'lerine operatör ağı içinden erişim | Ham veri dışarı çıkmaz |
| Hosted evidence plane | Alarm, rol, retention, paylaşım | Yalnız operatörce seçilen metadata |
| Library / policy pack | Başka güvenlik motorlarına kural üretir | Yürütme başka motorda |

## MVP kapsamı ve non-goals

**MVP (P0) hedefi:** iki local/Fuji L1; canonical `ERC20TokenRemote` reconciliation;
native modda `sufficient`/`indeterminate`/`unknown`; manifest discovery ve doctor;
pinned-block çoklu RPC replay; delivery-vs-execution state machine; evidence bundle;
Docker Compose local agent.

**Bilinçli olarak ürün DEĞİL:**
bridge · relayer · custodian · wallet · sigorta · signer tutan araç · transaction gönderen kontrol
düzlemi · otomatik devre kesici · webhook'u zincir gerçeği sayan dashboard · ilk günden tüm
bridge'leri destekleyen yatay platform · mutlak solvency/güvenlik sertifikası.

Tam liste: `docs/PRODUCT.md` §3 ve `docs/SUPPORT_MATRIX.md` §7.

## Mimari özeti

```
Versioned manifest + policy + fingerprints
                  |
                  v
Webhook ------> Event intake <------ RPC A / RPC B / archive RPC
(yalnız hız)        |                       (truth path)
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
```

Ayrıntı: `docs/ARCHITECTURE.md`.

### Klasör sorumlulukları

| Yol | Sorumluluk | Katman |
|---|---|---|
| `apps/cli/` | Operatör CLI: `init`, `discover`, `doctor`, `check`, `replay`, `run`, `evidence` | 3 |
| `apps/agent/` | Yerel salt-okunur toplayıcı daemon | 3 |
| `apps/api/` | Hosted evidence/control API | 3 |
| `apps/console/` | Opsiyonel salt-okunur evidence arayüzü | 3 |
| `packages/domain/` | Paylaşılan domain tipleri. **Saf** | 0 |
| `packages/invariant-core/` | Deterministik invariant kuralları. **Saf** | 0 |
| `packages/state-machine/` | Mesaj yaşam döngüsü makinesi. **Saf** | 0 |
| `packages/config/` | Manifest/policy **şeması ve doğrulaması** (kod) | 1 |
| `packages/evidence/` | Evidence bundle formatı, canonical hash, export | 1 |
| `packages/testkit/` | Deterministik fixture ve test yardımcıları | 1 |
| `packages/rpc-quorum/` | Query-only allowlist'li çoklu sağlayıcı RPC witness quorum'u | 2 |
| `packages/ictt-adapters/` | Sürüm-pinli ICTT/Teleporter sözleşme okuma adapter'ları | 2 |
| `packages/storage-postgres/` | Append-only ledger ve evaluation kalıcılığı | 2 |
| `packages/replay/` | Reorg-aware log replay ve checkpoint | 2 |
| `packages/alerts/` | Giden alarm taşıyıcıları. Canonical fact **yazmaz** | 2 |
| `config/deployments/` | Operatörün deployment manifestleri (**veri**) | — |
| `config/policies/` | Policy dosyaları (**veri**) | — |
| `infra/postgres/` | Yerel Postgres altyapı dosyaları | — |
| `scripts/` | Repository bakım ve doğrulama scriptleri | — |
| `docs/` | Ürün, mimari, güvenlik, invariant ve karar dokümantasyonu | — |

> `packages/config` (**kod**: şema/doğrulama) ile kök `config/` (**veri**: manifest/policy)
> karıştırılmamalıdır.

**Bağımlılık yönü yalnız içe doğrudur.** `domain`, `invariant-core` ve `state-machine`
ağ, DB, `process.env`, framework, wall-clock veya randomness **import edemez**.
İzin verilen kenarlar her `package.json` içinde `ictt-sentinel.mayDependOn` alanındadır ve
`pnpm run verify:config` ile denetlenir.

## Hızlı başlangıç (local)

Ön koşullar ve platform ayrıntıları: **`docs/DEVELOPMENT.md`**.

```bash
# 1. Doğru Node sürümüne geç (.nvmrc: 24.20.0)
nvm use

# 2. pnpm'i corepack ile etkinleştir (packageManager alanı pnpm@11.10.0'ı pinler)
corepack enable

# 3. Repository config kapısını çalıştır — bugün çalışan tek kapı budur
pnpm run verify:config
```

> `pnpm install`, lint, typecheck, test ve build kapıları **Milestone 02**'de gelir.
> Bugün bağımlılık yoktur ve kurulacak bir şey yoktur.

Kendi ortam dosyanı **sen yönetirsin**; repository gerçek `.env` içermez ve Claude'un onu
okuması `.claude/settings.json` ile engellenmiştir.

## Çalışma düzeni: prompt / milestone

Bu repository numaralı milestone promptlarıyla yürütülür.

- **Bir turda yalnız tek milestone.** Sonraki promptun işine başlanmaz.
- Her milestone sonunda `docs/milestones/NN.md` yazılır: değişen dosyalar, exact komut/exit,
  kabul kriterleri, kararlar, riskler ve `GATE: PASS|BLOCKED`. Sonra **durulur**.
- Bir milestone, öncekinin raporunda `GATE: PASS` yoksa başlamaz.
- Proje anayasası **`CLAUDE.md`**'dir ve global ayarları geçersiz kılar.
- Claude için ek çalışma kuralları `.claude/rules/`, yardımcı komutlar `.claude/commands/`
  altındadır.

Tamamlanan milestone'lar: `docs/milestones/`.

## Dokümantasyon haritası

| Dosya | İçerik |
|---|---|
| `CLAUDE.md` | Proje anayasası — her oturumda geçerli güvenlik ve çalışma kuralları |
| `docs/PRODUCT.md` | Ürün sınırı, non-goals, kullanıcılar, ticari doğrulama kapısı |
| `docs/ARCHITECTURE.md` | Katmanlar, güven sınırı, veri kaynağı önceliği, truth anchor |
| `docs/SECURITY.md` | Tehdit modeli, anahtarsızlık, secret yönetimi, runbook |
| `docs/INVARIANTS.md` | Kanıt sınıfları, verdict lattice, P0 kural kataloğu |
| `docs/SUPPORT_MATRIX.md` | Ne destekleniyor, ne planlanıyor, ne desteklenmiyor |
| `docs/PROTOCOL_SOURCE_LOCK.md` | Pinlenmiş sözleşme kaynağı, audit provenance, TBD listesi |
| `docs/DATA_MODEL.md` | Varlıklar, manifest şeması, evidence bundle |
| `docs/TEST_STRATEGY.md` | Fixture'lar, property/chaos testleri, kabul eşikleri |
| `docs/ROADMAP.md` | Kapı tabanlı fazlar ve risk sicili |
| `docs/DECISIONS.md` | ADR indeksi ve bekleyen kararlar |
| `docs/RESEARCH_SYNTHESIS.md` | Kaynak envanteri, doğrulanmış/çıkarım/varsayım ayrımı |
| `docs/DEVELOPMENT.md` | Kurulum, günlük komutlar, Claude Code ayarı, troubleshooting |
| `CONTRIBUTING.md` | Milestone/diff/test/ADR düzeni |
| `SECURITY.md` | Açık bildirimi ve disclosure sınırı |

## Lisans

**Henüz belirlenmedi.** `package.json` içinde `UNLICENSED` olarak işaretlidir ve dağıtım
hakkı verilmez. Bekleyen karar: `docs/DECISIONS.md` → "Kullanıcıdan beklenen kararlar".
