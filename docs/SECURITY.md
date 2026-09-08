# Güvenlik — ictt-sentinel

**Tarih kesimi:** 2026-08-30

Bu ürün bir güvenlik aracıdır; bu yüzden **kendisi bir saldırı yüzeyidir**. Aşağıdaki kurallar
ürün özelliğinden önce gelir.

---

## 1. Anahtarsızlık — pazarlık dışı

### Asla var olmayacaklar

- Private key, mnemonic, seed, signer, wallet, keystore — **oluşturma, isteme, saklama, okuma yok**
- `sendTransaction`, signer interface veya herhangi bir chain-write yüzeyi
- mint / burn / retry / pause / upgrade çağrısı
- Auto-pause veya otomatik devre kesici

MVP'de **kesinlikle bulunmaması gereken** env değişkenleri:

```
BRIDGE_PRIVATE_KEY
MINTER_PRIVATE_KEY
PAUSER_PRIVATE_KEY
MULTISIG_SIGNER_KEY
```

Bunlardan herhangi birinin varlığı bir **build hatası** olarak ele alınmalıdır, uyarı değil.

### Neden

Otomatik response, yanlış pause/retry yoluyla **çok yüksek etkili** zarar üretebilir.
Response katmanı gerekiyorsa ayrı, opt-in ve multisig policy altında olmalıdır — bu üründe değil.
Bkz. `docs/adr/0001-keyless-read-only.md`.

## 2. RPC yüzeyi

- **Public generic `request(method, params)` yüzeyi yasaktır.**
- Yalnız **query-only allowlist**: okunan her JSON-RPC method adı kod içinde sabit bir listede
  bulunmalıdır. Liste dışı method çağrılamaz.
- Yazma yapan hiçbir method (`eth_sendRawTransaction`, `eth_sendTransaction`, `personal_*`,
  `miner_*`, `admin_*`) allowlist'e giremez.

**Gerekçe:** Generic bir passthrough, ürünün anahtarsızlık garantisini operatörün RPC
credential'ı üzerinden dolaylı olarak deler ve SSRF benzeri bir pivot noktası yaratır.

## 3. Secret yönetimi

- Secret **değeri** log, evidence bundle, crash report, telemetry veya hata mesajına **asla yazılmaz**.
- Manifest **env adını** tutar; değer yalnız runtime'da secret provider'dan çözülür.
- Gerçek `.env` dosyaları, credential store, shell history ve process environment okunmaz,
  yazdırılmaz; kullanıcıdan secret yapıştırması **istenmez**.
- Araştırma PDF'leri ve türevleri `.gitignore` kapsamındadır; repository'e girmez.

Beklenen secret'lar (yalnız okuma erişimi):

Tam liste ve açıklamaları: **`.env.example`** (tek kaynak-of-truth).

```
ICTT_SENTINEL_HOME_RPC_PRIMARY / _SECONDARY / _ARCHIVE
ICTT_SENTINEL_REMOTE_<NAME>_RPC_PRIMARY / _SECONDARY / _ARCHIVE
ICTT_SENTINEL_GLACIER_API_KEY          # opsiyonel, yalnız daha yüksek limit
ICTT_SENTINEL_WEBHOOK_SHARED_SECRET
ICTT_SENTINEL_SLACK_WEBHOOK_URL
ICTT_SENTINEL_PAGERDUTY_ROUTING_KEY
ICTT_SENTINEL_CONTROL_PLANE_URL / _TOKEN
POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD / DATABASE_URL
```

Manifest'in `secretRef` alanı **yalnız `ICTT_SENTINEL_` önekli** adları çözebilir;
bu, bir manifest'in resolver'ı rastgele bir process değişkenine yönlendirmesini engeller.
`PRIVATE_KEY`, `SIGNER_KEY`, `MNEMONIC`, `WALLET`, `KEYSTORE` parçası taşıyan hiçbir ad —
önek doğru olsa bile — çözülmez.

## 4. Container ve dağıtım

