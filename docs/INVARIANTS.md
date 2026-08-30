# Invariant'lar ve Kanıt Modeli

**Tarih kesimi:** 2026-08-30

---

## 1. Kanıt sınıfları

Dört sınıf **ayrı alarm etiketi ve ayrı kullanıcı dili** kullanır.

| Sınıf | Soru | Örnek | Hüküm gücü |
|---|---|---|---|
| **Coverage / solvency** | Yükümlülüğün karşılığı var mı? | Home escrow ≥ remote yükümlülük | Kanıt **veya sınır** |
| **Correctness** | Akışlar protokole göre uzlaşıyor mu? | Mint için home accounting var mı? | Deterministik |
| **Liveness** | Mesaj makul sürede ilerliyor mu? | Delivered fakat execution failed | Zaman eşiği |
| **Heuristic risk** | Olağandışı davranış var mı? | Hacim patlaması, RPC ayrışması | **Yalnız sinyal** |

> **Rate anomaly hiçbir zaman `undercollateralized` başlığıyla gösterilmez.**
> Bir oranı ölçebilmek, ekonomik teminatı kanıtlamakla aynı şey değildir.

## 2. Verdict lattice

```
CRITICAL  >  required UNKNOWN  >  WARN  >  OK
```

| Verdict | Anlamı |
|---|---|
| `OK` | Gerekli kanıt **ve** tazelik mevcut |
| `WARN` | Policy / liveness / heuristic sapma — **ekonomik ihlal kanıtı değil** |
| `CRITICAL` | Deterministik config / accounting / message ihlali, güçlü kanıtla |
| `UNKNOWN` | Kanıt üretilemedi veya semantik tanınmıyor |

**`UNKNOWN` asla `OK`, `healthy` veya yeşil olarak map edilmez.** Zorunlu (required) bir kontrol
UNKNOWN ise deployment'ın genel hükmü `WARN`'ın üstündedir — sessizce yutulamaz.

## 3. Alarm sözleşmesi

Her evaluation en az şu alanları taşır:

```
rule_id, rule_version, severity, proof_class
deployment_id, home_chain, remote_chain
observed_at, block_numbers, block_hashes
expected, observed, delta, unit
evidence_refs, rpc_witnesses, data_freshness
assumptions, exclusions, recommended_runbook
first_seen, last_seen, dedup_key, status
```

Her kontrolde **gözlenen ve beklenen değer; block number/hash; RPC witness sayısı;
fingerprint source; policy sürümü** kanıta eklenir.

---

## 4. P0 kural kataloğu

### 4.1 Yapılandırma (`CFG-*`)

| ID | Kural | Mod | Kanıt | Severity |
|---|---|---|---|---|
| `CFG-001` | Home/remote karşılıklı adres ve `blockchainID` eşleşmesi | Tümü | State + manifest | Critical |
| `CFG-002` | Bytecode / proxy implementation fingerprint | Tümü | Code hash | Critical / Unknown |
| `CFG-003` | Teleporter registry/messenger minimum sürümü | Tümü | State + policy | Critical |
| `CFG-004` | Decimals / multiplier / rounding profili | Tümü | State + adapter | Critical |
| `CFG-005` | `collateralNeeded == 0` | Tümü | State | Critical |
| `CFG-006` | Native minter allowlist / münhasırlık | Native | Genesis + state | Critical / Unknown |

Ek yapılandırma değişmezleri:
- Remote'un `home blockchainID` / `home address` değerleri beklenen home'u gösterir
- TokenHome remote kaydı beklenen `blockchainID` / transferrer ile eşleşir
- Admin / upgrade authority beklenen multisig/policy adresidir
- Yetkili origin / application sender beklenen sözleşme yoludur

> **`blockchainID` (Avalanche ICM kimliği) ile EVM `chainId` ayrı alanlardır ve aynı değer
> değildir.** Bunları karıştırmak `CFG-001`'i sessizce fail-open yapar.

### 4.2 Muhasebe (`ACC-*`)

| ID | Kural | Mod | Kanıt | Severity |
|---|---|---|---|---|
| `ACC-001` | ERC20 `S_r <= A_r`, causal snapshot | ERC20 | Multi-chain state | Critical |
| `ACC-002` | Sakin kesitte ERC20 eşitliği / dust | ERC20 | State + ledger | Warn / Critical |
| `ACC-003` | Home physical escrow coverage | ERC20 locking | balance + ledger | Critical |
| `ACC-004` | Native reported upper bound covered | Native | State + adapter | Pass / Indeterminate |

### 4.3 Mesaj (`MSG-*`)

