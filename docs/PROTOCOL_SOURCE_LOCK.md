# Protokol Kaynak Kilidi

**Tarih kesimi:** 2026-08-30 · **reviewedAt:** 2026-08-30

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

## 3. Audit provenance

`icm-contracts/audits/` içeriği (`VERIFIED`):

| Audit | Tarih | Denetçi | Kapsam |
|---|---|---|---|
| ICTT Audit | 2024-06-26 | OpenZeppelin | ICTT |
| Teleporter Audit | 2023-11-16 | OpenZeppelin | Teleporter |
| Teleporter Upgradeable Audit | 2024-01-10 | Louis | Teleporter upgradeable |
| Validator Manager Incremental Audit | 2025-05-07 | OpenZeppelin | Validator manager |

> **`teleporterV2` / `WarpAdapter.sol` için audit YOKTUR.** Bu, `UNSUPPORTED` kararının
> birincil gerekçesidir.

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
| `T01` | Her sözleşme için **ABI artifact hash** | Yerel build gerekir; dependency kurmak bu milestone'da kapsam dışı |
| `T02` | **Compiler sürümü / build provenance** (solc version, optimizer, metadata) | `foundry.toml` okunmadı; reproducible build milestone'una ait |
| `T03` | **Supported bytecode fingerprint** kümesi | Derleme ve deployed-bytecode çıkarımı gerekir |
| `T04` | `reportBurnedTxFees` mekanizması ile `BURNED_TX_FEES_ADDRESS.balance` arasındaki tam ilişki | Hedefli kaynak okuması gerekiyor; formül tahminle kapatılmayacak (`C02`) |
| `T05` | `teleporterV2` / `WarpAdapter`'ın herhangi bir canlı ağda deploy edilip edilmediği | Doğrulanamadı → `UNKNOWN` |
| `T06` | Helicon'un Fuji'de aktive olup olmadığı | Resmî kaynak `unscheduled` diyor; ikincil bloglar 2026-07-28 iddia ediyor → **ÇELİŞKİLİ** |
| `T07` | Teleporter registry version ↔ implementation fingerprint eşleme tablosu | Registry state okuması gerekir; **çıkarım yapılmayacak** |
| `T08` | ICTT event/getter yüzeyinin sürüm bazlı tam envanteri | Her `.sol` dosyasının tam okunması gerekir |

## 10. Yenileme protokolü

Bu dosya şu durumlarda **yeniden gözden geçirilir ve `reviewedAt` güncellenir**:

1. Her milestone başlangıcında (ACP-194/Helicon kontrolü zorunlu)
2. Yeni bir sözleşme sürümü veya fingerprint eklendiğinde
3. Bir SDK/dependency upgrade ADR'si açıldığında
4. `#1443` durumu değiştiğinde
5. `icm-services` deposu arşivlenir veya taşınırsa

**Pinned SHA değiştirilmeden** yeni semantik iddia edilemez.
