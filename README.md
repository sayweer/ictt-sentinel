# ictt-sentinel

> ICM / ICTT Teminat Yeterliliği ve Değişmezlik Nöbetçisi
> *(uzun ad yalnız açıklamadır; identifier her yerde `ictt-sentinel`'dir)*

> **Durum: technical preview — offline CLI ve saf invariant motoru çalışıyor.**
> Milestone 11'in evidence/CLI teslimleri geliştirildi. Gerçek deployment manifestinden
> census, drift ve ekonomik observation girdilerini üreten uçtan uca toplayıcı henüz bağlı değil;
> gerçek zincir kontrolü tamamlanmış sayılmaz. Kapsam ve doğrulama: `docs/milestones/11.md`.

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

# 3. Bağımlılıkları kur ve derle
pnpm install --frozen-lockfile
pnpm run build

# 4. Bütün kapılar
pnpm run verify
```

Kendi ortam dosyanı **sen yönetirsin**; repository gerçek `.env` içermez.
`ictt-sentinel` hiçbir zaman secret **değerini** okumaz, yazmaz veya sormaz — manifest yalnız
env değişkeninin **adını** tutar.

### Üç fixture akışı — RPC gerekmez

Aşağıdaki üç akış tamamen **offline** çalışır: public RPC, credential veya veritabanı istemez.
Amaç, ürünün verebileceği üç cevabı da (yeşil, bilinmiyor, kırmızı) birkaç dakikada görmen.

Global install **gerekmez**; binary workspace içinden çalışır. Binary adı yalnız
`ictt-sentinel`'dir — generic `sentinel` alias'ı **yoktur**.

```bash
# 1) Sağlıklı canonical ERC20  -> OK, exit 0
pnpm --silent run cli -- check --fixture healthy;      echo "exit=$?"

# 2) Provider'lar block hash üzerinde anlaşamıyor -> UNKNOWN, exit 3
pnpm --silent run cli -- check --fixture disagreement; echo "exit=$?"

# 3) Kanıtlı teminat/muhasebe açığı -> CRITICAL, exit 2
pnpm --silent run cli -- check --fixture deficit;      echo "exit=$?"
```

`cli` kök scripti derlenmiş workspace binary'sini çalıştırır. `--silent`, paket yöneticisinin
ek çıktısını kapatır ve JSON stdout ile uygulamanın exit kodlarını korur.
`pnpm --filter ... exec` bazı non-zero kodları 1'e dönüştürdüğü için CI örneklerinde kullanılmaz.

Evidence üret ve **offline doğrula**:

```bash
pnpm --silent run cli -- evidence export --fixture healthy
pnpm --silent run cli -- evidence verify \
  --file evidence-out/healthy.evidence.json
```

`evidence export` iki dosya yazar: kanonik JSON ve aynı çekirdekten türetilmiş HTML.
**HTML core hash'ini değiştirmez.** Dosyalar `0600` izinle, temp + `fsync` + `rename` ile
atomik yazılır. Varsayılan dizin komutun çalışma dizinindeki `evidence-out`'tur;
`pnpm --silent run cli --` repository kökünden çalıştırılır; verify yolu da aynı kökten çözülür. `--evidence-dir` yalnız operatörün belirlediği dizindir;
bundle girdisi dosya yolu belirleyemez. Dizin private (`0700`) olmalı, symlink olamaz.
JSON ve HTML ayrı atomik dosyalardır; ikisi tek bir filesystem transaction'ı değildir.
SIGINT sonrası tamamlanmış JSON doğrulanabilir; HTML eksikse export yeniden çalıştırılır.

`--version --json`, üretilen bundle ile aynı artifact checksum'ını verir. Checksum çalışan
CLI ve workspace runtime modüllerinden hesaplanır; `buildCommit: artifact-addressed` bir Git
commit'i iddiası değildir. Fixture kimlikleri, kontrat bytecode hash'leri ve gözlemleri
**kurgusaldır**; `FICTIONAL_OFFLINE_FIXTURE` alanıyla işaretlenir. Tarihler sabittir:
verifier geçmişteki değerlendirmeyi yeniden üretir, bugünün zincir sağlığını ölçmez.

Offline fact taramasını sınırlı adımlarla yürüt:

```bash
pnpm --silent run cli -- replay --fixture healthy --max-facts 1
# İlk adım tamamlanmadığı için UNKNOWN / exit 3.
pnpm --silent run cli -- replay --fixture healthy --max-facts 1 --resume
# Aynı input ve build için kalan adım: OK / exit 0.
```

Checkpoint yalnız aynı bundle hash'i için kullanılabilir. Ayrışma/eksik kanıt checkpoint'i
ilerletmez. Bu, bundle içindeki fact listesinin sınırlı taramasıdır; RPC log replay'i değildir.
`check` tüm sabit snapshot'ı değerlendirir; bounded resume şu an `replay` komutundadır.

`discover --fixture healthy --json` inceleme için **candidate projection** ve diff üretir;
import edilebilir tam deployment manifesti üretmez, baseline yazmaz ve exit 3 verir.
`doctor --json` secret adları için presence raporlar; canlı RPC/DB probe'ları bağlı olmadığı
sürece `ready: false` verir (eksik config 5; doğrulanmamış readiness 3).
Telemetry kapalıdır. `--help`, `--version`, `init` bilgi komutları başarıyla çalışınca 0 verir;
bu komutlar deployment sağlık hükmü üretmez.

`--json` makine çıktısını **stdout**'a verir; bütün insan çıktısı ve ilerleme **stderr**'a gider,
böylece `| jq` filtresiz çalışır.

### Exit kodları

| Kod | Anlamı |
|---|---|
| `0` | **Yalnız** genel `OK` — her zorunlu kontrol complete, fresh ve pass |
| `2` | `CRITICAL` — yeterli kanıtla deterministic ihlal (olay) |
| `3` | `UNKNOWN` — zorunlu bir kontrol kurulamadı (kör nokta) |
| `4` | `WARN` — policy/liveness sapması |
| `5` | Geçersiz config veya argüman; **hiçbir şey değerlendirilmedi** |
| `6` | Aracın kendi iç hatası — asla hüküm olarak raporlanmaz |

`2` ve `3` ayrı kodlar çünkü ayrı müdahale isterler: biri olay, diğeri kör nokta.

> **Ne değildir:** evidence bundle *reproducible* ve *audit-shareable*'dır; **tamper-proof
> değildir**. Dosyayı düzenleyebilen hash'i de yeniden hesaplayabilir. Verifier bunu kendi
> çıktısında açıkça yazar.

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
