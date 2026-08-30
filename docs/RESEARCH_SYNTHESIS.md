# Araştırma Sentezi

**Tarih kesimi:** 2026-08-30
**Milestone:** 00
**Amaç:** Sonraki hiçbir mühendisin kaynak PDF'i yeniden yorumlamak zorunda kalmaması.

Bu dosya dört etiketi **kesin olarak ayırır**:

| Etiket | Anlamı |
|---|---|
| `VERIFIED` | Bu oturumda birincil resmî kaynaktan (kaynak kod / resmî doküman / registry API) doğrudan doğrulandı. |
| `INFERENCE` | Doğrulanmış olgulardan çıkarılan mantıksal sonuç. Kaynak bunu bu cümleyle söylemiyor. |
| `ASSUMPTION` | Doğrulanmamış çalışma varsayımı. Yanlışlanabilir; yanlışlanırsa bağlı kararlar düşer. |
| `COMMERCIAL_HYPOTHESIS` | Pazar/fiyat/talep iddiası. Kanıtı yok, validasyon planına bağlıdır. |

---

## 1. Kaynak envanteri ve checksum

### 1.1 Yerel kaynaklar

| Dosya | SHA-256 | Boyut | Sayfa | Extraction |
|---|---|---|---|---|
| `PDF document.pdf` | `f2879abe27f4d41e3c2950af9a2f42fe12b138075e74243c30d23b9d2b79f016` | 284.797 B | 33 | Başarılı: 33/33 sayfa, 87.835 karakter, tam Türkçe diakritik |

**Extraction yöntemi:** Yerel, salt-okunur, yalnız Python stdlib (`re`, `zlib`, `base64`).
Üçüncü taraf servise upload **yapılmadı**. PDF `ASCII85Decode + FlateDecode` zinciri kullanıyor;
metin custom subset encoding ile kodlanmış, per-font `ToUnicode` CMap (3 font × 128 kod noktası)
parse edilerek çözüldü. Poppler/pdftotext yerel olarak mevcut değildi ve global install yasak
olduğu için stdlib extractor yazıldı.

### 1.2 Eksik kaynaklar — `UNKNOWN`

Prompt üç PDF'ten söz ediyor. Proje kökünde **yalnız bir PDF vardır**. Araştırma raporunun
kendi §2.1'i şu iki dosyayı incelediğini söylüyor, fakat bu dosyalar repository'de yoktur:

- `chat-avalanch projeHavuz.pdf` — **MEVCUT DEĞİL**
- `claude-Avalanche-Hakem-Raporu-Nihai-Siralama.pdf` — **MEVCUT DEĞİL**

**Etki değerlendirmesi:** Prompt bu ikisini "karar geçmişi ve önceliklendirme bağlamı" olarak
tanımlar; birincil kaynak olarak `PDF document.pdf`'i işaret eder ve o eksiksiz okunmuştur.
Bu nedenle milestone BLOCKED değildir. Ancak **karar geçmişine dair hiçbir iddia bu iki dosyaya
dayandırılamaz**; bu belgede öyle bir iddia yoktur. Fikrin neden bu şekilde önceliklendirildiği
sorusu `UNKNOWN` kalır.

### 1.3 Doğrulanan resmî kaynaklar (2026-08-30 kesimi)

| Ref | Kaynak | Erişim biçimi |
|---|---|---|
| `R01` | `github.com/ava-labs/icm-contracts` repo metadata | GitHub API |
| `R02` | `github.com/ava-labs/icm-services` repo metadata + ağaç | GitHub API |
| `R03` | `github.com/ava-labs/avalanche-interchain-token-transfer` metadata | GitHub API |
| `R04` | `icm-contracts/avalanche/ictt/TokenHome/TokenHome.sol` @ pinned SHA | raw.githubusercontent |
| `R05` | `icm-contracts/avalanche/ictt/TokenRemote/NativeTokenRemoteUpgradeable.sol` @ pinned SHA | raw.githubusercontent |
| `R06` | `icm-contracts/audits/` dizin listesi | GitHub API |
| `R07` | `ava-labs/icm-services` issue #1443 | GitHub API |
| `R08` | ACP-194 `194-continuous-execution/README.md` | raw.githubusercontent |
| `R09` | `ava-labs/avalanchego` `upgrade/upgrade.go` (master) | raw.githubusercontent |
| `R10` | `ava-labs/avalanchego` latest release | GitHub API |
| `R11` | Builder Hub — C-Chain config flags (`allow-unfinalized-queries`) | build.avax.network |
| `R12` | Builder Hub — ICTT overview (permissionless registration) | build.avax.network |
| `R13` | npm registry — `@avalanche-sdk/client`, `@avalanche-sdk/interchain` | registry.npmjs.org |