| ID | Kural | Mod | Kanıt | Severity |
|---|---|---|---|---|
| `MSG-001` | Mint/release için benzersiz **authorized source** | Tümü | Logs + state | Critical |
| `MSG-002` | Delivery ayrı, app execution ayrı | Tümü | Teleporter events/state | Warn / Critical |
| `MSG-003` | Failed execution retry durumu | Tümü | Events | Warn |
| `MSG-004` | Duplicate ekonomik etki yok | Tümü | Ledger | Critical |

### 4.4 Veri güvenilirliği (`DAT-*`) ve risk (`RSK-*`)

| ID | Kural | Mod | Kanıt | Severity |
|---|---|---|---|---|
| `DAT-001` | RPC witness ve pinned block anlaşması | Tümü | RPC quorum | Unknown |
| `DAT-002` | Replay gap / staleness yok | Tümü | Checkpoint + head | Unknown |
| `RSK-001` | Hacim / rate anomaly | Tümü | Time series | Warn |

> **Yürütme sırası:** `CFG-*` ve `MSG-001` (yetkilendirme), `ACC-*`'ten **önce** gelir.
> Permissionless kayıt gerçeği ve authorization sınıfı riskler (issue #1443) bunu zorunlu kılar.

---

## 5. Canonical ERC20 remote muhasebesi

Rota `r` için:

```
T_r = TokenHome transferred balance   (remote en küçük biriminde)
C_r = gerçekten kabul edilmiş ilk teminatın aynı birimdeki değeri
A_r = T_r + C_r,  sürüm adapter'ı çift sayımı dışladıktan SONRA
S_r = canonical ERC20TokenRemote.totalSupply()
```

**Güvenlik kontrolü:** `S_r <= A_r`

Standart `ERC20TokenRemote`'da ilk teminat çoğunlukla sıfırdır; tüm mesajlar tamamlandığında
`S_r == A_r` beklenebilir. **Fakat aynı `latest` anlarını kıyaslamak hatalıdır.** Zincir başına
block number/hash sabitlenmiş, finality policy uygulanmış ve mesaj nedenselliği eşleştirilmiş olmalıdır.

Canlı sistemde:

```
expected_remote_supply_at_watermark
  = last_reconciled_supply
  + executed_home_to_remote_mints
  - executed_remote_to_home_burns

home_liability_envelope
  = remote_supply
  + home_to_remote_in_flight
  - modeled_remote_to_home_in_flight
  + known_rounding_dust
```

**Yorum kuralları:**
- `A_r - S_r > 0` **tek başına açık değildir**: uçuşta mesaj, destination execution hatası veya
  bekleyen mint olabilir.
- Kesinleşmiş ve nedensel olarak uzlaşmış durumda `S_r > A_r`: **kritik ihlal** veya yanlış
  ABI/sürüm/rota göstergesi.
- Log boşluğu veya karşılaştırılamayan watermark varsa sonuç **`UNKNOWN`**.

> Formül, sözleşme sürümüne ait integer yuvarlama ve olay sırasıyla **property test edilmelidir**.
> Kesin olmayan bu formül bir kod kararı değildir; hangi event/getter'ın hangi sürümde ne anlama
> geldiği `docs/PROTOCOL_SOURCE_LOCK.md` ile bağlanır.

### 5.1 İlk teminatın özel anlamı — kaynak koddan doğrulanmış

`TokenHome.sol` @ pinned SHA:

- `RemoteTokenTransferrerSettings` = `{ registered, collateralNeeded, tokenMultiplier, multiplyOnRemote }`
- Kayıtta:
  `collateralNeeded = TokenScalingUtils.removeTokenScale(tokenMultiplier, multiplyOnRemote, message.initialReserveImbalance)`;
  `multiplyOnRemote == true` ve tam bölünmüyorsa **+1** yuvarlanır.
- `_addCollateral`: `_deposit` yapar, **`collateralNeeded`'ı azaltır**, fazlasını iade eder —
  **`_transferredBalances`'ı ARTIRMAZ.**

**Sonuç:** Home bakiyesini yalnız `sum(transferredBalance)` ile karşılaştırmak ilk teminatı
açıklayamaz. **Nöbetçi collateral olaylarını ayrı defterde tutar.** Bir sürüm teminatı transferred
balance içine kredilerse `T + C` **çift sayım yapılmamalıdır** — bu, adapter'ın sorumluluğudur.

## 6. Home escrow yeterliliği — ikinci tanık

Muhasebeden **bağımsız** fiziksel kasa kontrolü:

```
observed_home_token_balance(TokenHome)
  >= remote yükümlülüklerin home birimine dönüşmüş toplamı
   + gerçekten kabul edilmiş initial collateral
   + bilinen bekleyen yükümlülükler
   - açıkça modellenmiş releases
```

Bu, `transferredBalance` kontrolünün **alternatifi değil ikinci tanığıdır**.

Rebase, fee-on-transfer, blacklist, share/accounting token veya özel wrapper varsa **canonical kural
devre dışı kalmalı** veya adapter kullanılmalıdır. `balanceOf` görmek hukuki tahsil edilebilirlik
değil, yalnız onchain coverage kanıtıdır.

## 7. Native remote — konservatif model

Native remote'da **gerçek arz `N_r` doğrudan bilinmez.**

Sözleşmenin raporladığı değer (`NativeTokenRemoteUpgradeable.totalNativeAssetSupply()`,
kaynak koddan doğrulanmış):

```solidity
burned  = BURNED_TX_FEES_ADDRESS.balance + BURNED_FOR_TRANSFER_ADDRESS.balance;
created = _totalMinted + getInitialReserveImbalance();
U_r     = created - burned;
```

Sözleşmenin kendi NatSpec'i, `initialReserveBalance`'ın **TokenHome'da teminatla karşılanmadan
önce bile dolaşımda olduğunu** ve bu getter'ın `IERC20.totalSupply` ile karıştırılmaması
gerektiğini yazar.

**Hüküm kuralları:**

| Durum | Sonuç |
|---|---|
| `U_r <= A_r` | **`sufficient`** — yeterlilik için güçlü kontrol |
| `U_r > A_r` | **`INDETERMINATE` / reconciliation required** — tek başına yetersiz teminat kanıtı **değildir**; bilinmeyen fee burn gerçek arzı düşürmüş olabilir |
| Kırmızı hüküm | Ancak **güvenilir bir arz alt sınırı da** `A_r`'yi aşarsa |
| Fingerprint/sürüm tanınmıyor | **`UNKNOWN`** |

Ayrıca kontrol edilir: initial reserve collateral, minter allowlist/münhasırlığı, kalan
`collateralNeeded`.

> **Ekran dili:** "kesin arz eşitliği" **değil**; "home coverage, reported supply upper bound ve
> minter integrity". `NativeTokenRemote` arzı **hiçbir yerde exact circulating-supply eşitliği
> olarak raporlanmaz.**
>
> **Açık sınır:** `U_r`'nin *kesin bir üst sınır* olduğu, arzı azaltan tüm yolların bu iki burn
> adresince yakalanmasına bağlıdır ve bu **doğrulanmamıştır** (`RESEARCH_SYNTHESIS.md` A03).
> Bu varsayım yanlışlanırsa native hükmü `indeterminate`'e sabitlenir.

## 8. Mesaj invariant'ları

- Her home accounting artışı için **benzersiz** outbound intent/message vardır
- Her remote mint/release **beklenen source/home transferrer** ve benzersiz message ID ile eşleşir
- Aynı message ID **ikinci kez ekonomik etki doğurmaz**
- `ReceiveCrossChainMessage` ile `MessageExecuted` **ayrı** izlenir
- `MessageExecutionFailed` healthy kapanmaz; retry ve nihai execution eşleşir
- Remote-to-remote multi-hop **home üzerinden** geçtiği için doğrudan transfer gibi modellenmez
- Receipt gecikmesi accounting proof'u bozmayabilir; fakat **liveness alarmı** üretir

## 9. Veri güvenilirliği invariant'ları

- En az **iki bağımsız RPC witness** block hash / state / log aralığında anlaşır
  (bağımsızlık = ayrı providerGroup, ayrı URL değil)
- Her zincir için **finality policy ve reorg buffer** tanımlıdır
- İşlenen blok head'den eşikten fazla gerideyse **`STALE`**
- **Webhook olayı, RPC replay ile doğrulanmadan kesin hükme dönüşmez**
- RPC eksik / limitli / çelişkiliyse **`UNKNOWN` + veri yolu alarmı**
- İndeksleyici veya Metrics özeti core ledger'ın tek kaynağı **değildir**

> Çoklu RPC quorum'u **kriptografik proof veya Byzantine güvence diye pazarlanmaz.**
> Sağlayıcılar ortak upstream kullanabilir.

## 10. Finality duruşu

- Avalanche'ta **kabul (acceptance) finaldir.** C-Chain `allow-unfinalized-queries` varsayılanı
  `false`'tur ve `latest` kabul edilmiş bloğu döndürür.
- **Ethereum tarzı confirmation depth (örn. `confirmations: 12`) Avalanche finality kanıtı olarak
  kullanılmaz.** Finality policy adlandırılmış semantikle ifade edilir.
- C-Chain block hash'i local geth alanlarından **yeniden hesaplanmaz**; node'un verdiği hash esastır.
- **ACP-194 tetikleyicisi:** "Continuous Execution" aktive olursa `Accepted -> Executed -> Settled`
  ayrışır ve kabul edilmiş blokta okunan state yürütülmüş state'i yansıtmaz. O noktada truth anchor
  `settled` bloğa taşınmak zorundadır. Bkz. `docs/adr/0002-accepted-quorum-truth.md`.
