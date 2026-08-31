# Protokol Kaynak Kilidi

**Tarih kesimi:** 2026-08-31 · **reviewedAt:** 2026-08-31 (Milestone 04)

Bu dosya, runtime semantiğinin **hangi değişmez kaynağa** dayandığını kilitler.
Moving `main` / `latest` / `HEAD` ref'i **canonical source olarak kullanılmaz.**

---

## 1. Canonical repository

| Alan | Değer | Statü |
|---|---|---|
| Repository URL | `https://github.com/ava-labs/icm-services` | `VERIFIED` |
| Pinned commit SHA | `8fef6ef73767f4497a72d8348a0774a262e0c535` | `VERIFIED` |
| Commit author date | `2026-08-28T19:38:58Z` | `VERIFIED` |
| Sözleşme kök yolu | `icm-contracts/avalanche/` | `VERIFIED` |
| Archived | `false` | `VERIFIED` |

**Neden bu depo:** `ava-labs/icm-contracts` **archived** (son push `2025-12-03`) ve README'si
*"This repository has been moved in it's entirety to `icm-services`"* der. Depo açıklaması
("Services for relaying Avalanche ICM messages between L1s") yalnız relayer'ı anlatır ve
yanıltıcıdır — **sözleşmeler `icm-contracts/` alt dizinindedir.**

### Arşiv depolar — canonical DEĞİL

| Repository | Archived | Son push | Kullanım |
|---|---|---|---|
| `ava-labs/icm-contracts` | `true` | `2025-12-03` | Yalnız tarihsel migrasyon bağlamı |
| `ava-labs/avalanche-interchain-token-transfer` | `true` | `2024-12-03` | Yalnız tarihsel bağlam |

> **Arşiv depo fingerprint'i güncel semantik sayılmaz.** Bu depolardan alınan bir bytecode/ABI
> eşleşmesi tek başına `supported` yapmaz.

## 2. Kilitlenen kaynak dosyalar

Tümü `github.com/ava-labs/icm-services` @ `8fef6ef73767f4497a72d8348a0774a262e0c535` altında.

### 2.1 ICTT — TokenHome

Yol: `icm-contracts/avalanche/ictt/TokenHome/`

| Dosya | Statü |
|---|---|
| `TokenHome.sol` (soyut taban) | `VERIFIED` (dizin + hedefli okuma) |
| `ERC20TokenHome.sol` | `VERIFIED` (dizin) |
| `ERC20TokenHomeUpgradeable.sol` | `VERIFIED` (dizin) |
| `NativeTokenHome.sol` | `VERIFIED` (dizin) |
| `NativeTokenHomeUpgradeable.sol` | `VERIFIED` (dizin) |

### 2.2 ICTT — TokenRemote

Yol: `icm-contracts/avalanche/ictt/TokenRemote/`

| Dosya | Statü |
|---|---|
| `TokenRemote.sol` (soyut taban) | `VERIFIED` (dizin) |
| `ERC20TokenRemote.sol` | `VERIFIED` (dizin) |
| `ERC20TokenRemoteUpgradeable.sol` | `VERIFIED` (dizin) |
| `NativeTokenRemote.sol` | `VERIFIED` (dizin) |
| `NativeTokenRemoteUpgradeable.sol` | `VERIFIED` (dizin + hedefli okuma) |

Ayrıca: `WrappedNativeToken.sol`, `interfaces/`, `mocks/`, `tests/`.

### 2.3 Messaging

| Yol | İçerik | Destek |
|---|---|---|
| `icm-contracts/avalanche/teleporter/` | `TeleporterMessenger` + `registry/` | **Destekleniyor** (P0) |
| `icm-contracts/avalanche/teleporterV2/` | **Yalnız `WarpAdapter.sol`** | **`UNSUPPORTED -> UNKNOWN`** |

## 3. Audit provenance — denetlenen commit'e bağlı

Upstream `audits/README.md` her audit için **exact commit** veriyor. Kısa SHA'lar Milestone 04'te
tam SHA'ya çözüldü (`VERIFIED`):

| Audit | Denetlenen commit | Depo | Kapsam |
|---|---|---|---|
| Teleporter (OpenZeppelin, 2023-11-16) | `6ba46565a72a7dabb159d74963d7abc525fb6486` | `icm-contracts` (**arşiv**) | `contracts/teleporter/` üst düzey |
| Teleporter Upgradeable (Louis, 2024-01-10) | `9fcdf42da263f3e3d3a60ccf1272d9394eac06d4` | `icm-contracts` (**arşiv**) | `registry` + `utilities`'in bir kısmı |
| ICTT (OpenZeppelin, 2024-06-26) | `9e03a1e5177e4ad8d1edcedf529e71bb2f4a8d99` | `icm-contracts` (**arşiv**) | `contracts/ictt/` (mocks hariç) |
| Validator Manager (OpenZeppelin, 2025-05-07) | — | `icm-contracts` (**arşiv**) | Bu ürünün kapsamı dışında |