---

## 2. VERIFIED — birincil kaynaktan doğrulanmış olgular

### V01 — Sözleşme kaynağı taşındı; eski depolar arşiv

- `ava-labs/icm-contracts`: **archived = true**, son push `2025-12-03`. README: *"This repository has
  been moved in it's entirety to `icm-services`."* `[R01]`
- `ava-labs/icm-services`: **archived = false**, son push `2026-08-28`. `[R02]`
- `ava-labs/avalanche-interchain-token-transfer`: **archived = true**, son push `2024-12-03`. `[R03]`

**Sonuç:** Güncel ICTT/Teleporter sözleşme semantiğinin tek canonical kaynağı
`ava-labs/icm-services`, alt dizin `icm-contracts/avalanche/`'dır. Depo açıklaması ("Services for
relaying...") yalnız relayer'ı anlatır ve yanıltıcıdır; sözleşmeler alt dizindedir.

### V02 — Pinned commit

`8fef6ef73767f4497a72d8348a0774a262e0c535` — author date `2026-08-28T19:38:58Z`.
Bu belgede "kaynak koddan doğrulandı" denen her şey bu SHA'ya aittir. `[R02]`

### V03 — `teleporter` ve `teleporterV2` ayrı source tree'lerdir

`icm-contracts/avalanche/` altında `teleporter/` ve `teleporterV2/` **iki ayrı dizindir**.
`teleporterV2/` **yalnız `WarpAdapter.sol` içerir** — başka hiçbir dosya yok. `[R02]`

### V04 — `teleporterV2` audit kapsamında değildir

`icm-contracts/audits/` içeriği: ICTT Audit (2024-06-26, OpenZeppelin), Teleporter Audit
(2023-11-16, OpenZeppelin), Teleporter Upgradeable Audit (2024-01-10, Louis), Validator Manager
Incremental Audit (2025-05-07, OpenZeppelin). **`teleporterV2`/`WarpAdapter` için audit yoktur.** `[R06]`

### V05 — ICTT sözleşme aileleri

- `TokenHome/`: `TokenHome.sol` (soyut taban), `ERC20TokenHome.sol`, `ERC20TokenHomeUpgradeable.sol`,
  `NativeTokenHome.sol`, `NativeTokenHomeUpgradeable.sol`
- `TokenRemote/`: `TokenRemote.sol` (soyut taban), `ERC20TokenRemote.sol`,
  `ERC20TokenRemoteUpgradeable.sol`, `NativeTokenRemote.sol`, `NativeTokenRemoteUpgradeable.sol` `[R02]`

### V06 — Native arz getter'ının gerçek gövdesi

`NativeTokenRemoteUpgradeable.totalNativeAssetSupply()` `[R05]`:

```solidity
uint256 burned  = BURNED_TX_FEES_ADDRESS.balance + BURNED_FOR_TRANSFER_ADDRESS.balance;
uint256 created = $._totalMinted + getInitialReserveImbalance();
return created - burned;
```

Sözleşmenin kendi NatSpec'i, `initialReserveBalance`'ın **TokenHome tarafında teminatla
karşılanmadan önce bile dolaşımda olduğunu** açıkça yazar ve bu getter'ın `IERC20.totalSupply` ile
**karıştırılmaması** gerektiğini belirtir.

**Kritik okuma:** Bu bir bağımsız arz ölçümü değil, **takip edilen bileşenlerden yapılan bir
muhasebe yeniden inşasıdır**. Sözleşmenin dokümante ettiği "teminatsız dolaşan initial reserve"
gerçeği tek başına, bu değeri home teminatına karşı kesin eşitlik olarak kullanmayı geçersiz kılar.

### V07 — İlk teminat ayrı defterdir

`TokenHome.sol` `[R04]`:
- `RemoteTokenTransferrerSettings` alanları: `registered`, `collateralNeeded`, `tokenMultiplier`,
  `multiplyOnRemote`.
- `_addCollateral`: `_deposit` yapar, **`collateralNeeded`'ı azaltır**, fazlasını gönderene iade eder.
  **`_transferredBalances`'ı değiştirmez.**
- Kayıtta: `collateralNeeded = TokenScalingUtils.removeTokenScale(tokenMultiplier, multiplyOnRemote,
  message.initialReserveImbalance)`; `multiplyOnRemote == true` ve tam bölünmüyorsa **+1** yuvarlama.

