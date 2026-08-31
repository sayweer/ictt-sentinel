# ADR-0006 — Protokol kaynak kilidi, ABI/fingerprint ve SDK sınırı

- **Durum:** Kabul edildi
- **Tarih:** 2026-08-31
- **Milestone:** 04
- **İlgili:** ADR-0002 (truth anchor), ADR-0003 (fail-closed), ADR-0004 (assurance kapsamı),
  ADR-0005 (toolchain), `docs/PROTOCOL_SOURCE_LOCK.md`

---

## Bağlam

Bir contract'ın byte'larını yanlış ABI ile çözmek hata vermez — **kendinden emin yanlış bir sayı**
üretir. Bu ürün için en ağır failure mode budur. Bu yüzden adapter katmanı, semantiği değişmez bir
resmî kaynağa bağlamadan hiçbir şeyi yorumlayamaz.

## Karar

### 1. Tek canonical kaynak, tam commit SHA

```
repository : https://github.com/ava-labs/icm-services
commit     : 8fef6ef73767f4497a72d8348a0774a262e0c535   (2026-08-28T19:38:58Z)
sözleşmeler: icm-contracts/avalanche/
```

Moving `main`/`latest`/`HEAD` ref'i canonical kaynak **değildir**. Arşiv depolar
(`icm-contracts`, `avalanche-interchain-token-transfer`) yalnız tarihsel bağlamdır; bir
deployment'ın exact commit/fingerprint eşleşmesi kanıtlanmadıkça legacy adapter kaynağı olamaz.

### 2. Build provenance — `foundry.toml`'dan okundu

```
solc          0.8.30
evm_version   shanghai
optimizer     true, 200 runs
bytecode_hash none
```

Submodule pinleri (derlenen çıktıya girer):

```
forge-std                          7117c90c8cf6c68e5acce4f09a6b24715cea4de6
openzeppelin-contracts-upgradeable fa525310e45f91eb20a6d3baa2644be8e0adba31
solidity-merkle-trees              03832eb448ab77e5010281d7894c77b92a0640ad
```

> **`bytecode_hash = "none"`** önemli: resmî build metadata hash'ini **siliyor**. Bu, bytecode'un
> kendi içinde derleyici parmak izi taşımadığı anlamına gelir. Exact bir eşleşme yine exact'tir,
> fakat **hangi derleyicinin ürettiğini kendi kendine kanıtlayamaz**. Bu yüzden compiler/optimizer
> ayarları descriptor'da ayrıca kayıtlıdır.

### 3. Hangi hash'ler üretildi, hangisi üretilemedi

| Hash | Durum | Nasıl |
|---|---|---|
| `sourceSha256` | **VERIFIED** | Pinlenmiş commit'teki `.sol` dosyasının sha256'sı |
| `sourceGitBlobSha` | **VERIFIED** | Git'in kendi content id'si; GitHub API'ye karşı doğrulanabilir |
| `abiSha256` | **VERIFIED** | Resmî Go binding'indeki ABI'nin canonical (sıralı anahtar, boşluksuz) formunun sha256'sı |
| `creationBytecodeSha256` | **VERIFIED** | Aynı binding'deki `Bin` alanının sha256'sı |
| **`runtimeBytecodeSha256`** | **ÜRETİLEMEDİ** | Constructor yürütmesi ve immutable enjeksiyonu gerektirir |

**Runtime bytecode neden yok:** Deployed kod (`eth_getCode`'un döndürdüğü), creation bytecode'un
constructor çalıştıktan ve immutable'lar yerleştikten sonraki halidir. Bunu yayınlanmış
artifact'lardan türetmek mümkün değildir; yerel derleme ise bu ortamda mevcut değil (solc/foundry
yok, global install yasak).

**Sonuç — tasarım kararı:** Pinlenmiş commit **kaynağı ve ABI'yi** sabitler; bir deployment'ın
**runtime code hash'i operatör tarafından attest edilir** (manifest `fingerprint.runtimeCodeHash` /
`allowedImplementationHashes`) ve değerlendirme anında `eth_getCode` ile karşılaştırılır. Bu, M00'da
`T03` olarak açık bırakılan boşluğun kapatılma biçimidir: **tahmin edilmedi, sorumluluğu adlandırıldı.**

