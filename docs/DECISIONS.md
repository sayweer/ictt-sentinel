# Karar Kaydı

**Tarih kesimi:** 2026-08-30

ADR'ler `docs/adr/` altındadır. Bu dosya ADR'leri **indeksler** ve ADR gerektirmeyen fakat
bağlayıcı olan kararları kaydeder.

---

## 1. ADR indeksi

| ADR | Başlık | Durum | Özet |
|---|---|---|---|
| [0001](adr/0001-keyless-read-only.md) | Anahtarsız ve salt-okunur mimari | Kabul | Signer yok, chain-write yok, auto-pause yok, generic RPC yüzeyi yok |
| [0002](adr/0002-accepted-quorum-truth.md) | Accepted-state + provider quorum truth path | Kabul (**tarihli sona erme**) | Pinned-block + çok-witness; webhook fact yazamaz; ACP-194 tetikleyicisi |
| [0003](adr/0003-fail-closed-verdicts.md) | Fail-closed hükümler, UNKNOWN birinci sınıf | Kabul | `CRITICAL > required UNKNOWN > WARN > OK`; UNKNOWN asla yeşil |
| [0004](adr/0004-icm-assurance-scope.md) | ICM assurance kapsamı | Kabul (V0) | `ACCEPTED_STATE_ASSURANCE`; bağımsız BLS/predicate doğrulaması **iddia edilmez** |

---

## 2. ADR'siz bağlayıcı kararlar

### D-01 — Canonical isimlendirme

`ictt-sentinel` (repo/ürün) · `@ictt-sentinel/*` (npm scope) · `ictt-sentinel` (CLI) ·
`ICTT_SENTINEL_` (env prefix).

Türkçe uzun ad yalnız açıklamadır; identifier/slug olarak kullanılmaz.
Mevcut çalışma klasörü yeniden adlandırılmaz.

### D-02 — Canonical kaynak `icm-services` @ pinned SHA

Sözleşme semantiğinin tek kaynağı `github.com/ava-labs/icm-services` @
`8fef6ef73767f4497a72d8348a0774a262e0c535`, alt dizin `icm-contracts/avalanche/`.

**Gerekçe:** `ava-labs/icm-contracts` archived (2025-12-03) ve README'si taşınmayı beyan ediyor;
`avalanche-interchain-token-transfer` archived (2024-12-03). Moving `main` ref canonical değildir.

### D-03 — `teleporterV2` desteklenmez

`icm-contracts/avalanche/teleporterV2/` (yalnız `WarpAdapter.sol`) → `UNSUPPORTED -> UNKNOWN`.

**Gerekçe:** Ayrı source tree; `audits/` dizininde **audit yok**; `#1443` açık.

**Bağlı kural:** Teleporter registry protocol version'dan **ABI family çıkarılmaz**.
İki numaralandırma aynı uzayda değildir. ABI family yalnız bytecode/implementation
fingerprint ile belirlenir.

### D-04 — Native remote için exact supply iddiası yasak

`NativeTokenRemote` arzı **hiçbir yerde** exact circulating-supply eşitliği olarak raporlanmaz.
Yalnız `sufficient` / `indeterminate` / `unknown`.

**Gerekçe:** `totalNativeAssetSupply()` bir muhasebe yeniden inşasıdır; sözleşmenin kendi
NatSpec'i `initialReserveBalance`'ın teminatla karşılanmadan dolaşımda olduğunu yazar.
Ayrıca bunun *kesin üst sınır* olduğu da doğrulanmamıştır (`RESEARCH_SYNTHESIS.md` A03).

### D-05 — İlk teminat ayrı defterde

`_addCollateral` `collateralNeeded`'ı azaltır, `_transferredBalances`'ı **artırmaz**
(kaynak koddan doğrulandı). Bu yüzden `A_r = T_r + C_r` ancak adapter **çift sayımı dışladıktan
sonra** geçerlidir.

### D-06 — `confirmations` alanı reddedildi

Araştırma PDF'inin örnek manifestindeki `policy.confirmations: 12` **kaldırıldı**.
Şema bu alanı bilinmeyen alan hatası olarak **reddetmelidir**, sessizce yok saymamalıdır.

**Gerekçe:** Ethereum tarzı confirmation depth Avalanche'ta anlamsızdır ve finality kanıtı
sayılamaz. Yerine `policy.finality` adlandırılmış semantik alır.

### D-07 — Resmî SDK canonical hüküm yolunda kullanılmaz