- Container **rootless** ve **read-only filesystem**
- **Egress allowlist** seçeneği (agent yalnız beyan edilen RPC/hosted uçlarına çıkabilsin)
- Agent → hosted: **mTLS veya kısa ömürlü scoped token**
- Dependency **exact pin** + lockfile; SBOM; signed release/image; reproducible build
- Package lifecycle scriptleri kurulmadan önce incelenir
- `sudo`, global install, `curl | sh`, uzaktan kod çalıştıran `npx/pnpx` **yasak**

## 5. Hosted plane

- **Tenant isolation**, least privilege, audit log, retention policy
- Manifest ve policy değişikliklerinde **review/approval** zorunlu
- Evidence bundle'da PII ve özel RPC cevabı **minimizasyonu**
- Hosted plane ham private-L1 logu almak zorunda değildir; operatör metadata-only modu seçebilir
- Idempotency key, payload hash, timestamp, replay koruması

## 6. Alarm yolu

- **Webhook SSRF koruması**: alert hedefi allowlist/şema kontrolünden geçer; iç ağ adreslerine
  (link-local, RFC1918, metadata endpoint) çıkış engellenir
- Alarm payload'ında secret leakage kontrolü
- **Webhook verdict veya canonical fact yazamaz** — yalnız hız ipucudur

## 7. Tehdit modeli — ne koruyoruz, neyi koruyamıyoruz

| Tehdit | Durum | Yaklaşım |
|---|---|---|
| Yetkisiz remote kaydı / trusted-remote drift | **Kapsamda** | `CFG-001`, candidate drift ayrımı |
| Bytecode / proxy implementation drift | **Kapsamda** | `CFG-002`, fingerprint fail-closed |
| Yetkisiz minter / allowlist drift | **Kapsamda** | `CFG-006` |
| Home muhasebesi olmadan remote mint | **Kapsamda** | `ACC-001`, `MSG-001` |
| Delivered ama execute olmamış mesaj | **Kapsamda** | `MSG-002` |
| RPC sağlayıcı arızası → sahte sağlık | **Kapsamda** | `DAT-001/002` → UNKNOWN |
| Ortak upstream'li RPC'lerin birlikte yanılması | **KAPSAM DIŞI** | Gözlenebilir; UNKNOWN üretilir |
| Warp / validator güvenliğinin kırılması | **KAPSAM DIŞI** | Bkz. ADR-0004 |
| Admin / upgrade authority'nin kötüye kullanımı | **Kısmen** | Drift görülür, engellenemez |
| Ürünün kendi secret'ının sızması | **Kapsamda** | §3, §4; hedef sıfır olay |
| Transitive ortak RPC provider/trust ilişkisi | **Kapsamda** | Bağlı failure-domain tek witness sayılır |
| Accepted hash'in sonradan değişmesi | **Kapsamda** | Integrity incident; rollback/yeşil hüküm yok |
| Malicious API body/token/tenant traversal | **Kapsamda** | Şema, auth, tenant grant, body/rate bound ve property test |
| Checkpoint'in fact commit'ini aşması | **Kapsamda** | Aynı DB transaction; crash/restart integration testi |
| Disk/outbox/notifier arızası | **Kapsamda** | Verdict değişmez; pending retry ve degraded health |
| Build veya dependency supply-chain sapması | **Kapsamda** | Exact lock, SCA, lisans, SBOM, checksum ve reproducible build |
| CPU/bellek/DB kaynak tüketimi | **Kısmen** | Bounded local budget; production kapasitesi operatöre ait |

## 8. `teleporterV2` / issue #1443 duruşu

`icm-contracts/avalanche/teleporterV2/` yalnız `WarpAdapter.sol` içerir ve **resmî audit kapsamında
değildir**. `ava-labs/icm-services#1443` (2026-08-13, **açık**, assignee/PR yok) bu dosyada
caller authorization eksikliği üzerinden sahte TeleporterV2 payload ve yetkisiz remote mint riski
iddia eder.

**Duruşumuz:**

- Bu, **doğrulanmış bir production vulnerability olarak sunulmaz.** Issue'nun kendisi kodun
  unversioned/unaudited ve kapsam dışı olabileceğini belirtir.
- Satış korkusu yaratmak için doğrulanmamış açık iddiası **kullanılmaz**.
- Ürün açısından ders: **sender/origin authorization, app payload ve fingerprint kontrolü
  muhasebe alarmından önce P0'dır.**