> **Pinlediğimiz commit (`8fef6ef7…`) hiçbir audit kapsamında DEĞİLDİR.**
> Denetlenen commit'lerin hepsi arşiv depoda ve farklı yol düzeninde
> (`contracts/ictt/` → `icm-contracts/avalanche/ictt/`). Upstream README'nin kendisi uyarır:
> *"Please exercise caution when using code newer than the audited commit."*
>
> Bu nedenle `auditCoverageFor()` her descriptor için **`audited-at-a-different-commit`**
> döndürür; `covered-at-pinned-commit` iddiası testle engellenmiştir.

> **`teleporterV2` / `WarpAdapter.sol` için audit HİÇ YOKTUR** (`never-audited`).
> Bu, `UNSUPPORTED` kararının birincil gerekçesidir.

## 4. Registry version ≠ source family — kesin ayrım

**Kural:** Teleporter registry'den okunan **protocol version** değeri, `teleporterV2` kaynak
ağacının kullanıldığı anlamına **gelmez**. Bu iki numaralandırma **aynı uzayda değildir**.

- Registry, `TeleporterMessenger` implementasyonlarının **sürümlerini** yönetir.
- `teleporterV2/`, ayrı ve audit dışı bir **kaynak ağacıdır** (yalnız `WarpAdapter.sol`).

**Yasak:** Registry version değerinden ABI family çıkarmak. Bu, fail-open bir hatadır.
ABI family yalnız **bytecode/implementation fingerprint** ile belirlenir.

## 5. Kaynak koddan doğrulanmış semantik

### 5.1 `NativeTokenRemoteUpgradeable.totalNativeAssetSupply()` — `VERIFIED`

```solidity
uint256 burned  = BURNED_TX_FEES_ADDRESS.balance + BURNED_FOR_TRANSFER_ADDRESS.balance;
uint256 created = $._totalMinted + getInitialReserveImbalance();
return created - burned;
```

NatSpec (özet): `IERC20.totalSupply` ile **karıştırılmamalıdır**; `initialReserveBalance`
TokenHome'da **teminatla karşılanmadan önce bile dolaşımdadır**.

**Bağlayıcı sonuç:** Bu değer bir muhasebe yeniden inşasıdır, bağımsız arz ölçümü değildir.
Exact circulating-supply eşitliği olarak **raporlanamaz**.

### 5.2 `TokenHome` remote kaydı ve teminat — `VERIFIED`

- `RemoteTokenTransferrerSettings` = `{ registered, collateralNeeded, tokenMultiplier, multiplyOnRemote }`
- `collateralNeeded = TokenScalingUtils.removeTokenScale(tokenMultiplier, multiplyOnRemote, message.initialReserveImbalance)`;
  `multiplyOnRemote == true` ve tam bölünmüyorsa **+1**
- `_addCollateral`: `collateralNeeded`'ı azaltır, **`_transferredBalances`'ı ARTIRMAZ**

### 5.3 Permissionless kayıt — `VERIFIED`

Resmî ICTT dokümantasyonu: *"Anyone is able to deploy and register remote contracts, which may
have been modified from this repository. It is the responsibility of the users of the home
contract to independently evaluate each remote for its security and correctness."*

## 6. Platform / node semantiği

| Alan | Değer | Statü |
|---|---|---|
| `allow-unfinalized-queries` varsayılanı | `false` → `latest` = kabul edilmiş blok | `VERIFIED` |
| Avalanche finality | Kabul (acceptance) finaldir; confirmation depth kavramı **yok** | `VERIFIED` |
| C-Chain block hash | Node'un verdiği hash esastır; local geth alanlarından **yeniden hesaplanmaz** | Kural (ADR-0002) |
| ACP-194 | Başlık **"Continuous Execution"**, statü `Implementable (Discussion)`, C-Chain `τ = 5s` | `VERIFIED` |
| Helicon aktivasyonu | `avalanchego` master `upgrade/upgrade.go`: **Mainnet ve Fuji için `UnscheduledActivationTime`** | `VERIFIED` |
| En güncel avalanchego release | `v1.14.2` "Granite.2", 2026-03-30; Helicon/ACP-194 **geçmiyor** | `VERIFIED` |
| Son aktive upgrade | Granite — Mainnet 2025-11-19, Fuji 2025-10-29 | `VERIFIED` |

### ACP-194 uyarısı

Aktive olduğunda yaşam döngüsü şuna dönüşür:

```
Proposed -> Accepted -> [değişken gecikme] -> Executed -> [τ] -> Settled
```

ACP metni açıkça: kabul edilmiş blokta okunan state **yürütülmüş state'i yansıtmaz**.
Bu, `ACCEPTED_STATE_ASSURANCE` varsayılanını geçersiz kılar. **Her milestone'da
`upgrade.go` ve release notları yeniden okunmalıdır.**

## 7. SDK sürüm kilidi

| Paket | Latest (2026-08-30) | Yayın | Karar |
|---|---|---|---|
| `@avalanche-sdk/client` | `0.1.2` | — | Opsiyonel keşif katmanı |
| `@avalanche-sdk/interchain` | `0.1.1-alpha.1` | 2025-10-16 | **Canonical hüküm yolunda kullanılmaz** |