**Sonuç:** Home bakiyesini yalnız `sum(transferredBalance)` ile karşılaştırmak ilk teminatı
açıklayamaz. Nöbetçi teminat olaylarını ayrı defterde tutmak zorundadır.

### V08 — Remote kaydı permissionless'tır; değerlendirme sorumluluğu kullanıcıdadır

Resmî ICTT dokümantasyonu `[R12]`: *"Anyone is able to deploy and register remote contracts, which
may have been modified from this repository. It is the responsibility of the users of the home
contract to independently evaluate each remote for its security and correctness."*

Bu, ürünün varlık gerekçesidir: ekosistemin güven modeli bu işi açıkça operatöre bırakır.

### V09 — ACP-194 kabul ile yürütmeyi ayırır

ACP-194 başlığı **"Continuous Execution"**, statüsü **`Implementable (Discussion)`** `[R08]`.
Yaşam döngüsü şuna dönüşür:

```
Proposed -> Accepted -> [değişken gecikme] -> Executed -> [τ saniye] -> Settled
```

C-Chain için `τ = 5s`. ACP metni açıkça: kabul edilmiş blokta sorgulanan state **yürütülmüş state'i
yansıtmaz**; `eth_getBlockReceipts` bloğun kendi işlemlerinin receipt'lerini döndürmelidir,
o blokta settle olanları değil.

### V10 — ACP-194 henüz hiçbir ağda aktif değildir

`avalanchego` `master` `upgrade/upgrade.go` `[R09]`: **Helicon**, hem Mainnet hem Fuji için
`UnscheduledActivationTime` (uzak-gelecek varsayılanı). Aktivasyon tarihi olan son upgrade
Granite'tir (Mainnet 2025-11-19, Fuji 2025-10-29).
En güncel resmî release **v1.14.2 "Granite.2"**, 2026-03-30; release notlarında Helicon veya
ACP-194 geçmiyor. `[R10]`

### V11 — Avalanche'ta kabul finaldir; confirmation depth kavramı yoktur

C-Chain `allow-unfinalized-queries` varsayılanı **`false`** `[R11]`. Bu varsayılanda `latest`,
kabul edilmiş (finalize olmuş) bloğu döndürür. Avalanche mutabakatında kabul geri alınamaz;
Ethereum'daki "N confirmation bekle" eşiği burada **anlamsızdır** ve finality kanıtı sayılamaz.

### V12 — Resmî TypeScript SDK'ları olgun değildir

`[R13]`, 2026-08-30 kesimi:
- `@avalanche-sdk/client` → latest **`0.1.2`** (1.0 öncesi)
- `@avalanche-sdk/interchain` → latest **`0.1.1-alpha.1`**, yayın **2025-10-16** (alpha; ~10 ay
  hareketsiz), açıklama: "Interchain package for handling ICM/ICTT messages"

### V13 — Issue #1443 açıktır

`ava-labs/icm-services#1443` `[R07]`: başlık *"WarpAdapter allows forged TeleporterV2 messages,
enabling remote ICTT token minting"*. **state: open**, created `2026-08-13T03:56:03Z`,
updated aynı gün, **assignee yok, label yok, PR yok**.

---

## 3. INFERENCE — doğrulanmış olgulardan çıkarımlar

- `I01` — `teleporterV2` **`UNSUPPORTED -> UNKNOWN`** olmalıdır.
  Dayanak: V03 (ayrı ağaç) + V04 (audit yok) + V13 (açık authorization iddiası). Kaynak "bunu
  desteklemeyin" demiyor; bu bizim fail-closed çıkarımımızdır.

- `I02` — Registry protocol version'dan ABI family çıkarılamaz.
  Dayanak: V03. Registry `TeleporterMessenger` sürümlerini yönetir; `teleporterV2` ise ayrı bir
  kaynak ağacıdır. İki numaralandırma aynı uzayda değildir. Eşitlemek fail-open hatasıdır.

- `I03` — Native remote için kesin arz eşitliği iddia edilemez.
  Dayanak: V06. Getter, takip edilen bileşenlerin farkıdır ve teminatsız `initialReserveImbalance`
  içerir. **Not:** Bunun *kesin bir üst sınır* olduğu da tek başına bu getter'dan kanıtlanamaz —
  üst sınır olması, arzı azaltan tüm yolların iki burn adresince yakalanmasına bağlıdır ve bu
  doğrulanmamıştır (bkz. `A03`). Bu yüzden hüküm dili `sufficient | indeterminate | unknown`'dır.