- `teleporterV2` fingerprint'i görülürse sonuç `UNSUPPORTED -> UNKNOWN`'dır, sessiz OK değil.

## 9. Dil ve hukuki risk

`proof of reserves`, `solvent`, `guaranteed`, `safe`, `tamper-proof` ifadeleri kanıt kapsamını aşar.

**Kullanılacak dil:**
- "Observed onchain coverage at pinned blocks"
- "Canonical ICTT accounting reconciled under stated assumptions"
- "Reported native supply upper bound is covered"
- "Evidence reproducible from listed RPC/block references"

**Kullanılmayacak dil:**
- "Bu token tamamen risksizdir"
- "Gerçek toplam arzı kriptografik olarak kanıtladık" (native bağlamında)
- "Alarm her exploit'i önler"
- "Multi-RPC Byzantine proof'tur"

`balanceOf` görmek **hukuki tahsil edilebilirlik değil**, yalnız onchain coverage kanıtıdır.

## 10. Incident runbook özeti

### CRITICAL accounting breach

1. Alarmı **block hash ve ikinci bağımsız RPC** ile yeniden üret
2. **Data-quality ihlalini ekonomik ihlalden ayır**
3. İlgili transfer/message timeline'ını çıkar
4. Home accounting, physical escrow ve remote supply state'ini **pinned bloklarda** tekrar al
5. Fingerprint / upgrade / minter / admin drift'ini kontrol et
6. Operatör, security owner ve multisig runbook owner'a delili gönder
7. **Pause/limit kararı insan onaylı multisig sürecinde alınır; sentinel imzalamaz**
8. Evidence bundle'ı hash, rule version ve incident notuyla arşivle

### UNKNOWN data state

1. **Sağlığı yeşile çevirme**
2. RPC provider family ve archive depth kontrol et
3. Gap aralığını alternatif/archive RPC ile replay et
4. Reorg / finality / watermark durumunu çöz
5. **Kanıt tamamlanana kadar ekonomik hükmü askıda tut**

## 11. Güven metrikleri

- Her rule için kaynak kod/audit dayanağı ve **son gözden geçirme tarihi**
- Tanınmayan fingerprint'te **fail-closed oranı**
- Rule regression corpus coverage
- Evidence schema'yı kabul eden auditor/partner sayısı
- **Security incident ve secret exposure: hedef sıfır**

## 12. Geliştirme ortamı: agent guardrail'leri sandbox değildir

Bu repository, Claude Code için `.claude/settings.json` içinde izin kuralları ve sandbox
ayarları taşır (ayrıntı: `docs/DEVELOPMENT.md` §3).

> **Project settings gerçek bir güvenlik sandbox'ı DEĞİLDİR.**

Bunlar bir **guardrail**dir: kazayı, dikkatsizliği ve istenmeyen komutu azaltır.
Bir izolasyon sınırı, güven sınırı veya saldırgan karşısında bir kontrol **değildir**.

Bundan çıkan bağlayıcı kurallar:

- **Production credential'ları Claude sürecine verilmez.** Üretim RPC anahtarları,
  control-plane token'ları ve müşteri verisi bu repository üzerinde çalışan bir agent
  oturumuna açılmaz. Geliştirme yalnız testnet/local kimlik bilgileriyle yapılır.
- Bir `deny` kuralının varlığı, o dosyanın **erişilemez olduğunu kanıtlamaz**; yalnız normal
  araç yolundan okunmasını engeller.
- Sandbox fail-closed yapılandırılmıştır (`failIfUnavailable: true`,
  `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed: false`), fakat platformda
  sandbox capability yoksa **güvenli alternatif WSL2 veya devcontainer'dır** — ayarı kapatmak
  değil.
- Gerçek izolasyon gerekiyorsa devcontainer, ayrı kullanıcı hesabı veya ayrı makine kullanılır.
- Ayarların kendisi bir saldırı yüzeyidir: `.claude/**` yazma işlemleri insan onayına
  (`ask`) bağlıdır ve gevşetme yönündeki her değişiklik incelenir.

Bu ayrım, ürünün kendi güven sınırı beyanıyla (§7) aynı dürüstlük standardına tabidir:
sağlamadığımız bir güvenceyi sağlıyormuş gibi sunmayız.