### 4. `teleporter` ile `teleporter-v2-experimental` ayrı protocol family'dir

`icm-contracts/avalanche/teleporterV2/` **yalnız `WarpAdapter.sol`** içerir ve ayrı bir kaynak
ağacıdır. Bu build'de:

- family listesi: `ictt`, `teleporter`, `utilities` — **`teleporter-v2-experimental` yok**
- fingerprint bilinse bile sonuç `unsupported`, `interpretable: false`
- audit coverage: **`never-audited`**
- `ava-labs/icm-services#1443` açık (WarpAdapter caller authorization)

**Registry protocol version'dan family çıkarmak yasaktır.** Bu kural bir yorum değil, çağrıldığında
**atan bir fonksiyondur** (`familyFromRegistryVersion`), böylece hata bir isme ve teste sahiptir.
Registry `version == 2`, `teleporterV2` ABI/family anlamına **gelmez**.

### 5. Audit iddiaları denetlenen commit'e bağlıdır

Upstream `audits/README.md` her audit için exact commit veriyor. Kısa SHA'lar tam SHA'ya çözüldü:

| Audit | Denetlenen commit | Depo | Kapsam |
|---|---|---|---|
| OpenZeppelin, 2023-11-16 | `6ba46565a72a7dabb159d74963d7abc525fb6486` | `icm-contracts` (arşiv) | `contracts/teleporter/` üst düzey |
| Louis, 2024-01-10 | `9fcdf42da263f3e3d3a60ccf1272d9394eac06d4` | `icm-contracts` (arşiv) | `registry` + `utilities`'in bir kısmı |
| OpenZeppelin, 2024-06-26 | `9e03a1e5177e4ad8d1edcedf529e71bb2f4a8d99` | `icm-contracts` (arşiv) | `contracts/ictt/` (mocks hariç) |

**Hiçbiri pinlediğimiz commit değildir.** Üstelik hepsi arşiv depoda ve farklı yol düzeninde
(`contracts/ictt/` → `icm-contracts/avalanche/ictt/`). Upstream README'nin kendisi uyarıyor:
*"Please exercise caution when using code newer than the audited commit."*

**Bağlayıcı sonuç:** Bu build hiçbir sözleşme için `covered-at-pinned-commit` iddia **etmez**.
Coverage değeri `audited-at-a-different-commit`'tir. "Repo audited" genellemesi yasaktır ve
`auditCoverageFor()` bunu testle zorlar.

### 6. Kritik muhasebe semantiği — kaynaktan doğrulandı

| Bulgu | Kanıt |
|---|---|
| **Canonical ERC20 remote'un initial reserve imbalance'ı yapısal olarak SIFIR** | `__ERC20TokenRemote_init` → `__TokenRemote_init(settings, **0**, tokenDecimals)`; `initialReserveImbalance` bu dosyada başka hiç geçmiyor |
| ERC20 remote doğuştan `isCollateralized` | `__TokenRemote_init_unchained`: `_isCollateralized = initialReserveImbalance_ == 0` |
| **Native remote sıfır reserve'i REDDEDER** | `require(initialReserveImbalance != 0, ...)`; ayrıca decimals **18** sabit |
| `_addCollateral` `transferredBalance`'a dokunmaz | Fonksiyon gövdesinde `_transferredBalances` **0 kez** geçiyor |
| `collateralNeeded` +1 yuvarlaması | `if (multiplyOnRemote && imbalance % tokenMultiplier != 0) collateralNeeded += 1` |
| `remoteTokenDecimals <= 18` zorunlu | `_registerRemote` require |

**Bunun anlamı:** Canonical ERC20 rotasında `C_r` (kabul edilmiş ilk teminat) **yapısal olarak
sıfırdır**, dolayısıyla `A_r = T_r`. Promptun uyardığı "keyfi initial collateral terimi" bu rota
için **eklenmemelidir** — ve artık bunun gerekçesi kaynak koddan gelir, varsayımdan değil.

### 7. Native supply getter'ı: üst sınır **minter münhasırlığına bağlıdır**