- `I04` — Bugünün truth anchor'ı geçerlidir, fakat **tarihli bir sona erme koşulu vardır**.
  Dayanak: V09 + V10 + V11. ACP-194 aktif olmadığı için kabul edilmiş blok bugün yürütülmüş
  state'i taşır. Helicon aktive olduğu an bu varsayım düşer ve truth anchor `settled` bloğa
  kaymak zorundadır. Bkz. `docs/adr/0002-accepted-quorum-truth.md`.

- `I05` — Canonical hesap resmî SDK'ya bağlanamaz.
  Dayanak: V12. Alpha ve 10 ay hareketsiz bir paket, ekonomik hüküm üreten yolun temeli olamaz.
  Truth path pinlenmiş ABI + genel EVM istemcisi (viem/ethers) üzerinden yürümeli; SDK yalnız
  keşif/kolaylık katmanında, opsiyonel kalmalıdır.

- `I06` — Ürünün P0 sırası muhasebe değil, yetkilendirmedir.
  Dayanak: V08 + V13. Permissionless kayıt + sender/origin authorization sınıfı bir açık iddiası,
  `CFG-*` ve `MSG-001` kurallarını `ACC-*` kurallarından **önce** zorunlu kılar.

---

## 4. ASSUMPTION — doğrulanmamış çalışma varsayımları

| ID | Varsayım | Yanlışlanırsa ne düşer? | Nasıl test edilir? |
|---|---|---|---|
| `A01` | Helicon/ACP-194 en az MVP penceresi boyunca Mainnet'te aktif olmayacak | ADR-0002 truth anchor'ı; tüm pinned-block modeli revizyon ister | `upgrade.go` ve release notlarını her milestone'da yeniden oku |
| `A02` | Hedef operatörler archive-depth'i yeterli RPC erişimi verebilir | `replay --from-deployment` ve tarihsel kanıt yolu | 10 günlük sprint Gün 7 shadow replay |
| `A03` | `totalNativeAssetSupply` arzı azaltan yolların tamamını yakalar (yani gerçek üst sınırdır) | Native `sufficient` hükmü; `indeterminate`'e düşer | Source-lock milestone'unda tüm burn/transfer yollarının denetimi |
| `A04` | Tanınmış fingerprint kümesi gerçek deployment'ların anlamlı bir kısmını kapsar | Support matrix'in pratik değeri; her şey UNKNOWN'a düşer | Gerçek config alındığında bytecode fingerprint denemesi |
| `A05` | İki bağımsız provider family gerçekten bağımsız upstream kullanır | Quorum witness'ın anlamı | Provider family census; ortak arıza testi |
| `A06` | Manifest'in beyan ettiği topoloji operatörce gerçekten onaylanır | Baseline'ın meşruiyeti; drift tespiti anlamsızlaşır | `discover` çıktısının operatör imzalı diff'i |

---

## 5. COMMERCIAL_HYPOTHESIS — kanıtı olmayan ticari iddialar

Aşağıdakilerin **hiçbiri doğrulanmamıştır**. Araştırma raporu bunu kendisi açıkça kabul eder
(§2.3, §13.1) ve bu belgede fırsat olarak sunulmazlar.

- `H01` — Doğrulanmış, canlı, eksiksiz ICTT deployment census'u **yoktur**. Lamina1/Tesseract/
  ChainArq örnekleri talebin sıfır olmadığını gösterir; müşteri sayımı değildir.
- `H02` — Avalanche-only toplam adreslenebilir pazar ve ödeme isteği **bilinmiyor**.
- `H03` — Fiyat çıpaları (Evidence Sprint 2.500-5.000 $; onboarding 5.000-15.000 $;
  managed 1.000-3.000 $/ay; enterprise 30.000-100.000 $ ARR) **doğrulanmış fiyat değil**,
  görüşmede test edilecek çıpalardır.
- `H04` — Senaryo tablosu (düşük ~24k$, baz ~164k$, yüksek ~800k$) **TAM/SAM/SOM değildir**;
  yalnız hassasiyet gösterimidir.
- `H05` — Market pull skoru **7/15** → `GO-VALIDATE / PIVOT`, full-build değil.
- `H06` — Hexagate'in Avalanche erişiminin ücretsiz olması en güçlü negatif sinyaldir; koşullar
  zamanla değişebilir ve bu bağımsız olarak doğrulanmamıştır.
