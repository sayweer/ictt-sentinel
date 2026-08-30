# Destek Matrisi

**Tarih kesimi:** 2026-08-30 · **Durum:** hiçbir şey implemented değil (kod yazılmadı)

Bu matris **dürüstlük belgesidir**. Bir satırın `Planned` olması, çalıştığı anlamına gelmez.
Statü sözlüğü:

| Statü | Anlamı |
|---|---|
| `IMPLEMENTED` | Kod var, test var, fixture geçiyor |
| `PLANNED-P0` | MVP kapsamında, henüz kod yok |
| `PLANNED-P1` | Traction sonrası (12-24 hafta) |
| `UNSUPPORTED` | Bilinçli olarak desteklenmiyor → `UNKNOWN` üretir |

**Milestone 00 itibarıyla `IMPLEMENTED` satır sayısı: 0.**

---

## 1. Token / sözleşme türü

| Tür | Statü | Hüküm | Not |
|---|---|---|---|
| Canonical `ERC20TokenRemote`, tanınmış sürüm | `PLANNED-P0` | Deterministik reconciliation + coverage | Ana wedge |
| `ERC20TokenRemoteUpgradeable`, tanınmış impl | `PLANNED-P0` | Aynı + implementation fingerprint zorunlu | Proxy drift `CFG-002` |
| `NativeTokenRemote` / `NativeTokenRemoteUpgradeable`, tanınmış sürüm | `PLANNED-P0` (sınırlı) | **Yalnız** `sufficient` / `indeterminate` / `unknown` | Exact supply iddiası **yasak** |
| Multi-hop remote-to-remote | `PLANNED-P1` (sınırlı) | Home üzerinden causal message takibi | Doğrudan transfer gibi modellenmez |
| Send-and-call payload'lı transfer | `PLANNED-P1` | Delivery/execution ayrımı zorunlu | App execution semantiği ayrı |
| Custom ERC20 remote | `UNSUPPORTED` (adapter gerekir) | **Default `UNKNOWN`** | Ayrı semantik profil attestation'ı ister |
| Rebase token | `UNSUPPORTED` | `UNSUPPORTED -> UNKNOWN` | Canonical kural devre dışı |
| Fee-on-transfer token | `UNSUPPORTED` | `UNSUPPORTED -> UNKNOWN` | Canonical kural devre dışı |
| Blacklist / pausable wrapper | `UNSUPPORTED` | `UNSUPPORTED -> UNKNOWN` | Coverage anlamı değişir |
| Tanınmayan fork / proxy implementation | `UNSUPPORTED` | **`UNKNOWN`, fail-closed** | Sessiz OK **asla** |

## 2. Messaging katmanı

| Aile | Statü | Hüküm | Gerekçe |
|---|---|---|---|
| `teleporter/` — `TeleporterMessenger` + registry, audit kapsamında | `PLANNED-P0` | Desteklenir | OpenZeppelin audit 2023-11-16 + upgradeable audit 2024-01-10 |
| `teleporterV2/` — yalnız `WarpAdapter.sol` | **`UNSUPPORTED`** | **`UNSUPPORTED -> UNKNOWN`** | Ayrı source tree; **resmî audit YOK**; issue #1443 açık |

> **Kritik kural:** Teleporter registry protocol version ile `teleporterV2` source family
> **aynı şey değildir**. Registry'den okunan version değerinden ABI family **çıkarılmaz**.
> Bu iki numaralandırma aynı uzayda değildir; eşitlemek fail-open hatasıdır.

## 3. Zincir ve deployment ortamı

| Ortam | Statü | Not |
|---|---|---|
| Local (Fuji/devnet) iki L1 + home/remote | `PLANNED-P0` | Fixture ve replay corpus ortamı |
| Fuji testnet | `PLANNED-P0` | Shadow replay |
| Mainnet C-Chain + L1 | `PLANNED-P1` | Production hardening gerekir |
| Private L1 | `PLANNED-P0` (local agent ile) | Ham veri dışarı çıkmadan evidence metadata |
| Özel genesis / precompile fork | `UNSUPPORTED` | Genesis fingerprint tanınmazsa `UNKNOWN` |

## 4. Veri yolu

| Yetenek | Statü | Hüküm gücü |
|---|---|---|
| Multi-RPC pinned-block state call | `PLANNED-P0` | **Canonical** |
| Finalized log replay + checkpoint | `PLANNED-P0` | **Canonical** |
| Reorg-aware append-only ledger | `PLANNED-P0` | Canonical |
| Archive RPC fallback (gap recovery) | `PLANNED-P0` | Canonical |
| Webhook hız yolu | `PLANNED-P0` | **Hiçbiri** — yalnız tetik |
| Metrics API | `PLANNED-P1` | Operasyon bağlamı; **teminat kanıtı değil** |
| Data API | `PLANNED-P1` | Yalnız keşif/metadata |
| P-Chain / validator görünümü | `PLANNED-P1` | Quorum bağlamı; ekonomik invariant'tan ayrı |

## 5. Assurance kapsamı

| Yetenek | Statü | Not |
|---|---|---|
| `ACCEPTED_STATE_ASSURANCE` (V0 varsayılanı) | `PLANNED-P0` | Provider quorum ile kabul edilmiş durum |
| `INDEPENDENT_ICM_VERIFICATION` | **`UNSUPPORTED`** | BLS aggregate signature / predicate'i tarihsel P-Chain validator setine karşı bağımsız doğrulama **iddia edilmez**. Ayrı, source-locked gate. Bkz. ADR-0004 |

## 6. Çıktı ve entegrasyon

| Yetenek | Statü |
|---|---|
| JSON evidence bundle | `PLANNED-P0` |
| HTML evidence export | `PLANNED-P0` |
| PDF audit export | `PLANNED-P1` |
| Slack + generic webhook | `PLANNED-P0` |
| PagerDuty / SIEM | `PLANNED-P1` |
| Hexagate / OZ Monitor / Forta policy adapter | `PLANNED-P1` |
| Docker Compose local agent | `PLANNED-P0` |
| Hosted multi-tenant evidence plane | `PLANNED-P1` |

## 7. Kalıcı olarak kapsam dışı

Bunlar "henüz yok" değil, **bilinçli olarak asla yok**:

- Auto-pause, otomatik devre kesici
- Retry transaction gönderimi
- Signing / custody / wallet
- Yeni bridge veya messaging protokolü
- Mutlak solvency / güvenlik sertifikası
- Public generic `request(method, params)` RPC yüzeyi
- Tüketici cüzdanında yeşil rozet

## 8. Fail-closed sözü

Bu matriste `UNSUPPORTED` olan her şey, karşılaşıldığında **sessizce atlanmaz veya OK
sayılmaz** — `UNKNOWN` üretir ve deployment'ın genel hükmünü yeşil olmaktan çıkarır.

Desteklenmeyen bir şeyi desteklenir göstermek, bu üründe **en ağır hata sınıfıdır**:
ürünün tek satacağı şey, yanlış kesinlik üretmemesidir.