`@avalanche-sdk/interchain` `0.1.1-alpha.1` (2025-10-16'dan beri hareketsiz) ve
`@avalanche-sdk/client` `0.1.2` yalnız **opsiyonel keşif katmanındadır**.
Ekonomik hüküm yolu pinlenmiş ABI + genel EVM istemcisi (viem/ethers) üzerinden yürür.

### D-08 — Kural yürütme sırası: yetkilendirme önce

`CFG-*` ve `MSG-001` (sender/origin authorization), `ACC-*` muhasebe kurallarından **önce**
çalışır.

**Gerekçe:** Permissionless kayıt (resmî doküman) + `#1443` authorization sınıfı iddia.
Yanlış ABI/rota üzerinde yapılan muhasebe hesabı anlamsızdır.

### D-09 — `bigint` / base-unit zorunlu

Token aritmetiğinde float ve JS `number` yasaktır; veritabanında `DOUBLE PRECISION` yasaktır.

### D-10 — Araştırma PDF'leri repository'e girmez

`.gitignore` ile `*.pdf` hariç tutulur. **Kullanıcının açık talebi.**

> **Not:** Kullanıcı başlangıçta PDF'in `.env`'e eklenmesini istemişti. `.env` bir dosyayı
> Git'ten gizlemez; doğru mekanizma `.gitignore`'dur. Kullanıcı onayıyla `.gitignore` kullanıldı.

### D-11 — Git'e bu milestone'da dokunulmadı

Milestone 00'ın kendi kapsam tanımı git commit/push'u ve init'i kapsam dışı bırakır.
Kullanıcının "proje boyunca commit at" talimatı, kullanıcı onayıyla bir sonraki milestone'a
ertelendi. Repository zaten mevcuttu (`main`, commit yok).

**Kalıcı kural:** Commit yalnız kullanıcı açıkça istediğinde, **yalnız kullanıcı adına** ve
**hiçbir Claude atfı olmadan** atılır (`CLAUDE.md` §8).

### D-12 — Monorepo katman sözleşmesi makine-okunur

Her workspace `package.json` iki alan taşır: `ictt-sentinel.layer` (0 saf çekirdek → 3 app) ve
`ictt-sentinel.mayDependOn` (izin verilen kenarlar).

**Gerekçe:** Bağımlılık yönü ("içe doğru") bir dokümantasyon dileği değil, `verify:config` ile
denetlenen bir kural olmalı. Kural: bir paket yalnız **aynı veya daha düşük** katmana bağımlı
olabilir ve graf **döngüsüz** olmalıdır; `domain` bağımlılık köküdür (`mayDependOn: []`).

Bu, standart bir `package.json` alanı değildir; npm/pnpm tarafından yok sayılır ve runtime
etkisi yoktur.

### D-13 — `pnpm-workspace.yaml` tek workspace kaynağı

Kök `package.json` bilinçli olarak `workspaces` alanı **taşımaz**; workspace glob'ları yalnız
`pnpm-workspace.yaml`'dadır. İki yerde tanımlamak ikinci bir kaynak-of-truth yaratırdı.
`verify:config` kök `package.json`'da `workspaces` görürse başarısız olur.

### D-14 — Claude izin modeli: `default` mode, fail-closed sandbox

`.claude/settings.json`, resmî şemaya (`json.schemastore.org/claude-code-settings.json`)
göre yazılmıştır; uydurma field veya permission mode yoktur.

- `permissions.defaultMode = "default"` (interactive; ilk kullanımda sorar)
- `permissions.disableBypassPermissionsMode = "disable"`, `disableAutoMode = "disable"`
- Sandbox fail-closed: `failIfUnavailable`, `allowUnsandboxedCommands: false`,
  `autoAllowBashIfSandboxed: false`
- `enableAllProjectMcpServers: false` — project MCP otomatik açılmaz
- `attribution = {commit:"", pr:"", sessionUrl:false}` — Claude atfı kapalı (`CLAUDE.md` §8)

**`git commit` deny değil `ask`tır.** Gerekçe: kullanıcı proje boyunca kendi adına commit
atılmasını istiyor; deny bunu tamamen imkânsız kılardı. `git push`, publish ve dışa dönük
işlemler **deny**dir.

**Env deny çakışması test edilir:** `.env.example` okunabilir kalmalı, gerçek env dosyaları
deny olmalıdır. Bu yüzden wildcard yerine dosya adları tek tek yazılmıştır ve
`verify:config` bunu hem pozitif hem negatif örneklerle sınar.

---

## 3. Bilinçli olarak ertelenmiş kararlar

Bunlar **tahmin edilmedi**; ilgili milestone'a devredildi.

| ID | Karar | Neden ertelendi | Nereye |
|---|---|---|---|
| `P-01` | ABI artifact hash'leri ve compiler provenance | Yerel build gerekir; dependency kurmak kapsam dışı | Source-lock milestone |
| `P-02` | Supported bytecode fingerprint kümesi | Derleme + deployed-bytecode çıkarımı gerekir | Source-lock milestone |
| `P-03` | `reportBurnedTxFees` ↔ `BURNED_TX_FEES_ADDRESS.balance` ilişkisi | Hedefli kaynak okuması gerekir; formül tahminle kapatılmayacak | Source-lock milestone |
| `P-04` | Registry version ↔ implementation fingerprint eşleme tablosu | Registry state okuması gerekir; **çıkarım yasak** | Adapter milestone |
| `P-05` | Causal accounting formülünün nihai hali | Sürüm bazlı event/getter semantiğine bağlı | Adapter + property test milestone |
| `P-06` | Monorepo iskeleti | — | **Milestone 01'de tamamlandı** |
| `P-07` | Helicon/ACP-194 Fuji aktivasyon durumu | Resmî kaynak `unscheduled`, ikincil kaynak çelişkili | Her milestone başında yeniden kontrol |
| `P-08` | Dependency kurulumu, lint/typecheck/test/build kapıları ve CI | Milestone 01 kapsamı dışı | Milestone 02 |
| `P-09` | `.env.example` içeriği | Milestone 01 kapsamı dışı | Milestone 03 |

---

## 3.1 Kullanıcıdan beklenen kararlar

Bunlar **teknik olarak çözülemez**; sahibinin seçmesi gerekir. Seçilene kadar hiçbir varsayım
kodlanmamıştır.

| ID | Karar | Bugünkü durum | Neden kullanıcı kararı |
|---|---|---|---|
| `Q-01` | **LICENSE seçimi** | `package.json` → `UNLICENSED`; kökte `LICENSE` dosyası **yok** | Açık kaynak mı, kaynak-açık mı, tescilli mi? Kill senaryosunda çıktı "açık kaynak primitive" olabilir (`PRODUCT.md` §11) — bu lisans seçimini doğrudan etkiler. Apache-2.0 patent hükmü, MIT sadeliği ve BUSL ticari koruması farklı sonuçlar doğurur. |
| `Q-02` | **Node/pnpm pin sapması** | Pin: Node `24.20.0` (LTS), pnpm `11.10.0`. Makinede kurulu: Node `26.0.0` (**LTS değil**), pnpm `11.24.0` | Prompt bu pinleri belirtti; sürüm kendiliğinden değiştirilmez (`CLAUDE.md` §6). Ya `nvm use` ile pine geçilir ya da pin bilinçli olarak güncellenir. |
| `Q-03` | **Repository görünürlüğü** | GitHub remote'u `sayweer/ictt-sentinel` olarak yapılandırıldı; görünürlük ve yayınlama sahibi tarafından yönetilir | Public repository, `SECURITY.md` disclosure kanalını ve `teleporterV2`/#1443 duruşunun görünürlüğünü etkiler. |
| `Q-04` | **Sandbox ağ allowlist'i** | `registry.npmjs.org`, `nodejs.org`, `json.schemastore.org` | Docker image çekme veya ek registry gerekirse liste genişletilmelidir; bu bir güvenlik kararıdır, sessizce yapılmaz. |

---

## 4. Karar ağacı — ürün seviyesi

```
Gerçek read-only ICTT config erişimi var mı?
  Hayır -> Full build yok; outreach/census veya OSS araştırma
  Evet
    |
Üç kontrollü failure deterministik yakalandı mı?
  Hayır -> Teknik tez NO-GO; adapter/semantik düzelt
  Evet
    |
En az bir yazılı ücretli pilot niyeti var mı?
  Hayır -> SaaS NO-GO; OSS/audit entegrasyonu
  Evet
    |
İki ücretli pilot ve tekrar edilebilir referral var mı?
  Hayır -> Services-led dar pilot; yatırım sınırlı
  Evet -> 8-12 haftalık MVP GO
```

## 5. Kodlamaya geçmeden önce — son kontrol listesi

Her madde **EVET** olmalıdır:

- [ ] Bir gerçek ICTT operator config'i salt-okunur alınabildi
- [ ] Sözleşme sürümü ve token modu fingerprint edildi
- [ ] ERC20 ve native kanıt dili buyer/auditor tarafından anlaşıldı
- [ ] Üç controlled failure yakalandı
- [ ] Delivery/execution ayrımı demo edildi
- [ ] Gap/RPC ayrışması yeşil değil `UNKNOWN` verdi
- [ ] İlk evidence 60 dakikadan kısa sürede çıktı
- [ ] En az bir yazılı ücretli pilot niyeti var
- [ ] Auto-pause/signing key kapsam dışında tutuldu
- [ ] Full build kararı kill kriterlerine göre yazılı alındı

> **Son söz:** Bu fikir teknik olarak güçlü olduğu için değil, **yanlış kesinlik üretmeden
> çalışabildiği** ve mevcut araçların üzerine ICTT semantiği ekleyebildiği ölçüde değerlidir.
> İlk ürün bir alarm paneli değil, operatörün ve auditor'ın aynı bloklarda aynı sonuca
> ulaşmasını sağlayan **kanıt makinesidir**.