- `H07` — Rakiplerin fiyatları ve yanlış-alarm performansı **bilinmiyor**; rakip kabiliyetleri
  yalnız sağlayıcıların kendi sayfalarından alınmıştır, bağımsız doğrulama değildir.

---

## 6. Çelişki günlüğü

Araştırma PDF'i ile bu oturumda doğrulanan olgular veya proje anayasası arasındaki çelişkiler.
Çözüm ilkesi: **daha yeni, daha somut ve birincil kaynakla desteklenen iddia kazanır.**

### C01 — `confirmations: 12` (ÇÖZÜLDÜ: PDF reddedildi)

PDF §9.3'teki örnek manifest `policy.confirmations: 12` içerir. Bu **Ethereum tarzı confirmation
depth**'tir ve V11 ile doğrudan çelişir: Avalanche'ta kabul finaldir, derinlik eşiği finality
kanıtı değildir. Ayrıca anayasanın açık yasağıdır.
**Karar:** Alan reddedildi. Yerine adlandırılmış finality policy + `maxRpcLagSeconds` +
`rpcWitnessesRequired` kullanılır. Bkz. `docs/DATA_MODEL.md`.

### C02 — Native formülünün terimleri (ÇÖZÜLDÜ: kaynak kod kazandı)

PDF §6.5 formülü `... - reportedBurnedFees - burnedForTransfer` yazar. Kaynak kod (V06) ise
**iki burn adresinin canlı bakiyesini** okur. Ayrıca sözleşmede ayrı bir `reportBurnedTxFees`
mekanizması vardır; bu, "reported" terimiyle karıştırılmamalıdır.
**Karar:** Adapter kaynak koda göre yazılır. İki kavramın ayrımı source-lock milestone'una
devredildi; tahminle kapatılmayacak.

### C03 — Truth anchor ve ACP-194 (ÇÖZÜLDÜ: tarihli tetikleyici eklendi)

PDF, kabul edilmiş state'i truth anchor kabul eder ve ACP-194'ten hiç söz etmez. V09 bu ayrımı
getirir; V10 ise henüz aktif olmadığını gösterir.
**Karar:** V0 varsayılanı korunur (PDF bugün için haklı), fakat ADR-0002'ye tarihli ve
doğrulanabilir bir sona erme koşulu yazıldı. Varsayım tek taraflı değiştirilmedi.

### C04 — Resmî SDK'ya güven (ÇÖZÜLDÜ: PDF yumuşatıldı)

PDF §5.1/§10.4 resmî SDK'yı ICTT istemcisi olarak önerir. V12, `interchain` paketinin alpha ve
~10 ay hareketsiz olduğunu gösterir.
**Karar:** SDK canonical hüküm yolundan çıkarıldı; opsiyonel keşif katmanına indirildi (`I05`).

### C05 — "icm-services" adının yanıltıcılığı (ÇÖZÜLDÜ: açıklığa kavuşturuldu)

PDF, güncel semantik için `icm-services`'i esas aldığını söyler. Depo açıklaması yalnız relayer'ı
anlatır; ilk bakışta çelişkili görünür. V01 doğruladı: `icm-contracts` bütünüyle bu depoya
taşınmıştır ve sözleşmeler `icm-contracts/avalanche/` alt dizinindedir. **PDF haklıdır.**

### C06 — Kaynak PDF'lerin sayısı (AÇIK: UNKNOWN)

Prompt üç PDF sayar; kökte bir tane vardır (§1.2). Karar geçmişi bağlamı doğrulanamadı.
**Karar:** Karar geçmişine dayanan hiçbir iddia üretilmedi.

---

## 7. Bu sentezden çıkan bağlayıcı sonuçlar

1. Canonical kaynak `ava-labs/icm-services @ 8fef6ef…c535`, alt dizin `icm-contracts/avalanche/`.
   Moving `main` ref canonical değildir.
2. `teleporterV2` desteklenmez → `UNKNOWN`. Registry version'dan ABI family çıkarılmaz.
3. Native remote için kesin arz/solvency iddiası yasaktır; yalnız
   `sufficient | indeterminate | unknown`.
4. İlk teminat (`collateralNeeded`) `transferredBalance`'tan **ayrı** defterde tutulur.
5. Confirmation depth kullanılmaz; finality policy adlandırılmış semantiktir.
6. ACP-194 her milestone'da yeniden kontrol edilecek tarihli bir risktir.
7. Ticari tez kanıtsızdır; 10 günlük kapı geçilmeden full build yoktur.