**Gerekçe:** `interchain` paketi alpha ve ~10 ay hareketsizdir. Ekonomik hüküm üreten yol
pinlenmiş ABI + genel EVM istemcisi (viem/ethers) üzerinden yürür.

**Kural:** Her SDK/dependency upgrade'i **ADR + test** ister. Exact pin zorunlu; `^`, `~`,
`latest`, `*` yasak.

## 8. Bilinen açık konu

| Ref | Durum | Ayrıntı |
|---|---|---|
| `ava-labs/icm-services#1443` | **AÇIK** | "WarpAdapter allows forged TeleporterV2 messages, enabling remote ICTT token minting". Created `2026-08-13T03:56:03Z`, assignee yok, label yok, PR yok. **Doğrulanmış production vulnerability olarak sunulmaz.** |

## 9. TBD / BLOCKED — bu milestone'da doğrulanamayanlar

Aşağıdakiler **tahmin edilmedi**. Source-lock uygulama milestone'una devredildi.

| ID | Eksik | Neden bu milestone'da yapılamadı |
|---|---|---|
| `T01` | Her sözleşme için **ABI artifact hash** | **ÇÖZÜLDÜ (M04)** — resmî Go binding'lerinden canonical ABI hash'i üretildi |
| `T02` | **Compiler sürümü / build provenance** | **ÇÖZÜLDÜ (M04)** — `foundry.toml`: solc `0.8.30`, `shanghai`, optimizer 200, `bytecode_hash="none"`; submodule pinleri kayıtlı |
| `T03` | **Supported bytecode fingerprint** kümesi | **KISMEN (M04)** — *creation* bytecode hash'i üretildi; **runtime** hash türetilemez (constructor + immutable), operatör attestation'ına bağlandı |
| `T04` | `reportBurnedTxFees` ↔ `BURNED_TX_FEES_ADDRESS.balance` ilişkisi | **ÇÖZÜLDÜ (M04)** — ayrı kanal; delta alınır, ödül **yeniden mint edilir** (`_totalMinted` artar), kalan home'a bildirilir |
| `T05` | `teleporterV2` / `WarpAdapter`'ın herhangi bir canlı ağda deploy edilip edilmediği | Doğrulanamadı → `UNKNOWN` |
| `T06` | Helicon'un Fuji'de aktive olup olmadığı | Resmî kaynak `unscheduled` diyor; ikincil bloglar 2026-07-28 iddia ediyor → **ÇELİŞKİLİ** |
| `T07` | Teleporter registry version ↔ implementation fingerprint eşleme tablosu | Registry state okuması gerekir; **çıkarım yapılmayacak** |
| `T08` | ICTT event/getter yüzeyinin sürüm bazlı tam envanteri | Her `.sol` dosyasının tam okunması gerekir |

## 9.1 Milestone 04'te doğrulanan semantik

| Bulgu | Kanıt (pinned kaynak) |
|---|---|
| Canonical **ERC20 remote'un initial reserve imbalance'ı yapısal olarak 0** | `__ERC20TokenRemote_init` → `__TokenRemote_init(settings, 0, tokenDecimals)` |
| ERC20 remote doğuştan `isCollateralized` | `_isCollateralized = initialReserveImbalance_ == 0` |
| **Native remote sıfır reserve'i reddeder**, decimals 18 sabit | `require(initialReserveImbalance != 0, ...)`; `__TokenRemote_init(settings, imbalance, 18)` |
| `_addCollateral` `transferredBalance`'a **dokunmaz** | Fonksiyon gövdesinde `_transferredBalances` 0 kez |
| `collateralNeeded` +1 yuvarlaması | `if (multiplyOnRemote && imbalance % tokenMultiplier != 0) collateralNeeded += 1` |
| `remoteTokenDecimals <= 18` zorunlu | `_registerRemote` require |

**Bağlayıcı sonuç:** Canonical ERC20 rotasında `C_r` **yapısal olarak sıfırdır**, dolayısıyla
`A_r = T_r`. Bu rotaya keyfi bir initial-collateral terimi eklenmez.

### `A03` yerine kesin ifade — native üst sınırı

`totalNativeAssetSupply()` bir üst sınırdır **ancak ve ancak minter münhasırlığı sağlanmışsa**.
Bilinen iki burn adresi dışına gönderilen coin düşülmez (sınır bu yönde korunur), fakat bu
sözleşme tek minter değilse gerçek arz raporlanan değeri aşabilir ve **sınır düşer**.
Doğrudan `CFG-006`'ya bağlıdır.

## 10. Yenileme protokolü

Bu dosya şu durumlarda **yeniden gözden geçirilir ve `reviewedAt` güncellenir**:

1. Her milestone başlangıcında (ACP-194/Helicon kontrolü zorunlu)
2. Yeni bir sözleşme sürümü veya fingerprint eklendiğinde
3. Bir SDK/dependency upgrade ADR'si açıldığında
4. `#1443` durumu değiştiğinde
5. `icm-services` deposu arşivlenir veya taşınırsa

**Pinned SHA değiştirilmeden** yeni semantik iddia edilemez.