```solidity
burned  = BURNED_TX_FEES_ADDRESS.balance + BURNED_FOR_TRANSFER_ADDRESS.balance;
created = _totalMinted + getInitialReserveImbalance();
return created - burned;
```

`reportBurnedTxFees()` ayrı bir kanaldır: `BURNED_TX_FEES_ADDRESS.balance` deltasını alır,
bir ödül yüzdesini **yeniden mint eder** (`_totalMinted` artar) ve kalanı home'a bildirir.

**Sınırın koşulu:** Native coin, bilinen iki burn adresi dışındaki bir adrese gönderilerek de
dolaşımdan çıkabilir; bu düşülmez, yani raporlanan değer gerçek harcanabilir arzı **aşar** —
üst sınır bu yönde korunur. Fakat bu sözleşme **tek minter değilse** (genesis tahsisi veya başka
allowlisted minter), gerçek arz raporlanan değeri **aşabilir** ve üst sınır **düşer**.

**Sonuç:** `totalNativeAssetSupply()` bir üst sınırdır **ancak ve ancak** minter münhasırlığı
sağlanmışsa. Bu, M00'daki belirsiz `A03` varsayımının yerine geçen kesin ifadedir ve
`CFG-006`'ya (native minter allowlist/münhasırlık) doğrudan bağlıdır. Tip sisteminde
`upperBoundRequiresMinterExclusivity: true` alanı bunu taşır.

### 8. SDK ve EVM okuma bağımlılığı

- `@avalanche-sdk/interchain` (`0.1.1-alpha.1`, 2025-10-16'dan beri hareketsiz) ve
  `@avalanche-sdk/client` (`0.1.2`) **bu milestone'da eklenmedi**. Alpha bir yüzey, canonical
  hüküm yolunda değildir (ADR-0005, `PROTOCOL_SOURCE_LOCK` §7).
- **`viem` de eklenmedi.** Bu milestone'un ihtiyacı keccak256 ve selector/topic hesabıdır;
  bunun için **`@noble/hashes@2.3.0`** (sıfır bağımlılık, install lifecycle script'i yok) yeterli.
  viem ayrıca `@scure/bip32` ve `@scure/bip39` çekiyor — sıfır signing key vaadi olan bir ürüne
  HD wallet türetme kodunu, henüz kullanılmayan bir işlevsellik için sokmak erken bir genişleme
  olurdu.
- EVM istemcisi ve tam ABI decoder seçimi **RPC milestone'una** (05) ve kendi ADR'ına bırakıldı.

## Sonuçlar

### Olumlu

- Her supported adapter değişmez kaynak + ABI hash + fingerprint setine bağlı.
- Moving branch veya heuristic decoder runtime kararı veremiyor: family gate + exact fingerprint
  eşleşmesi olmadan `interpretable: false`.
- Audit iddiası abartılamıyor; kod bunu testle zorluyor.
- Implementation upgrade'i replay'i **tam `(block, txIndex, logIndex)` sınırında** bölüyor.

### Olumsuz / kabul edilen maliyet

- **Runtime bytecode hash'i biz üretemiyoruz**; operatör attestation'ına bağımlıyız. Bu, güven
  zincirinde gerçek bir halka ve açıkça öyle raporlanıyor.
- Pinlenmiş kaynak **hiçbir audit kapsamında değil**; ürün dili bunu yansıtmak zorunda.
- ABI decoding henüz yok; `Observation` tipleri sözleşmeyi tanımlıyor, decoder 05'te geliyor.

## Alternatifler ve neden reddedildi

| Alternatif | Neden reddedildi |
|---|---|
| Yerel derleme ile runtime hash üretmek | solc/foundry yok; global install yasak |
| Bytecode'u creation'dan heuristik olarak kesmek | Constructor/immutable semantiği gerektirir; tahmin olurdu |
| viem eklemek | Bu milestone'da kullanılmayacak; BIP-32/39 yüzeyi erken genişleme |
| Registry version'dan family çıkarmak | Fail-open hata; iki numaralandırma aynı uzayda değil |
| `teleporterV2`'yi "yeni sürüm" saymak | Ayrı kaynak ağacı, audit yok, açık authorization raporu |
| Audit'i repo geneline genellemek | Upstream'in kendi uyarısına aykırı ve yanlış |
